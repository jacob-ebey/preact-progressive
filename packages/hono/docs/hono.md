## Functions

- [preactRenderer](#preactrenderer)
- [useRequestContext](#userequestcontext)
- [dynamicDataResponses](#dynamicdataresponses)

### preactRenderer

Hono middleware that installs `c.render(children, props?)`.

```tsx
import { Hono } from "hono";
import { dynamicDataResponses, preactRenderer } from "hono-preact-progressive";

const app = new Hono();

app.use(
  dynamicDataResponses(),
  preactRenderer(({ children }) => <Shell>{children}</Shell>),
);

app.get("/", (c) => c.render(<main>...</main>));
```

Order matters: `dynamicDataResponses()` runs before the renderer so
`c.get("dataResponse")` is set in time.

- With a `component`, every `c.render()` mounts
  `h(component, { children, Layout, c, ...props })` as the shell. Without
  one, children render bare.
- `Layout` is whatever `c.getLayout()` returns (default `Fragment`), so
  nested layouts compose.
- HTML path: `renderToProgressiveStream` with the given `options`
  (`namespace`, `nonce`, `prerender`, `runtime`), served as
  `text/html; charset=UTF-8`, chunked, with a `<!DOCTYPE html>` prefix
  unless already present.
- Data path, when `c.get("dataResponse") === true`: the same tree through
  `DataEncoder`, served as `text/x-component; charset=UTF-8`. This is the
  data half of content negotiation behind client navigation: one route
  serves two representations and the `Accept` header picks between them.
- The tree sits inside a `RequestContext` provider, so any component can
  call `useRequestContext()`.

`c.render` returns a `Response` (or `Promise<Response>`). Return it
straight from handlers.

| Function | Type |
| ---------- | ---------- |
| `preactRenderer` | `(component?: FunctionComponent<ComponentProps> or undefined, options?: { namespace?: string or undefined; nonce?: string or undefined; prerender?: boolean or undefined; runtime?: string or undefined; } or undefined) => MiddlewareHandler` |

### useRequestContext

Returns the current Hono `Context` inside any component the
`preactRenderer` rendered, and throws outside that provider. It reaches
request headers and params, plus the `dataResponse` flag.

```ts
const c = useRequestContext();
c.req.header("Accept");
c.get("dataResponse");
```

| Function | Type |
| ---------- | ---------- |
| `useRequestContext` | `<E extends Env = any>() => Context<E, any, {}>` |

### dynamicDataResponses

Flags navigation requests. An `Accept` header containing
`text/x-component` sets `c.set("dataResponse", true)` and appends
`Vary: Accept`. Renderer and shell branch on that flag.

Shells must drop the document wrapper for data responses, because a second
`<html>` inside a navigation payload breaks the swap:

```tsx
function Shell({ children }) {
  const c = useRequestContext();
  if (c.get("dataResponse")) return children;
  return (
    <html lang="en">
      <body>
        <Router>{children}</Router>
      </body>
    </html>
  );
}
```

| Function | Type |
| ---------- | ---------- |
| `dynamicDataResponses` | `() => MiddlewareHandler` |


## Constants

- [RequestContext](#requestcontext)

### RequestContext

Request context shared with rendered components. Read it with `useRequestContext`.

| Constant | Type |
| ---------- | ---------- |
| `RequestContext` | `Context<Context<any, any, {}> or null>` |



## Interfaces

- [Props](#props)

### Props



| Property | Type | Description |
| ---------- | ---------- | ---------- |

