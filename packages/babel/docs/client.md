## Functions

- [default](#default)

### default

Client transform for `"use client"` boundaries.

Mirrors the server transform's module/scoped directive handling, but
instead of creating client references it strips directives and keeps only
the browser implementation:

- A module-level `"use client"` keeps every export as-is and drops the
  directive. No `__pp_create_ref` helper is emitted; the module already
  *is* the implementation the server's reference token names.
- A scoped `"use client"` hoists the function to the top of the module
  (free variables become leading parameters, exactly as on the server) and
  exports the hoisted function, so the client chunk exposes the same
  export name the reference's `$name` points at. Server-only code around
  the definition site is treeshaken: unreachable top-level bindings, their
  imports, and side-effect statements referencing only removed bindings are
  dropped, with export roots driving reachability.

Like the server transform, demoted module-level directives (a plain
`"use client"` string statement left behind when another transform
prepends imports above it) are revived into real directives before
branching.

| Function | Type |
| ---------- | ---------- |
| `default` | `(babel: PluginAPI) => PluginObject` |


