## Functions

- [installModuleLoader](#installmoduleloader)
- [loadModule](#loadmodule)

### installModuleLoader

Installs the JSONP-backed `window.__pm` and flushes any calls the
server-inlined shim queued before the client bundle ran.
Idempotent; safe to call from multiple entries.

| Function | Type |
| ---------- | ---------- |
| `installModuleLoader` | `() => void` |

### loadModule

`LoadModule` implementation for Rsbuild/Rspack JSONP chunks. Resolves the
named export synchronously when the chunk has already loaded, otherwise
returns the load promise.

```ts
import { prgressiveHydrate } from "preact-progressive/client";
import { loadModule } from "rsbuild-plugin-preact-progressive/client";

prgressiveHydrate(document.documentElement, { loadModule });
```

| Function | Type |
| ---------- | ---------- |
| `loadModule` | `(mod: string, name: string) => unknown` |


