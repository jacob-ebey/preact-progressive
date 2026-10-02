## Functions

- [prgressiveHydrate](#prgressivehydrate)

### prgressiveHydrate

Hydrates server-rendered islands in place. Import it once in the client
entry and call it once, on the document element. Per island it is
idempotent.

How the client converts island markers and payload rows into live
components. `prgressiveHydrate` scans the document for island markers and
pairs each open with its close. Each island runs the same pipeline:

1. `preload(id)` walks the row and constructs nothing. It collects `$R`
   module ids, including through references into other rows, and ensures
   each module load promise exists, importing through `__pm` where needed.
   Modules load before decode, so component references resolve to
   implementations directly and hydration never suspends.
2. `decode(id)` parses the row into a live tree. `P["$V"]` becomes a
   preact vnode through `h()`, and `P["$R"]` becomes a resolved reference.
   Component kind means the loaded export when present, else a `lazy()`
   wrapper that resolves on module load. Function kind means the loaded
   export when present, else a function resolving the module at call time.
   `$bound` values prepend to props or call arguments.
3. The decoded tree hydrates into the nodes between the markers with
   preact's `hydrate`, and the island marks done.

Loaded modules return implementations directly, so initial hydration
suspends on nothing. That directness matters because preact `lazy` always
throws once on first render, which would mis-hydrate sibling DOM.

#### Late islands

Some islands arrive after first parse, mid-stream or mid-suspense, and a
`MutationObserver` catches them. The scan re-runs from scratch on every
mutation batch until `document.readyState === "complete"`. Fresh scans are
necessary because streaming moves markers into place after the initial
parse, where a live iterator would never revisit regions it already
passed. The scan stays idempotent, with a `hydrated` set blocking
double-hydration.

Islands inside an in-flight navigation shell wait their turn. Their
markers reach the tree when the shell's buffered children land between
the transport markers, and hydrating any earlier would race that move. The
post-swap pass collects them at their real position.

#### Settlements after hydration

Settlement frames keep streaming after islands decode, and a hook on the
namespace (`ns.f`) applies them by calling `pump(row)`, which parses only
newly appended frames. Each frame carries its own base header, and
placeholders resolve or reject as their frames land.

Application order does not matter. A frame that outruns its placeholder
stashes until the placeholder materializes. Hydration waits out
placeholders its own decode created, so no timing handshake with the
transport runs anywhere.

#### Suspense ownership

Suspense segments belong to preact, and the client keeps its hands off.
Server segments stream as `<!--$s:id-->fallback<!--/$s:id-->`. When a
segment suspends at hydration, core parks it: server markup stays mounted
and the fallback stays out. Never strip those markers or re-run hydrate
on suspension. On settlement the subtree force-updates and hydrates
whatever the transport swap placed there.

#### Module registry

Each HTML response emits the loader once:

- `window.__pp[mod] = { p: Promise, m: exports }`, the load promise plus
  resolved exports.
- `window.__pm(mod, ...deps)`, which imports chunk dependencies first and
  then the module, caching both. Repeat calls are safe (`??=`).

Preloading gathers every referenced module id before decode, so component
references resolve directly and first-render hydration never suspends.

Note the export keeps its historical spelling (`prgressiveHydrate`, one
`o`), so import it exactly as shown.

| Function | Type |
| ---------- | ---------- |
| `prgressiveHydrate` | `(element: Element, options?: DecoderOptions) => void` |

Parameters:

* `element`: - The subtree to scan for island markers; usually
`document.documentElement`.
* `options`: - Decoder options shared by every island, including the
client-reference module loader; see `DecoderOptions`.



