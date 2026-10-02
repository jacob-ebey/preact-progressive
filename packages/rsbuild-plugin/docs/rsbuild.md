## Functions

- [default](#default)

### default

Build wiring for `"use client"` boundaries on Rsbuild/Rspack. It shares
the wire format and reference model of the Vite plugin, adapted to a
different toolchain.

How the plugin converts `"use client"` source into deployable chunks. Each
environment transforms its own way, with the client stripping directives
and the server rewriting references. The server transform discovers client
modules and the client compile emits them as on-demand chunks. A final
pass patches server output placeholders with real chunk URLs. Files
containing the text `use client` transform per environment, and the rest
passes through.

#### Placeholders

Production server transforms cannot know chunk URLs, since the client
compiles after the server. References carry content-hashed placeholders
instead, derived from the module path relative to project root:

- `__PP_MOD__<sha256>` for the module chunk URL.
- `__PP_DEPS__<hash>` for the chunk dependencies to preload (`$deps`).

A third token covers `?assets=client` imports under the
vite-plugin-fullstack `?assets` contract.
`import assets from "./entry.client.ts?assets=client"` resolves to
`{ entry, js, css }` chunk URLs. In builds it emits
`__PP_ASSETS__<hash>`, keyed by the client entry the import targets.
Imports pointing elsewhere throw.

Dev skips placeholders. Module URLs fall back to hashed dev URLs, with
deps staying empty.

#### Client emission

Discovered modules join the client compilation as async entries. The
chunks are standalone, carry the module hash as name, and stay out of
initial page assets. Entries join at `finishMake` rather than `make`,
since earlier injection can run before the module executor event channel
exists, where entries importing CSS panic. The pass also records candidate
server output files through `processAssets` at the `additional` stage over
server `.js` files.

By default the client environment compiles to classic JSONP output in
both dev and production (`output.module` and the `modern-module` library
type are disabled) with a single shared runtime, and each discovered
module is exposed as `window.__pp__<hash>`. One runtime keeps shared
modules (most importantly `preact` itself) singletons across every
on-demand chunk, and does not require native ESM support.
`rsbuild-plugin-preact-progressive/client` supplies the matching loader
and `rsbuild-plugin-preact-progressive/server` the `__pm` runtime shim.
Pass `format: "esm"` to keep rsbuild's ESM output and native `import()`
loading instead.

#### Rewrite pass

All environments compile first, then the plugin rewrites recorded server
output files in place. `MOD` tokens become the quoted chunk URL; the client
loader derives the module hash from the chunk filename to find the
`window.__pp__<hash>` export. `DEPS` tokens become the quoted dependency array, replacing the whole surrounding array literal so the
list stays flat. `__PP_ASSETS__` tokens become the entry
`{ entry, js, css, module }` object. The first unresolvable token fails the
build. Unknown module hashes and missing entry chunks throw, as with the
Vite plugin.

#### `?assets=client` imports

The plugin honors `?assets=client` imports following the
vite-plugin-fullstack `?assets` contract:

```ts
import clientAssets from "./entry.client.ts?assets=client";
// { entry: string; js: { href: string }[]; css: { href: string }[] }
```

The import must point at a client-environment entry, and anything else
throws. Dev resolves to the served entry chunk URL, plus a stylesheet URL
when the entry imports CSS. Builds emit a placeholder that the
post-compile rewrite resolves from client stats. Stylesheets resolve from
entrypoint assets in client stats for `css`, falling back to a
conventional `/static/css/<entry>.css` URL in dev when the entry imports
a stylesheet.

#### Server-side decoding (`virtual:server-load-module`)

The encoder only carries enough information to load client references in
browser builds. To run the decoder on the server (prerendering an island
to HTML and its payload in a single pass, or round-tripping richer
information for server actions), import `virtual:server-load-module` from
a server environment. It exports a `loadModule` implementation for the
decoder which maps each encoded client module id to its server equivalent
and loads it. The server transform registers every reference's
implementation on `globalThis.__pp_server_modules` at evaluation time, so
`decode()` hands out the real implementation synchronously without
suspending and without relying on bundled export names. Available in
server environments only.

| Function | Type |
| ---------- | ---------- |
| `default` | `(options?: Options or undefined) => RsbuildPlugin` |


## Constants

- [VIRTUAL_SERVER_LOAD_MODULE](#virtual_server_load_module)

### VIRTUAL_SERVER_LOAD_MODULE

Virtual module exporting a server-side `loadModule` for the `Decoder`.

| Constant | Type |
| ---------- | ---------- |
| `VIRTUAL_SERVER_LOAD_MODULE` | `"virtual:server-load-module"` |



## Types

- [Options](#options)
- [ClientAssets](#clientassets)

### Options

| Type | Type |
| ---------- | ---------- |
| `Options` | `{ /** * Client chunk format. * * - `"jsonp"` (default) emits classic JSONP chunks loaded by *   `rsbuild-plugin-preact-progressive/client`. It shares one runtime and *   module cache across the on-demand modules, so it works the same in dev *   and production and does not require native ESM support. * - `"esm"` keeps rsbuild's ESM output and relies on the native dynamic *   `import()` loader. Use it when the client can assume ESM. * * @default "jsonp" */ format?: "jsonp" or "esm"; environments?: { /** * Client environment name. * * @default "client" */ client?: string; /** * Server environment names. * * @default ["ssr"] */ server?: string[]; }; /** * Wires dev-time SSR. Under `rsbuild dev`, the named server environment's * `index` bundle serves requests through its default `fetch` export. Pass * `false` to disable the built-in serving. */ serveEnvironment?: false or string; }` |

### ClientAssets

The `?assets=client` result for a client entry chunk: the entry script,
the scripts to load before it (`js`), and the entry's styles (`css`).
Matches the hiogawa/vite-plugin-fullstack `?assets` contract, plus
`module: false` for classic JSONP output.

| Type | Type |
| ---------- | ---------- |
| `ClientAssets` | `{ entry: string; js: { href: string }[]; css: { href: string }[]; /** False when the assets are classic JSONP scripts rather than ES modules. */ module?: boolean; }` |

