## Functions

- [default](#default)

### default

Server transform for `"use client"` boundaries.

A client reference stands in for code that lives in the browser. On the
server it calls like any other function, so client components render to
HTML during SSR. It never ships as code. At the wire it becomes a small
token naming where the implementation lives, and the browser resolves that
token back into the component or function from the referenced module.

Every reference carries the same metadata:

- `$type`: `Symbol.for("pp.client-reference")`, which identifies a reference.
- `$mod`: the module id exporting the implementation.
- `$name`: the export to look up inside that module.
- `$deps`: chunk dependencies to load before the module (build only).
- `$bound`: values captured from an outer server scope (scoped directives only).

A reference passes through three stages. This plugin creates it at build
time, as described below. The renderer serializes it at render time
(`renderToProgressiveStream`). The client resolves it at hydration time
(`prgressiveHydrate` / `Decoder`).

#### Module directives

`"use client"` at the top of a module marks every export as a client
reference. The server plugin rewrites each exported function into a call
to a small `__pp_create_ref` helper:

```tsx
"use client";

export function Counter({ initial = 0 }) {
  // ...
}
```

becomes roughly:

```tsx
"use client";

function Counter({ initial = 0 }) {
  // ...
}

const __pp_ref_Counter = __pp_create_ref(Counter, "Counter");

export { __pp_ref_Counter as Counter };
```

The helper returns a plain function that forwards calls to the original
with the metadata attached:

```ts
function __pp_create_ref(fn, name, bound) {
  var boundArgs = bound || [];
  var ref = function () {
    return fn.apply(this, boundArgs.concat(Array.prototype.slice.call(arguments)));
  };
  ref.$type = Symbol.for("pp.client-reference");
  ref.$mod = "<module id>";
  ref.$name = name;
  ref.$deps = ["<chunk deps>"];
  ref.$bound = boundArgs;
  ref.bind = function () {
    // returns a new reference with more bound arguments
  };
  return ref;
}
```

Re-exports follow the same path. `export { foo } from "./mod"` becomes an
import turned reference, re-exported under the same name. `export *` is
rejected, since statically unknowable names cannot become references.

#### Scoped directives

`"use client"` inside a function body hoists the function to the top of
the module and turns every free variable into a parameter:

```tsx
function makeHandler(x) {
  function handler(y) {
    "use client";

    return x + y;
  }
  return handler;
}
```

becomes:

```tsx
function _pp_hoisted_handler(x, y) {
  return x + y;
}

const __pp_ref_handler = __pp_create_ref(_pp_hoisted_handler, "_pp_hoisted_handler");

function makeHandler(x) {
  const handler = __pp_ref_handler.bind(null, x);
  return handler;
}
```

The hoisted function takes captured values first and real arguments after.
The definition site binds the reference over those values, which is how
they land in `$bound`. Module-scope bindings such as imports are never
captured, since they stay in scope after hoisting. Globals like `console`
are skipped for the same reason.

One hazard worth knowing: other transforms can demote a module-level
directive into a plain string statement, which is what happens when
`@preact/preset-vite` prepends imports above it. The server plugin revives
such statements into directives before branching on them.

#### Placeholders

Production server transforms cannot know chunk URLs, since the client
compiles after the server. References carry content-hashed placeholders
instead, derived from the module path relative to project root:

- `__PP_MOD__<sha256>` for the module chunk URL (`$mod`).
- `__PP_DEPS__<hash>` for the chunk dependencies to preload (`$deps`).

Dev skips placeholders. Module URLs resolve from the module graph, with
deps staying empty.

#### Server registration

Every reference site also registers its server implementation on
`globalThis.__pp_server_modules` under its `$mod`/`$name`, so
`virtual:server-load-module` can resolve client references on the server
(prerendering, server actions) without knowing every module up front and
without relying on bundled export names, which minifiers may mangle.
Both module-level and scoped sites register the ref (which forwards to
the implementation); the decoder derives bound copies through the ref's
own `.bind`, so decoded values stay client references that re-encode as
`$R` tokens. The `MOD` string travels through the same placeholder
rewriting as `$mod`, so registry keys match encoded references at runtime.

Options (passed as the second element of the `[plugin, options]` tuple):
`mod` is stamped into each reference's `$mod`, `deps` into `$deps`, and
`onTransformed` fires once when the file produced at least one reference
so the build plugin can record the module as a client entry.

| Function | Type |
| ---------- | ---------- |
| `default` | `(babel: PluginAPI) => PluginObject<PluginPass<{ mod: string; deps: string[]; onTransformed?: (() => void) or undefined; }>>` |


