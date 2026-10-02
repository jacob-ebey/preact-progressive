## Encoder

Document encoder: serializes values (including preact VNode trees and
client references) into rows stored on a global namespace, for inline
`<script>` transport during SSR.

Unlike the previous generation of this encoder, the payload contains no
executable JavaScript: it is pure data that the `Decoder` parses back
into live values, so nothing on the wire can execute at hydration time.

Each `encode` call produces one row stored under a name:

  globalThis[ns]??={};globalThis[ns].d??={};
  globalThis[ns].d[name]="<payload>";

Promises are transported as `p<id>` placeholders in that first payload;
once they settle, `flush(name)` yields follow-up chunks of JavaScript
that append `!<id>` result frames to the stored row (`+=`), which the
client applies via `Decoder.pump`.

See `ValueWriter` for the frame format and `DataEncoder` for the stream
variant of this codec.

Not representable in this format (and rejected or dropped):
  - non-reference functions outside component positions (throw unless
    strictFunctions=false)
  - VNode refs (warn unless strictRefs=true)
  - symbol-keyed properties (warn)

Plain-function components (server components) are not shipped at all:
they render inline during encoding and only their output travels.

### Wire format

The exact bytes on the wire, for debugging payloads and building
compatible tooling.

#### Frames

A payload holds one or more newline-terminated frames. The first frame
holds the root value, and later frames settle promises. A document row
script stores concatenated frames as a JS string with `<` escaped as
`\u003c`, while a data stream sends one frame per line.

Frames whose first claimed reference id differs from `0` carry a
`<base>|` header, so rows decode independently and align lazily.
Reference ids run monotonic per writer. The first encounter of an
instance value claims the next id. Repeats emit `@<id>` while strings
stay inline. Only instances take references.

#### Value tags

Literals: `u` (undefined), `null`, `true`, `false`, `NaN`, `I`/`i`
(`±Infinity`), `z` (`-0`), `"..."` (JSON string), `<digits>` (number),
`b<int>` (bigint), `s"key"` (`Symbol.for(key)`).

Instances, each claiming an id: `D"..."` (Date), `U"..."` (URL),
`r[src,flags]` (RegExp), `E{...}` (Error body), `A`/`o`/`C`/`L`/`l`/`G`/
`g`/`H`/`h`/`J`/`j`/`V` plus `"base64"` for `ArrayBuffer` / typed arrays /
`DataView`, `M[k,v,...]` for flat Map pairs, `S[v,...]` for Set, `[...]`
for arrays, `{...}` for objects.

Async: `p<id>` (placeholder, claims `<id>`), `!<id>+<value>`
(fulfillment), `!<id>-<reason>` (rejection).

Cycles and shared values: `@<id>` back-reference.

#### Plugin tokens

A client reference serializes as:

```
P["$R",<kind>,<mod>,<name>]
P["$R",<kind>,<mod>,<name>,[<bound...>]]   // with captured values
```

- `<kind>` reads `"component"` in a vnode type slot and `"function"`
  everywhere else.
- `<mod>` and `<name>` repeat the `$mod` and `$name` strings.
- The fifth field carries `$bound` values. It appears only with captures
  to send, and empty bindings keep the four-field form.

A vnode serializes as:

```
P["$V",<type>,<key>,<props>]
```

- `<type>` is a DOM tag string, the `"$F"` Fragment sentinel, the `"$S"`
  Suspense sentinel, or a component-kind `$R` token. Plain function types
  (server components) render at encode time and replace themselves with
  output, so they never reach the wire.
- `<key>` reads `null` without a key.
- `<props>` is the serialized props object. `children` leaves the props
  and travels as an optional trailing field, so the wire never carries a
  `children` prop. Function-kind references inside props keep their shape,
  which means an `onClick` passed to a client component arrives as a `$R`
  token and reattaches at hydration.

Rows store on a per-request namespace at `globalThis[ns].d[<id>]`.
Payloads write as JS string literals with `<` escaped as `\u003c`, so
they can never close their host `<script>` tag.

Two details close out references. Reference-tracked values like objects
and arrays claim ids in encounter order. Repeats decode to one live
identity through `@<id>` tokens, while functions take no reference slots,
so each use site emits its own `$R` token. Promise props ship as `p<id>`
placeholders, and their settlements follow as frames (`!<id>+<value>`,
`!<id>-<reason>`) appended to the row in script chunks the client applies.

#### Codec options

Codec strictness is configurable. `strictRefs` throws on VNode `ref`s
instead of warning, and `strictFunctions` warns on non-reference functions
instead of throwing. `redactErrors` controls Error redaction. `false`
sends as-is, while a string becomes the redacted message. `cause` always
serializes.

#### Reading a payload

1. Find the island script past the markers:
   `globalThis["__pd"].d["P0-0"] = "..."`.
2. Unescape `\u003c` back to `<` and split on newlines. Line 1 is the
   root, and `!`-lines settle.
3. `P["v",...]` nests like the vnode tree and `P["R",...]` names module
   and export. `p<N>` placeholders resolve from later `!N` frames in the
   same row (or follow-up script chunks running `row += frame; ns.f(row)`).

### Methods

- [encode](#encode)
- [encodeVNode](#encodevnode)

#### encode

Serialize a value under a given name.
Returns JavaScript code (or `<script>...</script>` if wrapInScript is
true) which stores the encoded payload string in the row namespace.

| Method | Type |
| ---------- | ---------- |
| `encode` | `(name: string, value: unknown, wrapInScript?: boolean) => string` |

#### encodeVNode

Serialize a VNode (or VNode-shaped object) as the root of a row.

| Method | Type |
| ---------- | ---------- |
| `encodeVNode` | `(name: string, vnode: VNode<{}> or { type: unknown; props: unknown; key?: unknown; ref?: unknown; }, wrapInScript?: boolean) => string` |

## DataEncoder

Data encoder: the same codec as `Encoder`, without the namespace concept.
Each `encode` call writes one self-contained frame to its own
`ReadableStream<Uint8Array>`; reference ids start at 0 and never escape
the returned stream, so separate streams are independent worlds.

This is the transport behind client navigation. One route serves two
representations, and the `Accept` header picks between them: full document
loads omit the header and get `renderToProgressiveStream` HTML, while
navigations send `Accept: text/x-component` and get a `DataEncoder`
stream served as `text/x-component; charset=UTF-8`.

Document rows share one reference-id space with a namespace bag on
`globalThis`. Data streams work differently. Each `DataEncoder` call owns
a fresh writer with reference ids starting at 0. One self-contained root
frame leads, with settlement frames following for promises left
placeholder in the root. A promise that never settles holds its stream
open by design.

### Methods

- [encode](#encode)
- [encodeVNode](#encodevnode)

#### encode

Encode a value into a byte stream containing a single frame.

| Method | Type |
| ---------- | ---------- |
| `encode` | `(value: unknown) => ReadableStream<Uint8Array<ArrayBufferLike>>` |

#### encodeVNode

Encode a VNode (or VNode-shaped object) into a byte stream.

| Method | Type |
| ---------- | ---------- |
| `encodeVNode` | `(vnode: VNode<{}> or { type: unknown; props: unknown; key?: unknown; }) => ReadableStream<Uint8Array<ArrayBufferLike>>` |

## Types

- [ClientReferenceKind](#clientreferencekind)
- [EncoderOptions](#encoderoptions)

### ClientReferenceKind

| Type | Type |
| ---------- | ---------- |
| `ClientReferenceKind` | `component" or "function` |

### EncoderOptions

| Type | Type |
| ---------- | ---------- |
| `EncoderOptions` | `{ isClientReference?: (v: unknown) => boolean; /** * Throw on VNode `ref`s instead of warning. * * @default false (warn+skip refs; pass true to throw) */ strictRefs?: boolean; /** * Warn on non-reference functions instead of throwing. * * @default true (throw on non-reference functions; pass false to warn+skip) */ strictFunctions?: boolean; /** * Controls Error redaction. * * @default true (redact Error name/message/stack before serializing). * Pass false to serialize as-is, or a string to use a custom redacted * message. `cause` is always serialized (recursively). */ redactErrors?: boolean or string; }` |

