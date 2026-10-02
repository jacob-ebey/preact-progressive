import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as posix from "node:path/posix";

import { transformSync } from "@babel/core";
import {
  normalizePath,
  type Plugin,
  type PluginOption,
  type Manifest,
  mergeConfig,
  type UserConfig,
  type ViteDevServer,
} from "vite";

import babelClientPlugin from "babel-plugin-preact-progressive/client";
import babelServerPlugin from "babel-plugin-preact-progressive/server";

type PluginState = {
  clientManifest?: Manifest;
  clientModules: Map<string, string>;
  filesToUpdate: Set<string>;
  isScanBuild: boolean;
};

/** Virtual module exporting a server-side `loadModule` for the `Decoder`. */
export const VIRTUAL_SERVER_LOAD_MODULE = "virtual:server-load-module";
const RESOLVED_SERVER_LOAD_MODULE = "\0" + VIRTUAL_SERVER_LOAD_MODULE;

/**
 * Static `virtual:server-load-module` source.
 *
 * The server transform registers every client reference's implementation on
 * `globalThis.__pp_server_modules` under its `$mod`/`$name` when the
 * defining module evaluates, so the loader needs no per-project
 * enumeration (which could never be complete: the virtual module loads
 * before transitive client modules are discovered) and no dynamic access on
 * bundled namespaces (whose export names minifiers may mangle). Unknown ids
 * fall back to a dynamic `import()` cached for synchronous second reads,
 * which covers dev URLs that were never statically imported.
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
    "  const p = import(/* @vite-ignore */ mod).then(",
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
};

/**
 * Build wiring for `"use client"` boundaries.
 *
 * How the plugin converts `"use client"` source into deployable chunks. Each
 * environment transforms its own way, with the client stripping directives
 * and the server rewriting references. The server transform discovers client
 * modules and the client compile emits them as on-demand chunks. A final
 * pass patches server output placeholders with real chunk URLs.
 *
 * - The client environment emits every discovered client module as a chunk.
 * - Server environments build before the client in `buildApp`.
 * - Files containing the text `use client` transform, and everything else
 *   passes through untouched.
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
 * Dev skips placeholders. Module URLs resolve from the module graph, with
 * deps staying empty.
 *
 * #### Client emission
 *
 * Every discovered client module emits as a chunk with
 * `preserveSignature: "exports-only"`. The build needs
 * `build.manifest: true`, and the post-build pass maps module paths to chunk
 * files through `.vite/manifest.json`, following transitive `imports` for
 * deps.
 *
 * #### Rewrite pass
 *
 * All environments compile first, then the plugin rewrites recorded server
 * output files in place. `MOD` tokens become the quoted chunk URL. `DEPS`
 * tokens become the quoted dependency array, replacing the whole surrounding
 * array literal so the list stays flat. The first unresolvable token fails
 * the build.
 *
 * #### Requirements
 *
 * - `build.manifest: true` on the client environment. Without
 *   `.vite/manifest.json` the plugin errors.
 * - `emitAssets: true` on server environments using `?assets=` imports for
 *   entry CSS/URLs.
 * - Server output files patch in place after both environments build. A
 *   missing manifest entry or unknown client-module hash errors.
 *
 * Stylesheet handling relies on `emitAssets` plus the fullstack `?assets`
 * module. On Rsbuild instead, see `rsbuild-plugin-preact-progressive`,
 * which targets the same wire format on a different toolchain.
 *
 * #### Server-side decoding (`virtual:server-load-module`)
 *
 * The encoder only carries enough information to load client references in
 * browser builds. To run the decoder on the server — prerendering an island
 * to HTML and its payload in a single pass, or round-tripping richer
 * information for server actions — import `virtual:server-load-module` from
 * a server environment. It exports a `loadModule` implementation for the
 * decoder which maps each encoded client module id to its server equivalent
 * and loads it:
 *
 * ```ts
 * import { loadModule } from "virtual:server-load-module";
 * import { Decoder } from "preact-progressive/decoder";
 *
 * const decoder = new Decoder(namespace, { loadModule });
 * await decoder.preload(row);
 * const decoded = decoder.decode(row);
 * ```
 *
 * The server transform registers every reference's implementation on
 * `globalThis.__pp_server_modules` when its module evaluates, so the loader
 * resolves synchronously — `decode()` hands out the real implementation
 * without suspending — with no per-project enumeration and no reliance on
 * bundled export names. Available in server environments only.
 */
export default function preactProgressive(options?: Options): PluginOption {
  const clientEnvironment = options?.environments?.client || "client";
  const serverEnvironments = new Set(options?.environments?.server ?? ["ssr"]);
  const state: PluginState = {
    clientModules: new Map(),
    filesToUpdate: new Set(),
    isScanBuild: false,
  };
  let server: ViteDevServer;

  return [
    {
      name: "preact-progressive",
      sharedDuringBuild: true,
      configureServer(_server) {
        server = _server;
      },
      configEnvironment(name) {
        if (name === clientEnvironment) {
          return {
            optimizeDeps: {
              include: [
                "preact",
                "preact/hooks",
                "preact/compat",
                "preact-progressive/client",
              ],
            },
          };
        }
        if (serverEnvironments.has(name)) {
          return {
            build: {
              rolldownOptions: {
                input: Object.fromEntries(state.clientModules.entries()),
                treeshake: {
                  moduleSideEffects: true,
                },
              },
            },
            optimizeDeps: {
              include: [
                "preact",
                "preact/hooks",
                "preact/compat",
                "preact-progressive/server",
              ],
            },
          };
        }
      },
      config: {
        order: "post",
        handler(config) {
          return mergeConfig(
            {
              builder: {
                async buildApp(builder) {
                  await Promise.all(
                    Array.from(serverEnvironments).map((env) =>
                      builder.build(builder.environments[env]),
                    ),
                  );
                  await builder.build(builder.environments["client"]);
                },
              },
            } satisfies UserConfig,
            config,
          );
        },
      },
      buildStart() {
        if (this.environment.name !== clientEnvironment) return;
        for (const file of state.clientModules.values()) {
          this.emitFile({
            type: "chunk",
            id: path.resolve(file),
            preserveSignature: "exports-only",
          });
        }
      },
      resolveId(id) {
        if (id === VIRTUAL_SERVER_LOAD_MODULE) {
          if (!serverEnvironments.has(this.environment.name)) return;
          return RESOLVED_SERVER_LOAD_MODULE;
        }
      },
      load(id) {
        if (id === RESOLVED_SERVER_LOAD_MODULE) {
          return generateServerLoadModule();
        }
      },
      transform: {
        async handler(code, id) {
          if (!code.includes("use client")) return;

          if (this.environment.name === clientEnvironment) {
            const transformed = transformSync(code, {
              filename: id,
              parserOpts: { sourceType: "module" },
              plugins: [babelClientPlugin],
            });

            return {
              code: transformed?.code || "",
              map: transformed?.map as any,
            };
          }

          if (!serverEnvironments.has(this.environment.name)) return;

          const relativeId = posix.relative(
            normalizePath(this.environment.config.root),
            normalizePath(id),
          );

          let mod: string;
          let deps: string[];
          const hashed = crypto
            .createHash("sha256")
            .update(relativeId)
            .digest("hex");
          if (this.environment.mode === "build") {
            mod = `__PP_MOD__${hashed}`;
            deps = [`__PP_DEPS__${hashed}`];
          } else {
            // const resolved = await this.resolve(id, undefined, { skipSelf: true });
            // mod = resolved?.id || this.environment.config.base + relativeId;
            const resolved = server!.moduleGraph.getModuleById(id);
            mod = resolved?.url || this.environment.config.base + relativeId;
            deps = [];
          }

          const transformed = transformSync(code, {
            filename: id,
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
      },
      writeBundle(_, bundle) {
        if (this.environment.name === clientEnvironment) {
          const manifestAsset = bundle[".vite/manifest.json"];
          if (
            manifestAsset?.type !== "asset" ||
            typeof manifestAsset.source !== "string"
          ) {
            throw this.error(
              `'.vite/manifest.json' missing from '${clientEnvironment}' environment. Please enable 'build.manifest' for the '${clientEnvironment}' environment.`,
            );
          }
          state.clientManifest = JSON.parse(manifestAsset.source);
          return;
        }
      },
      generateBundle(_, bundle) {
        if (state.isScanBuild || !serverEnvironments.has(this.environment.name))
          return;

        for (const file of Object.keys(bundle)) {
          state.filesToUpdate.add(
            path.join(this.environment.config.build.outDir, file),
          );
        }
      },
    },
    // scanBuildStripPlugin({ state }),
    builderPlugin({ clientEnvironment, serverEnvironments, state }),
  ];
}

function builderPlugin({
  clientEnvironment,
  serverEnvironments,
  state,
}: {
  clientEnvironment: string;
  serverEnvironments: Set<string>;
  state: PluginState;
}): Plugin {
  let base = "/";
  return {
    name: "preact-progressive:builder",
    enforce: "post",
    sharedDuringBuild: true,
    configResolved(config) {
      base = config.base;
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        for (const env of [...serverEnvironments, clientEnvironment]) {
          if (!builder.environments[env].isBuilt) {
            await builder.build(builder.environments[env]);
          }
        }

        if (!state.clientManifest) {
          this.error(
            "Missing clientManifest. Did you forget to run the client build before the server build?",
          );
        }

        for (const file of state.filesToUpdate) {
          let code = fs.readFileSync(file, "utf-8");
          const ogCode = code;
          // MOD tokens are plain string values. Never strip surrounding
          // brackets here: they may be computed member access (e.g. the
          // `globalThis.__pp_server_modules["__PP_MOD__.."]` registration
          // emitted by the server transform), which must stay intact.
          const modMatches = Array.from(
            code.matchAll(/['"]__PP_MOD__([a-fA-F0-9]{64})['"]/g),
          );
          for (let i = modMatches.length - 1; i >= 0; i--) {
            const match = modMatches[i];
            const mod = state.clientModules.get(match[1]);
            if (!mod)
              this.error(`client module ${match[1]} was never discovered`);
            const file = state.clientManifest?.[mod]?.file;
            if (!file) this.error(`No chunk found for client module ${mod}`);
            const replacement = JSON.stringify(base + file);
            code =
              code.slice(0, match.index) +
              replacement +
              code.slice(match.index + match[0].length);
          }
          // DEPS tokens are emitted as the sole element of a `$deps` array
          // literal; replacing the whole surrounding array keeps the list flat.
          const depsMatches = Array.from(
            code.matchAll(/\[?['"]__PP_DEPS__([a-fA-F0-9]{64})['"]\]?/g),
          );
          for (let i = depsMatches.length - 1; i >= 0; i--) {
            const match = depsMatches[i];
            const mod = state.clientModules.get(match[1]);
            if (!mod)
              this.error(`client module ${match[1]} was never discovered`);
            const replacement = JSON.stringify(
              getDeps(base, state.clientManifest, mod),
            );
            code =
              code.slice(0, match.index) +
              replacement +
              code.slice(match.index + match[0].length);
          }

          if (code !== ogCode) {
            fs.writeFileSync(file, code, "utf-8");
          }
        }
      },
    },
  };
}

function getDeps(
  base: string,
  manifest: Manifest,
  mod: string,
  deps?: Set<string>,
) {
  deps ??= new Set();
  if (manifest[mod]) {
    deps.add(base + manifest[mod].file);

    for (const info of manifest[mod]?.imports ?? []) {
      getDeps(base, manifest, info, deps);
    }
  }
  return Array.from(deps);
}
