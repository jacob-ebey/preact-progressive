## Functions

- [default](#default)

### default

Build wiring for `"use client"` boundaries.

How the plugin converts `"use client"` source into deployable chunks. Each
environment transforms its own way, with the client stripping directives
and the server rewriting references. The server transform discovers client
modules and the client compile emits them as on-demand chunks. A final
pass patches server output placeholders with real chunk URLs.

- The client environment emits every discovered client module as a chunk.
- Server environments build before the client in `buildApp`.
- Files containing the text `use client` transform, and everything else
  passes through untouched.

#### Placeholders

Production server transforms cannot know chunk URLs, since the client
compiles after the server. References carry content-hashed placeholders
instead, derived from the module path relative to project root:

- `__PP_MOD__<sha256>` for the module chunk URL.
- `__PP_DEPS__<hash>` for the chunk dependencies to preload (`$deps`).

Dev skips placeholders. Module URLs resolve from the module graph, with
deps staying empty.

#### Client emission

Every discovered client module emits as a chunk with
`preserveSignature: "exports-only"`. The build needs
`build.manifest: true`, and the post-build pass maps module paths to chunk
files through `.vite/manifest.json`, following transitive `imports` for
deps.

#### Rewrite pass

All environments compile first, then the plugin rewrites recorded server
output files in place. `MOD` tokens become the quoted chunk URL. `DEPS`
tokens become the quoted dependency array, replacing the whole surrounding
array literal so the list stays flat. The first unresolvable token fails
the build.

#### Requirements

- `build.manifest: true` on the client environment. Without
  `.vite/manifest.json` the plugin errors.
- `emitAssets: true` on server environments using `?assets=` imports for
  entry CSS/URLs.
- Server output files patch in place after both environments build. A
  missing manifest entry or unknown client-module hash errors.

Stylesheet handling relies on `emitAssets` plus the fullstack `?assets`
module. On Rsbuild instead, see `rsbuild-plugin-preact-progressive`,
which targets the same wire format on a different toolchain.

#### Server-side decoding (`virtual:server-load-module`)

The encoder only carries enough information to load client references in
browser builds. To run the decoder on the server (prerendering an island
to HTML and its payload in a single pass, or round-tripping richer
information for server actions), import `virtual:server-load-module` from
a server environment. It exports a `loadModule` implementation for the
decoder which maps each encoded client module id to its server equivalent
and loads it:

```ts
import { loadModule } from "virtual:server-load-module";
import { Decoder } from "preact-progressive/decoder";

const decoder = new Decoder(namespace, { loadModule });
await decoder.preload(row);
const decoded = decoder.decode(row);
```

The server transform registers every reference's implementation on
`globalThis.__pp_server_modules` when its module evaluates, so the loader
resolves synchronously: `decode()` hands out the real implementation
without suspending, with no per-project enumeration and no reliance on
bundled export names. Available in server environments only.

| Function | Type |
| ---------- | ---------- |
| `default` | `(options?: Options or undefined) => PluginOption` |


## Constants

- [VIRTUAL_SERVER_LOAD_MODULE](#virtual_server_load_module)

### VIRTUAL_SERVER_LOAD_MODULE

Virtual module exporting a server-side `loadModule` for the `Decoder`.

| Constant | Type |
| ---------- | ---------- |
| `VIRTUAL_SERVER_LOAD_MODULE` | `"virtual:server-load-module"` |



## Types

- [Options](#options)

### Options

| Type | Type |
| ---------- | ---------- |
| `Options` | `{ environments?: { /** * Client environment name. * * @default "client" */ client?: string; /** * Server environment names. * * @default ["ssr"] */ server?: string[]; }; }` |

