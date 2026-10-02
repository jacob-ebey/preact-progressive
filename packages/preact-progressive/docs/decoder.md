## Functions

- [pump](#pump)

### pump

Applies settlement frames appended to an already-decoded row (e.g.
promise resolutions streamed in after hydration). Standalone so the
client can invoke it from the namespace append hook (`bag.f`, emitted by
`Encoder.appendFrame`) without holding a `Decoder` instance. No-op for
rows that were never decoded or have no new content.

| Function | Type |
| ---------- | ---------- |
| `pump` | `(namespace: string, id: string, loadModule?: LoadModule) => void` |


## Decoder

Document decoder: parses rows produced by the `Encoder` back into live
values. Rows are read from `globalThis[namespace].d[id]`; VNode plugin
tokens become preact VNodes, client references become resolved components
(`lazy()` when their module has not loaded yet) or call-time-resolved
functions, and every built-in type is reconstructed natively.

Rows are materialized lazily and at most once: decoding a row that
references instances defined in another row locates it via its base
header, so decode order never matters. Promise placeholders decode to
real Promises; result frames already present in the payload settle them
during decode, and frames appended later are applied by `pump`.
See `DataDecoder` for the stream variant of this codec.

### Cross-row references

One `Encoder` numbers reference ids monotonically across every row it
writes, so a row may reference instances defined in another row. Decoding
such an id finds the owning row by its `<base>|` header, taking the
greatest base at or below the id. It parses that row into the same table.
Decode order never matters, and rows materialize at most once.

### Methods

- [preload](#preload)
- [decode](#decode)
- [pump](#pump)

#### preload

Ensure every module referenced by a row (including modules reachable
through references into other rows) is loaded.

This is the first move of the hydration pipeline (`preload`, then
`decode`, then preact `hydrate`). It walks the row and constructs
nothing: it collects `$R` module references, including through
references into other rows. With the default loader it awaits the
module load promise (`__pp[mod].p`), triggering the import via `__pm`
where needed; with a custom loader it warms the loader itself. Either
way modules load before decode, so component references resolve to
implementations directly and hydration never suspends.

| Method | Type |
| ---------- | ---------- |
| `preload` | `(id: string) => Promise<void>` |

#### decode

Decode a row into a live value. Rows are materialized at most once.

This is the second move of the hydration pipeline. It parses the row
into a live tree: `P["$V"]` becomes a preact vnode through `h()`, and
`P["$R"]` becomes a resolved reference. Component kind means the loaded
export when present, else a `lazy()` wrapper that resolves on module
load. Function kind means the loaded export when present, else a
function resolving the module at call time. `$bound` values prepend to
props or call arguments.

Loaded modules return implementations directly, so initial hydration
suspends on nothing. That directness matters because preact `lazy`
always throws once on first render, which would mis-hydrate sibling DOM.

| Method | Type |
| ---------- | ---------- |
| `decode` | `(id: string) => unknown` |

#### pump

Apply result frames appended to an already-decoded row (e.g. promise
settlements streamed in after hydration). No-op for rows that were
never decoded or have no new content.

| Method | Type |
| ---------- | ---------- |
| `pump` | `(id: string) => void` |

## DataDecoder

Data decoder: the same codec as `Decoder`, without the namespace concept.
Reads byte streams produced by `DataEncoder` and resolves them to a live
value. Each stream starts with one self-contained root frame followed by
zero or more promise result frames, so each `decode` call starts from an
empty reference table.

This is the transport behind client navigation. `decode(stream, onValue?)`
reads incrementally, parsing each newline-terminated frame on arrival. The
root delivers through `onValue` before close so hosts can paint early,
while settlements apply to the same parse context and resolve placeholders
in place. The returned promise resolves with the root on close. Malformed
input rejects, whether trailing bytes or an empty stream.

Module resolution here has no `__pm` inline scripts to lean on, since
those exist only in HTML responses. When the decoder imports a module
itself it mirrors `__pm`: it caches the load promise and exposes resolved
exports on the registry entry. Otherwise component lookups miss their
export and hang suspended forever.

## Interfaces

- [DecoderOptions](#decoderoptions)

### DecoderOptions

Options shared by `Decoder` and `DataDecoder`.

| Property | Type | Description |
| ---------- | ---------- | ---------- |
| `loadModule` | `LoadModule or undefined` | Module-loading strategy for client references. Override this to resolve modules from a non-ESM cache (for example webpack's `__webpack_require__`). Defaults to the `__pp` registry plus a dynamic ESM `import()`. |


## Types

- [LoadModule](#loadmodule)

### LoadModule

Resolves the named export of a client-reference module.

Return the implementation directly when it is already available (a
synchronous module cache such as webpack's `__webpack_require__`) or a
promise for it otherwise. The decoder uses the synchronous form to hand
out the real component or function, so hydration never suspends on
preact's `lazy`. Implementations should be idempotent: the decoder may
call the loader again at call time for function-kind references.

| Type | Type |
| ---------- | ---------- |
| `LoadModule` | `(mod: string, name: string) => unknown` |

