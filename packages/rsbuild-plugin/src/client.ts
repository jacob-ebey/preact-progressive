/**
 * Client-side module loading for Rsbuild/Rspack JSONP output.
 *
 * The Rsbuild plugin compiles the client environment to classic JSONP chunks
 * (`output.module` and the `modern-module` library type disabled) and exposes
 * every `"use client"` module as `window.__pp__<hash>`. Unlike ESM chunks,
 * JSONP chunks cannot be loaded with `import()`, so the browser needs a
 * loader that injects a `<script>` and reads that global.
 *
 * `loadModule` is the `LoadModule` implementation passed to
 * `prgressiveHydrate`. On first use it installs the JSONP loader, replaces
 * the queued `window.__pm`, and flushes any calls the server-inlined shim
 * captured. That shim lives in `rsbuild-plugin-preact-progressive/server`
 * (`runtime`), because the server inlines it into the rendered HTML.
 *
 * The loader derives the module hash from the chunk filename and reads its
 * exported value from `window.__pp__<hash>`.
 */

/** Module registry entry, mirroring `window.__pp[mod]`. */
type ModuleEntry = {
  p?: Promise<unknown>;
  m?: Record<string, unknown>;
};

type LoaderGlobal = {
  __pp?: Record<string, ModuleEntry>;
  __pm?: (mod: string, ...deps: string[]) => void;
  __ppq?: unknown[][];
  [key: string]: unknown;
};

let installed = false;

/**
 * Extracts the module hash from a chunk URL. rsbuild emits client chunks with
 * the module hash (a 64-char sha256) as the leading filename segment, e.g.
 * `<hash>.js` in dev and `<hash>.<contenthash>.js` in production.
 */
function moduleHash(mod: string): string | undefined {
  const file = mod.split(/[?#]/)[0]!.split("/").pop()!;
  return /^([a-f0-9]{64})/.exec(file)?.[1];
}

/**
 * Installs the JSONP-backed `window.__pm` and flushes any calls the
 * server-inlined shim queued before the client bundle ran.
 * Idempotent; safe to call from multiple entries.
 */
export function installModuleLoader(): void {
  const g = globalThis as unknown as LoaderGlobal;
  g.__pp ??= {};
  g.__pm = (mod: string) => {
    const registry = g.__pp!;
    let entry = registry[mod];
    if (!entry) {
      entry = {};
      registry[mod] = entry;
    }
    if (entry.p || entry.m) return;

    entry.p = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = mod;
      script.onload = () => {
        script.remove();
        const hash = moduleHash(mod);
        const namespace = hash === undefined ? undefined : g[`__pp__${hash}`];
        if (namespace === null || typeof namespace !== "object") {
          reject(new Error(`Client module "${mod}" did not register its exports.`));
          return;
        }
        entry!.m = namespace as Record<string, unknown>;
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error(`Failed to load client module "${mod}".`));
      };
      document.head.appendChild(script);
    });
  };

  installed = true;

  const queue = g.__ppq;
  g.__ppq = undefined;
  if (queue) {
    for (const args of queue) {
      g.__pm(...(args as [string, ...string[]]));
    }
  }
}

/**
 * `LoadModule` implementation for Rsbuild/Rspack JSONP chunks. Resolves the
 * named export synchronously when the chunk has already loaded, otherwise
 * returns the load promise.
 *
 * ```ts
 * import { prgressiveHydrate } from "preact-progressive/client";
 * import { loadModule } from "rsbuild-plugin-preact-progressive/client";
 *
 * prgressiveHydrate(document.documentElement, { loadModule });
 * ```
 */
export function loadModule(mod: string, name: string): unknown {
  if (!installed) installModuleLoader();
  const g = globalThis as unknown as LoaderGlobal;
  let entry = g.__pp![mod];
  if (!entry) {
    g.__pm!(mod);
    entry = g.__pp![mod];
  }
  if (entry?.m) return entry.m[name];
  return entry?.p?.then(() => entry!.m?.[name]);
}
