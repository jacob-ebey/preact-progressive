## Functions

- [Router](#router)

### Router

Client navigation without document reloads. Same-document link clicks
re-fetch the component payload alone and swap it in.

```tsx
import { Router } from "preact-progressive/router";

<Router>{children}</Router>;
```

Render the `Router` inside the document shell so full loads and navigations
share one tree. The server has to answer `Accept: text/x-component` with a
component stream (see `dynamicDataResponses` and the Hono integration).

The bytes behind client navigation:

#### Content negotiation

One route serves two representations, and the `Accept` header picks between
them:

- Full document loads omit the header. `renderToProgressiveStream` answers
  with `text/html; charset=UTF-8`, chunked, `<!DOCTYPE html>` prefixed
  unless already present.
- Navigations send `Accept: text/x-component`. `DataEncoder` answers with
  `text/x-component; charset=UTF-8`.

The Hono `dynamicDataResponses()` middleware does the flagging. A matching
header sets `dataResponse: true` and appends `Vary: Accept`, and renderer
and shell branch on the flag. Shells must drop the document wrapper for
data responses, since a second `<html>` inside a navigation payload breaks
the swap.

The `Router` builds each navigation request itself with destination URL
plus navigation headers, abort signal, and a cache mode mapped from
`navigationType` (`traverse` → `force-cache`, `reload` → `reload`,
`push` / `replace` → `default`). It skips what it cannot intercept, plus
hash-only changes, downloads, and form data.

#### Data streams

Document rows share one reference-id space with a namespace bag on
`globalThis`. Data streams work differently. Each `DataEncoder` call owns
a fresh writer with reference ids starting at 0. One self-contained root
frame leads, with settlement frames following for promises left
placeholder in the root. A promise that never settles holds its stream
open by design.

`DataDecoder.decode(stream, onValue?)` reads incrementally, parsing each
newline-terminated frame on arrival. The root delivers through `onValue`
before close so hosts can paint early, while settlements apply to the same
parse context and resolve placeholders in place. The returned promise
resolves with the root on close. Malformed input rejects, whether trailing
bytes or an empty stream.

Module resolution here has no `__pm` inline scripts to lean on, since
those exist only in HTML responses. When the decoder imports a module
itself it mirrors `__pm`: it caches the load promise and exposes resolved
exports on the registry entry. Otherwise component lookups miss their
export and hang suspended forever.

#### Reconciliation

The `Router` wraps output in `Suspense` with no remount key. Preact
reconciles each navigation payload against the mounted tree, reusing
component instances and Suspense boundaries where they match. State
survives the swap instead of resetting with it. The `fallback` prop holds
the previous tree, and it shows while the incoming payload suspends.
Aborts from interrupted navigations fail silently, and everything else
logs.

| Function | Type |
| ---------- | ---------- |
| `Router` | `({ children, fetch, loadModule, }: { children?: ComponentChildren; fetch?: ((request: Request) => Promise<Response>) or undefined; loadModule?: LoadModule or undefined; }) => ComponentChildren` |

Parameters:

* `children`: - The current server-rendered tree, which the first
navigation payload replaces.
* `fetch`: - Receives the constructed `Request` carrying the destination
URL with navigation headers, abort signal, and a cache mode derived from
`navigationType`. Override it for tests or request prefixing.
* `loadModule`: - Module loader for client references in navigation
payloads; see `LoadModule`. Defaults to the `__pp` registry plus a dynamic
ESM `import()`.



