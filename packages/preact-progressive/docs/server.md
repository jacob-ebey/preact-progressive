## Functions

- [isClientReference](#isclientreference)
- [renderToProgressiveStream](#rendertoprogressivestream)

### isClientReference

Type guard for client references. Never compare `$type` by hand.

| Function | Type |
| ---------- | ---------- |
| `isClientReference` | `(v: unknown) => v is ClientReference` |

### renderToProgressiveStream

Turns a component tree into streaming HTML.

References cross the wire at render time, never at build time. The
renderer hooks preact's vnode pipeline and inspects each element it
renders. Position decides the path, and there are exactly two of them.

#### Components: `<Comp />`

A reference in JSX type position becomes an island. The server renders the
component to HTML like any other and wraps that HTML in comment markers.
It encodes the vnode into a data row, then emits an inline script that
stores the row while loading the module.

```html
<!--h:P0-0 ["__pd","/test.js","ClientComponent"]-->
<div>Hello, World P0-1!</div>
<script>
  // runtime + module registration
  window.__pp ??= {};
  window.__pm ??= (m, ...d) => {
    // imports m, caches {p, m}
  };
  window.__pm("/test.js");

  // encoded island row
  globalThis["__pd"] ??= {};
  globalThis["__pd"].d ??= {};
  globalThis["__pd"].d["P0-0"] =
    'P["$V",P["$R","component","/test.js","ClientComponent"],null,{}]\n';

  document.currentScript?.remove();
</script>
<!--/h:P0-0-->
```

The open marker carries JSON: namespace, module, export name. The id
(`P0-0`) comes from preact's `useId()` and doubles as the row name in the
payload store, which is how the client finds the data for an island.

The runtime and each module emit once per response. The runtime sets up
the module registry (`window.__pp`) and the loader (`window.__pm`), which
imports chunk dependencies first and then the module itself while caching
the load promise and the resolved exports.

Island facts worth holding onto:

- Only the outermost boundary becomes an island. Nested client components
  render inline, so a page gets one island per top-level client component
  rather than one per element.
- Server components inside the encoded tree render at encode time. Only
  their output travels, and their code never ships.
- Payloads hold data, not JavaScript, so nothing in them executes at
  decode time.
- The rest of the page is static HTML with no client JavaScript beyond
  these scripts.

The island subtree renders under an `inClient` flag, so nested client
references stay inline and open no new islands.

#### Events: `onClick={handler}`

A reference in an `on*` prop on a DOM element takes the other path. The
server strips the prop from the markup and emits a small script that wires
the event directly:

```html
<button id="event">Alert</button>
<script>
  window.__pp ??= {};
  window.__pm ??= (m, ...d) => {
    // imports m, caches {p, m}
  };
  document.currentScript.previousElementSibling.addEventListener("click", function () {
    return window.__pp?.["/alert.ts"]?.m?.["handleAlert"](...arguments);
  });
  window.__pm("/alert.ts");
  document.currentScript?.remove();
</script>
```

The script sits directly after the element, so `previousElementSibling` is
the element itself. Event names drop the `on` prefix and lowercase the
rest, turning `onClick` into `click` and `onKeyDown` into `keydown`.

This path skips hydration entirely. The element works as soon as the
script runs, and the handler resolves from the module registry at call
time. Only the module id and export name travel here, while values
captured by a scoped directive travel on the data path inside an island's
encoded tree.

Scoped captures on the event path inline as synchronous JavaScript
literals, since no decoder runs inside a standalone listener. Anything
with a literal spelling travels. Nested client references work too,
resolving at call time like the handler itself. The rest throws.
Non-reference functions have no literal form, and neither do promises or
circular values. Silence would shift arguments left and land the DOM event
in the wrong parameter. Inline strings escape `<` as `\u003c`, so values
can never close their host `<script>` tag, and a `"__proto__"` key stays
an own property through the computed form.

#### Streaming settlements

Promise placeholders claimed during encoding queue up per row. The HTML
stream wears a wrapper (`streamWithSettlements`) that drains them: after
each HTML chunk it flushes already-settled promises without blocking, and
once the HTML ends it makes a final blocking pass for stragglers. Each
settlement leaves as a `<script>` chunk that appends a result frame to the
stored row and then calls into the namespace hook (`ns.f(row)`), so the
client applies it on the spot. Rows added by Suspense retries join the
next drain pass.

- `namespace`: the row store at `globalThis[namespace].d[id]`. One
  namespace per response, shared by islands and settlement frames.
- `nonce`: applied to emitted inline `<script nonce="...">` for CSP. Leave
  it out without a CSP.
- `prerender`: `true` buffers through `renderToStringAsync` into a single
  chunk instead of `renderToReadableStream`. Static output and tests want
  this.
- `runtime`: override for the `window.__pp` / `window.__pm` loader source.
  Defaults to the bundled `virtual:client-runtime`.

Settlements drain beside the HTML. Already-settled promises flush after
each HTML chunk without blocking, and anything still outstanding flushes
once the HTML ends, blocking. `allReady` resolves when the stream,
settlements included, is fully delivered.

Client references render inside this call only. Outside it they throw.

| Function | Type |
| ---------- | ---------- |
| `renderToProgressiveStream` | `(vnode: ComponentChildren, { namespace, nonce, prerender, runtime, }?: { namespace?: string or undefined; nonce?: string or undefined; prerender?: boolean or undefined; runtime?: string or undefined; }) => RenderStream` |


## Constants

- [CLIENT_REFERENCE](#client_reference)

### CLIENT_REFERENCE

Marker identifying a client reference.

Every reference carries the same metadata (see `ClientReference`).
A reference passes through three stages: the babel plugin creates it at
build time, the renderer serializes it at render time
(`renderToProgressiveStream`), and the client resolves it at hydration
time (`prgressiveHydrate` / `Decoder`).

| Constant | Type |
| ---------- | ---------- |
| `CLIENT_REFERENCE` | `unique symbol` |



## Types

- [ClientReference](#clientreference)

### ClientReference

A client reference stands in for code that lives in the browser.

On the server it calls like any other function, so client components
render to HTML during SSR. It never ships as code. At the wire it becomes
a small token naming where the implementation lives, and the browser
resolves that token back into the component or function from the
referenced module.

Every reference carries the same metadata:

- `$type`: `Symbol.for("pp.client-reference")`, which identifies a reference.
- `$mod`: the module id exporting the implementation.
- `$name`: the export to look up inside that module.
- `$deps`: chunk dependencies to load before the module (build only).
- `$bound`: values captured from an outer server scope (scoped directives
  only). Bound values prepend to props or call arguments on decode.

Use `isClientReference(v)` as the type guard. Never compare `$type` by hand.

Declaring boundaries (`"use client"` module vs scoped directives, the
`__pp_create_ref` helper shape, hoisting, and `$bound` capture rules) is
documented on the babel server transform.

| Type | Type |
| ---------- | ---------- |
| `ClientReference` | `{ $type: typeof CLIENT_REFERENCE; $mod: string; $name: string; $deps?: string[]; $bound?: unknown[]; }` |

