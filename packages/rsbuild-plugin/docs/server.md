## Constants

- [runtime](#runtime)

### runtime

Server-inlined runtime shim for `window.__pm`. It only queues calls; the
client bundle's `installModuleLoader` replaces it and loads the modules.
Pass it as the `runtime` option wherever the server renders client
references.

| Constant | Type |
| ---------- | ---------- |
| `runtime` | `string` |


