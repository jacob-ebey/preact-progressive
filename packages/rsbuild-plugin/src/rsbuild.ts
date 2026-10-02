import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as posix from "node:path/posix";

import { transformSync } from "@babel/core";
import { createRequestListener } from "@remix-run/node-fetch-server";
import type { RsbuildPlugin } from "@rsbuild/core";
import type { Compilation, Compiler } from "@rspack/core";

import babelClientPlugin from "babel-plugin-preact-progressive/client";
import babelServerPlugin from "babel-plugin-preact-progressive/server";
import type { IncomingMessage, ServerResponse } from "node:http";

type ClientStats = {
  publicPath?: string;
  entrypoints: Record<string, { assets: { name: string }[] }>;
  assetsByChunkName?: Record<string, string[]>;
};

type PluginState = {
  clientManifest?: ClientStats;
  clientModules: Map<string, string>;
  filesToUpdate: Set<string>;
  /** Normalized client module path -> client environment entry name. */
  clientEntries: Map<string, string>;
  /** `?assets=client` token hash -> client environment entry name. */
  assetsModules: Map<string, string>;
};

/** Virtual module exporting a server-side `loadModule` for the `Decoder`. */
export const VIRTUAL_SERVER_LOAD_MODULE = "virtual:server-load-module";

/**
 * Static `virtual:server-load-module` source.
 *
 * The server transform registers every client reference's implementation on
 * `globalThis.__pp_server_modules` under its `$mod`/`$name` when the
 * defining module evaluates, so the loader needs no per-project enumeration
 * and no dynamic access on bundled namespaces (whose export names minifiers
 * may mangle). Unknown ids fall back to a dynamic `import()`.
 */
function generateServerLoadModule(): string {
  const lines = [
    "const __pp_cache = Object.create(null);",
    "export function loadModule(mod, name) {",
    "  const ns = globalThis.__pp_server_modules?.[mod];",
    "  if (ns && name in ns) return ns[name];",
    "  const cached = __pp_cache[mod];",
    "  if (cached) {",
    "    if (cached instanceof Promise) return cached.then((m) => m && m[name]);",
    "    return cached[name];",
    "  }",
    "  const p = import(mod).then(",
    "    (m) => {",
    "      __pp_cache[mod] = m;",
    "      return m;",
    "    },",
    "    () => undefined,",
    "  );",
    "  __pp_cache[mod] = p;",
    "  return p.then((m) => m && m[name]);",
    "}",
    "",
  ];
  return lines.join("\n");
}

export type Options = {
  /**
   * Client chunk format.
   *
   * - `"jsonp"` (default) emits classic JSONP chunks loaded by
   *   `rsbuild-plugin-preact-progressive/client`. It shares one runtime and
   *   module cache across the on-demand modules, so it works the same in dev
   *   and production and does not require native ESM support.
   * - `"esm"` keeps rsbuild's ESM output and relies on the native dynamic
   *   `import()` loader. Use it when the client can assume ESM.
   *
   * @default "jsonp"
   */
  format?: "jsonp" | "esm";
  environments?: {
    /**
     * Client environment name.
     *
     * @default "client"
     */
    client?: string;
    /**
     * Server environment names.
     *
     * @default ["ssr"]
     */
    server?: string[];
  };
  /**
   * Wires dev-time SSR. Under `rsbuild dev`, the named server environment's
   * `index` bundle serves requests through its default `fetch` export. Pass
   * `false` to disable the built-in serving.
   */
  serveEnvironment?: false | string;
};

/**
 * Build wiring for `"use client"` boundaries on Rsbuild/Rspack. It shares
 * the wire format and reference model of the Vite plugin, adapted to a
 * different toolchain.
 *
 * How the plugin converts `"use client"` source into deployable chunks. Each
 * environment transforms its own way, with the client stripping directives
 * and the server rewriting references. The server transform discovers client
 * modules and the client compile emits them as on-demand chunks. A final
 * pass patches server output placeholders with real chunk URLs. Files
 * containing the text `use client` transform per environment, and the rest
 * passes through.
 *
 * #### Placeholders
 *
 * Production server transforms cannot know chunk URLs, since the client
 * compiles after the server. References carry content-hashed placeholders
 * instead, derived from the module path relative to project root:
 *
 * - `__PP_MOD__<sha256>` for the module chunk URL.
 * - `__PP_DEPS__<hash>` for the chunk dependencies to preload (`$deps`).
 *
 * A third token covers `?assets=client` imports under the
 * vite-plugin-fullstack `?assets` contract.
 * `import assets from "./entry.client.ts?assets=client"` resolves to
 * `{ entry, js, css }` chunk URLs. In builds it emits
 * `__PP_ASSETS__<hash>`, keyed by the client entry the import targets.
 * Imports pointing elsewhere throw.
 *
 * Dev skips placeholders. Module URLs fall back to hashed dev URLs, with
 * deps staying empty.
 *
 * #### Client emission
 *
 * Discovered modules join the client compilation as async entries. The
 * chunks are standalone, carry the module hash as name, and stay out of
 * initial page assets. Entries join at `finishMake` rather than `make`,
 * since earlier injection can run before the module executor event channel
 * exists, where entries importing CSS panic. The pass also records candidate
 * server output files through `processAssets` at the `additional` stage over
 * server `.js` files.
 *
 * By default the client environment compiles to classic JSONP output in
 * both dev and production (`output.module` and the `modern-module` library
 * type are disabled) with a single shared runtime, and each discovered
 * module is exposed as `window.__pp__<hash>`. One runtime keeps shared
 * modules — most importantly `preact` itself — singletons across every
 * on-demand chunk, and does not require native ESM support.
 * `rsbuild-plugin-preact-progressive/client` supplies the matching loader
 * and `rsbuild-plugin-preact-progressive/server` the `__pm` runtime shim.
 * Pass `format: "esm"` to keep rsbuild's ESM output and native `import()`
 * loading instead.
 *
 * #### Rewrite pass
 *
 * All environments compile first, then the plugin rewrites recorded server
 * output files in place. `MOD` tokens become the quoted chunk URL; the client
 * loader derives the module hash from the chunk filename to find the
 * `window.__pp__<hash>` export. `DEPS` tokens become the quoted dependency array, replacing the whole surrounding array literal so the
 * list stays flat. `__PP_ASSETS__` tokens become the entry
 * `{ entry, js, css, module }` object. The first unresolvable token fails the
 * build. Unknown module hashes and missing entry chunks throw, as with the
 * Vite plugin.
 *
 * #### `?assets=client` imports
 *
 * The plugin honors `?assets=client` imports following the
 * vite-plugin-fullstack `?assets` contract:
 *
 * ```ts
 * import clientAssets from "./entry.client.ts?assets=client";
 * // { entry: string; js: { href: string }[]; css: { href: string }[] }
 * ```
 *
 * The import must point at a client-environment entry, and anything else
 * throws. Dev resolves to the served entry chunk URL, plus a stylesheet URL
 * when the entry imports CSS. Builds emit a placeholder that the
 * post-compile rewrite resolves from client stats. Stylesheets resolve from
 * entrypoint assets in client stats for `css`, falling back to a
 * conventional `/static/css/<entry>.css` URL in dev when the entry imports
 * a stylesheet.
 *
 * #### Server-side decoding (`virtual:server-load-module`)
 *
 * The encoder only carries enough information to load client references in
 * browser builds. To run the decoder on the server — prerendering an island
 * to HTML and its payload in a single pass, or round-tripping richer
 * information for server actions — import `virtual:server-load-module` from
 * a server environment. It exports a `loadModule` implementation for the
 * decoder which maps each encoded client module id to its server equivalent
 * and loads it. The server transform registers every reference's
 * implementation on `globalThis.__pp_server_modules` at evaluation time, so
 * `decode()` hands out the real implementation synchronously without
 * suspending and without relying on bundled export names. Available in
 * server environments only.
 */
export default function preactProgressive(options?: Options): RsbuildPlugin {
  const clientEnvironment = options?.environments?.client || "client";
  const serverEnvironments = new Set(options?.environments?.server ?? ["ssr"]);
  const state: PluginState = {
    clientModules: new Map(),
    filesToUpdate: new Set(),
    clientEntries: new Map(),
    assetsModules: new Map(),
  };
  const serveEnvironment = options?.serveEnvironment ?? "ssr";
  const jsonp = (options?.format ?? "jsonp") === "jsonp";

  type SSRMiddleware = (
    req: IncomingMessage & { originalUrl?: string },
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => Promise<void>;

  return {
    name: "preact-progressive",
    setup(api) {
      // Virtual module mapping encoded client ids to their server equivalents.
      // Backed by a generated static file so no Rspack runtime import is
      // needed; implementations register themselves on
      // `globalThis.__pp_server_modules` at evaluation time (see the babel
      // server transform), so the file content never depends on discovery
      // order.
      const virtualPath = path.join(
        api.context.rootPath,
        "node_modules/.cache/preact-progressive-server-load-module.js",
      );
      fs.mkdirSync(path.dirname(virtualPath), { recursive: true });
      fs.writeFileSync(virtualPath, generateServerLoadModule(), "utf-8");
      api.modifyRsbuildConfig((rsbuildConfig, { mergeRsbuildConfig }) => {
        return mergeRsbuildConfig(
          {
            output: {
              module: true,
            },
            environments: {
              [clientEnvironment]: {
                ...(jsonp ? { output: { module: false } } : {}),
                tools: {
                  rspack: {
                    dependencies: Array.from(serverEnvironments),
                    output: jsonp
                      ? { library: { type: "window", name: "__pp__[name]" } }
                      : { library: { type: "modern-module" } },
                    ...(jsonp
                      ? { optimization: { runtimeChunk: "single" as const } }
                      : { optimization: { usedExports: false } }),
                  },
                },
              },
            },
            server: {
              compress: false,
              htmlFallback: false,
              setup(context) {
                if (
                  serveEnvironment &&
                  api.context.action === "dev" &&
                  "environments" in context.server
                ) {
                  const env = context.server.environments[serveEnvironment as string];

                  const handleSSR: SSRMiddleware = async (req, res, next) => {
                    const entry = await env.loadBundle<{
                      default: { fetch(request: Request): Promise<Response> };
                    }>("index");

                    try {
                      req.url = req.originalUrl;
                      // With `html: false` rsbuild does not inject the entry's
                      // initial split chunks. Under ESM the entry imports them
                      // itself; under JSONP the entry waits on the runtime to
                      // load them, which dev does not ship. Preload them here
                      // so the JSONP entry can start.
                      createRequestListener(async (request) => {
                        const response = await entry.default.fetch(request);
                        const type = response.headers.get("content-type") ?? "";
                        if (!jsonp || !type.includes("text/html")) return response;
                        const html = injectInitialChunks(
                          await response.text(),
                          state.clientManifest,
                        );
                        return new Response(html, {
                          status: response.status,
                          headers: response.headers,
                        });
                      })(req, res);
                    } catch (cause) {
                      next(cause);
                    }
                  };

                  return () => {
                    context.server.middlewares.use(handleSSR);
                  };
                }
              },
            },
          },
          rsbuildConfig,
        );
      });

      // Map each client environment entry's module to its entry name, so a
      // `?assets=client` import of a client module can resolve to the chunk it
      // was built as (dev URLs need it too, and transforms run before the
      // client environment compiles).
      api.modifyEnvironmentConfig((environmentConfig, { name }) => {
        if (name !== clientEnvironment) return;
        const root = normalizePath(api.context.rootPath);
        for (const [entryName, entry] of Object.entries(environmentConfig.source.entry ?? {})) {
          const imports =
            typeof entry === "string"
              ? [entry]
              : Array.isArray(entry)
                ? entry
                : Array.isArray(entry.import)
                  ? entry.import
                  : [entry.import];
          for (const file of imports) {
            if (typeof file === "string") {
              state.clientEntries.set(normalizePath(path.resolve(root, file)), entryName);
            }
          }
        }
      });

      api.onAfterEnvironmentCompile(({ environment, stats }) => {
        if (environment.name !== clientEnvironment) return;
        state.clientManifest = stats?.toJson({ entrypoints: true, assets: true }) as
          | ClientStats
          | undefined;
        // Server environments compile first (the client declares them as
        // `dependencies`), so their output files are on disk by now and their
        // `__PP_` placeholders can be rewritten against the finished client
        // manifest. Dev transforms emit real URLs, so only build output is
        // rewritten.
        if (api.context.action === "build") {
          rewriteServerOutput(state, environment.distPath, jsonp);
        }
      });

      api.modifyRspackConfig((rspackConfig, { mergeConfig, environment }) => {
        const envName = (environment as { name?: string } | undefined)?.name;
        if (envName && envName !== clientEnvironment && !serverEnvironments.has(envName)) return rspackConfig;
        return mergeConfig(rspackConfig, {
          resolve: {
            alias: {
              [VIRTUAL_SERVER_LOAD_MODULE]: virtualPath,
            },
          },
          plugins: [
            {
              apply(compiler: Compiler) {
                // finishMake, not make: rspack's `compilation.addEntry` eagerly
                // rebuilds every entry, and when one imports CSS that build runs
                // before the module executor's event channel exists and panics
                // (web-infra-dev/rspack#13410, "should have event sender"). By
                // finishMake the CSS modules are already built, so the eager pass
                // only touches the newly added JS modules. Drop the comment and
                // go back to `make` if rspack ever fixes addEntry.
                compiler.hooks.finishMake.tapPromise("DynamicEntryPlugin", async (compilation) => {
                  if (compilation.name !== clientEnvironment) return;
                  for (const [name, entry] of state.clientModules) {
                    await addResourceToCompilation(compilation, entry, name);
                  }
                });
              },
            },
          ],
        });
      });

      api.transform(
        {
          environments: [clientEnvironment],
          test: /\.m?[tj]sx?/,
        },
        ({ code, resourcePath }) => {
          const transformed = transformSync(code, {
            filename: resourcePath,
            parserOpts: { sourceType: "module" },
            plugins: [babelClientPlugin],
          });

          return {
            code: transformed?.code || "",
            map: transformed?.map as any,
          };
        },
      );

      api.transform(
        {
          environments: Array.from(serverEnvironments),
          test: /\.m?[tj]sx?/,
        },
        ({ code, resourcePath, resourceQuery, environment }) => {
          const relativeId = posix.relative(
            normalizePath(environment.config.root),
            normalizePath(resourcePath),
          );
          const hashed = crypto.createHash("sha256").update(relativeId).digest("hex");

          // `import assets from "./entry.client.ts?assets=client"` — the
          // hiogawa/vite-plugin-fullstack contract. The client module is never
          // compiled into the server bundle; it resolves to its built chunk
          // URLs instead (entry + dependency chunks + styles).
          if (resourceQuery.includes("assets")) {
            if (!resourceQuery.includes("assets=client")) {
              throw new Error(`Unsupported assets query \`${resourceQuery}\` in ${relativeId}.`);
            }
            return {
              code: generateAssetsModule(
                state,
                resourcePath,
                relativeId,
                hashed,
                api.context.action === "build",
                jsonp,
              ),
            };
          }

          let mod: string;
          let deps: string[];
          if (api.context.action === "build") {
            mod = `__PP_MOD__${hashed}`;
            deps = [`__PP_DEPS__${hashed}`];
          } else {
            // TODO: Get publicPath from resolved config.
            mod = `/static/js/${hashed}.js`;
            deps = [];
          }

          const transformed = transformSync(code, {
            filename: resourcePath,
            sourceMap: "inline",
            parserOpts: { sourceType: "module" },
            plugins: [
              [
                babelServerPlugin,
                {
                  mod,
                  deps,
                  onTransformed() {
                    state.clientModules.set(hashed, relativeId);
                  },
                },
              ],
            ],
          });

          return {
            code: transformed?.code || "",
            map: transformed?.map as any,
          };
        },
      );

      api.processAssets(
        {
          stage: "additional",
          environments: Array.from(serverEnvironments),
        },
        ({ assets, environment }) => {
          if (api.context.action !== "build") return;
          for (const filename of Object.keys(assets)) {
            if (filename.endsWith(".js")) {
              state.filesToUpdate.add(path.join(environment.distPath, filename));
            }
          }
        },
      );
    },
  };
}

/**
 * Build-mode server transforms emit `__PP_MOD__<hash>` / `__PP_DEPS__<hash>`
 * placeholders for each "use client" module and `__PP_ASSETS__<hash>` tokens
 * for `?assets=client` imports, because the client chunk URLs are not known
 * until the client environment compiles. Once it has (server environments
 * compile first — the client declares them as `dependencies`), the manifest
 * maps each hash to its emitted chunk files; rewrite the placeholders in the
 * server output files to those URLs.
 */
function rewriteServerOutput(state: PluginState, clientOutDir: string, jsonp: boolean): void {
  const manifest = state.clientManifest;
  if (!manifest) return;
  const prefix = manifest.publicPath || "/";

  for (const file of state.filesToUpdate) {
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, "utf-8");
    const rewritten = code.replace(PP_ASSETS_RE, (_match, _quote, _token, hash) =>
      JSON.stringify(clientAssetsFor(state, manifest, prefix, clientOutDir, hash, jsonp)),
    );
    const rewritten2 = rewritePlaceholders(rewritten, (hash, kind) => {
      const [chunk] = manifest.assetsByChunkName?.[hash] ?? [];
      if (!chunk) {
        throw new Error(`No chunk found for client module ${hash} in the client manifest.`);
      }
      const chunkUrl = `${prefix}${chunk}`;
      if (kind === "MOD") return JSON.stringify(chunkUrl);
      // `$deps` preloads the module's dependency closure before the module
      // under ESM output. Classic JSONP chunks carry their dependencies
      // in-band and the shared runtime loads them, so this scan finds no
      // static imports and the list reduces to the module chunk itself. The
      // JSONP `__pm` ignores the list.
      return JSON.stringify(chunkDeps(clientOutDir, chunk).map((file) => `${prefix}${file}`));
    });
    if (rewritten2 !== code) {
      fs.writeFileSync(file, rewritten2, "utf-8");
    }
  }
}
const PP_PLACEHOLDER_RE = /(['"])(__PP_(MOD|DEPS)__([a-f0-9]{64}))\1/g;

/** A `?assets=client` token emitted by `generateAssetsModule` in build mode. */
const PP_ASSETS_RE = /(['"])(__PP_ASSETS__([a-f0-9]{64}))\1/g;

/** Generated code for `import assets from "./x?assets=client"`.
 *
 * Dev: the client entry chunk is served at the default dev filename, and the
 * module graph supplies its dependencies. The entry's stylesheet is emitted
 * next to it at the default dev css filename when the entry imports one.
 * Build: the chunk URLs are unknown until the client environment compiles (it
 * runs after the server environments), so emit a placeholder token that
 * `rewriteServerOutput` replaces once the client manifest exists.
 */
function generateAssetsModule(
  state: PluginState,
  resourcePath: string,
  relativeId: string,
  hashed: string,
  isBuild: boolean,
  jsonp: boolean,
): string {
  const entryName = state.clientEntries.get(normalizePath(resourcePath));
  if (!entryName) {
    throw new Error(
      `?assets=client import of \`${relativeId}\` — no client environment entry points at this module.`,
    );
  }
  if (isBuild) {
    state.assetsModules.set(hashed, entryName);
    return `export default "__PP_ASSETS__${hashed}";`;
  }
  const hasCss = /(?:from\s*|import\s*)(["'])[^"']+\.css(?:\?[^"']*)?\1/.test(
    fs.readFileSync(resourcePath, "utf-8"),
  );
  // Classic JSONP output cannot `import()` chunks, so the entry is loaded as
  // a classic script and the JSONP runtime chunk must run first.
  return `export default ${JSON.stringify({
    entry: `/static/js/${entryName}.js`,
    js: jsonp ? [{ href: "/static/js/runtime.js" }] : [],
    css: hasCss ? [{ href: `/static/css/${entryName}.css` }] : [],
    ...(jsonp ? { module: false } : {}),
  })};`;
}

/** Relative ESM import specifiers inside an emitted chunk (`from "./x.js"`,
 * `import "./x.js"`, `import("./x.js")`). */
const CHUNK_IMPORT_RE =
  /(?:^|[^A-Za-z0-9_$])(?:from\s*|import\s*\(\s*|import\s*)(["'])(\.\.?\/[^"']+?\.js)\1/g;

/** The given module chunk and every chunk it (transitively) statically
 * imports, in load order, read from the emitted chunk files. */
function chunkDeps(clientOutDir: string, chunkFile: string): string[] {
  const seen = new Set<string>();
  const deps: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    deps.push(file);
    const abs = path.join(clientOutDir, file);
    if (!fs.existsSync(abs)) return;
    const code = fs.readFileSync(abs, "utf-8");
    for (const match of code.matchAll(CHUNK_IMPORT_RE)) {
      visit(posix.normalize(posix.join(posix.dirname(file), match[2]!)));
    }
  };
  visit(chunkFile);
  return deps;
}

/** Replace every placeholder token with `resolve(hash, kind)`. `DEPS` tokens
 * are emitted as the sole element of a `$deps` array literal, so when one is
 * wrapped in `[...]` the whole array is replaced (whitespace-tolerant — the
 * bundler may reformat the literal over several lines) to keep the deps list
 * flat. */
function rewritePlaceholders(
  code: string,
  resolve: (hash: string, kind: "MOD" | "DEPS") => string,
): string {
  let rewritten = "";
  let cursor = 0;

  for (const match of code.matchAll(PP_PLACEHOLDER_RE)) {
    const index = match.index!;
    const kind = match[3] as "MOD" | "DEPS";
    let replaceStart = index;
    let replaceEnd = index + match[0].length;

    if (kind === "DEPS") {
      let open = index - 1;
      let close = replaceEnd;
      while (open >= 0 && /\s/.test(code[open]!)) open--;
      while (close < code.length && /\s/.test(code[close]!)) close++;
      if (code[open] === "[" && code[close] === "]") {
        replaceStart = open;
        replaceEnd = close + 1;
      }
    }

    rewritten += code.slice(cursor, replaceStart) + resolve(match[4]!, kind);
    cursor = replaceEnd;
  }

  return rewritten + code.slice(cursor);
}

const windowsSlashRE = /\\/g;
function slash(p: string): string {
  return p.replace(windowsSlashRE, "/");
}

const isWindows: boolean = typeof process !== "undefined" && process.platform === "win32";
function normalizePath(id: string): string {
  return path.posix.normalize(isWindows ? slash(id) : id);
}

/** The `?assets=client` result for a client entry chunk: the entry script,
 * the scripts to load before it (`js`), and the entry's styles (`css`).
 * Matches the hiogawa/vite-plugin-fullstack `?assets` contract, plus
 * `module: false` for classic JSONP output. */
export type ClientAssets = {
  entry: string;
  js: { href: string }[];
  css: { href: string }[];
  /** False when the assets are classic JSONP scripts rather than ES modules. */
  module?: boolean;
};

/** Resolve a `__PP_ASSETS__<hash>` token to the built client assets of the
 * entry it was generated for. */
function clientAssetsFor(
  state: PluginState,
  manifest: ClientStats,
  prefix: string,
  clientOutDir: string,
  hash: string,
  jsonp: boolean,
): ClientAssets {
  const entryName = state.assetsModules.get(hash);
  if (!entryName) {
    throw new Error(`?assets=client module ${hash} was never discovered.`);
  }
  const assets = (manifest.entrypoints?.[entryName]?.assets ?? []).map((asset) => asset.name);
  const css = assets
    .filter((name) => name.endsWith(".css"))
    .map((name) => ({ href: `${prefix}${name}` }));

  if (jsonp) {
    // The entrypoint's JS assets are the runtime, shared chunks, and finally
    // the entry chunk, in load order. Classic JSONP output must load the
    // former before the latter, so the entry is the last JS asset.
    const jsFiles = assets.filter((name) => name.endsWith(".js"));
    const entryFile = jsFiles[jsFiles.length - 1];
    if (!entryFile) {
      throw new Error(`No chunk found for client entry "${entryName}" in the client manifest.`);
    }
    return {
      entry: `${prefix}${entryFile}`,
      js: jsFiles.slice(0, -1).map((file) => ({ href: `${prefix}${file}` })),
      css,
      module: false,
    };
  }

  // ESM: the entry imports its own chunk graph, so only the entry script is
  // needed; `js` stays the statically imported closure for preloading.
  const files = manifest.assetsByChunkName?.[entryName] ?? [];
  const entryFile = files.find((file) => file.endsWith(".js"));
  if (!entryFile) {
    throw new Error(`No chunk found for client entry "${entryName}" in the client manifest.`);
  }
  return {
    entry: `${prefix}${entryFile}`,
    js: chunkDeps(clientOutDir, entryFile).map((file) => ({
      href: `${prefix}${file}`,
    })),
    css,
  };
}

/**
 * Dev-only: prepend a client entry's initial split chunks (runtime and
 * vendor chunks) before the entry script. `html: false` means rsbuild never
 * injects them, so under JSONP the entry would wait forever on chunk loading
 * that dev's HMR-only runtime does not provide. Assets already present in the
 * HTML (the runtime, from `?assets=client`) are skipped.
 */
function injectInitialChunks(html: string, manifest: ClientStats | undefined): string {
  if (!manifest) return html;
  const prefix = manifest.publicPath || "/";
  for (const entrypoint of Object.values(manifest.entrypoints ?? {})) {
    const jsAssets = entrypoint.assets
      .map((asset) => asset.name)
      .filter((name) => name.endsWith(".js"));
    const entryFile = jsAssets[jsAssets.length - 1];
    if (entryFile === undefined || jsAssets.length < 2) continue;
    const entryIndex = html.indexOf(entryFile);
    if (entryIndex === -1) continue;
    const missing = jsAssets.slice(0, -1).filter((name) => !html.includes(name));
    if (missing.length === 0) continue;
    const scriptStart = html.lastIndexOf("<script", entryIndex);
    if (scriptStart === -1) continue;
    const injection = missing.map((name) => `<script src="${prefix}${name}"></script>`).join("");
    html = html.slice(0, scriptStart) + injection + html.slice(scriptStart);
  }
  return html;
}

async function addResourceToCompilation(compilation: Compilation, resource: string, name: string) {
  const { EntryPlugin, WebpackError } = compilation.compiler.rspack;

  const dependency = EntryPlugin.createDependency(resource);

  return new Promise<void>((resolve, reject) => {
    // asyncChunks: true keeps these out of the initial page assets — they are
    // emitted as standalone chunks and loaded on demand by the client runtime.
    // The chunk itself is named after the module hash so the runtime can
    // import it by URL.
    compilation.addEntry(
      compilation.compiler.context,
      dependency,
      {
        name,
        asyncChunks: true,
      },
      (error, mod) => {
        if (error) {
          compilation.errors.push(error);
          return reject(error);
        }

        if (!mod) {
          const notAddedError = new WebpackError(
            `Failed to add resource ${resource} to compilation ${compilation.name}`,
          );

          compilation.errors.push(notAddedError);
          return reject(notAddedError);
        }

        resolve();
      },
    );
  });
}
