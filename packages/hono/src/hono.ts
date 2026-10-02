import type { Context, Env, MiddlewareHandler } from "hono";
import {
  createContext,
  Fragment,
  h,
  type ComponentChildren,
  type ComponentType,
  type FunctionComponent,
} from "preact";
import { useContext } from "preact/hooks";

import { renderToProgressiveStream } from "preact-progressive/server";
import { DataEncoder } from "preact-progressive/encoder";

export interface Props {}

declare module "hono" {
  interface ContextRenderer {
    (children: ComponentChildren, props?: Props): Response | Promise<Response>;
  }
}

type RendererOptions = Parameters<typeof renderToProgressiveStream>[1];

type BaseProps = {
  c: Context;
  children?: ComponentChildren;
};

type ComponentProps = Props &
  BaseProps & { Layout: ComponentType<Record<string, any> & { children?: ComponentChildren }> };

const DOCTYPE = "<!DOCTYPE html>";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const doctypeBytes = textEncoder.encode(DOCTYPE);

function hasDoctypePrefix(bytes: Uint8Array): boolean {
  if (bytes.length < doctypeBytes.length) return false;
  const prefix = textDecoder.decode(bytes.subarray(0, doctypeBytes.length));
  return prefix.toLowerCase() === DOCTYPE.toLowerCase();
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

/**
 * Prepends `<!DOCTYPE html>` to a rendered HTML stream unless the stream
 * already emits it as its first bytes.
 */
function ensureDoctype(
  stream: ReadableStream<Uint8Array> & { allReady?: Promise<void> },
): ReadableStream<Uint8Array> & { allReady?: Promise<void> } {
  let buffered: Uint8Array = new Uint8Array(0);
  let decided = false;

  const wrapped = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          if (decided) {
            controller.enqueue(value);
            continue;
          }

          buffered = concatBytes(buffered, value);
          if (buffered.length >= doctypeBytes.length) {
            decided = true;
            if (!hasDoctypePrefix(buffered)) {
              controller.enqueue(doctypeBytes);
            }
            controller.enqueue(buffered);
            buffered = new Uint8Array(0);
          }
        }

        if (!decided) {
          if (!hasDoctypePrefix(buffered)) {
            controller.enqueue(doctypeBytes);
          }
          if (buffered.length > 0) controller.enqueue(buffered);
        }

        controller.close();
      } catch (cause) {
        controller.error(cause);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return Object.assign(wrapped, { allReady: stream.allReady });
}

/** Request context shared with rendered components. Read it with `useRequestContext`. */
export const RequestContext = createContext<Context | null>(null);

/**
 * Renderer options already registered for a request. `preactRenderer` can be
 * installed more than once (the app shell first, then a route that overrides
 * the layout); a later call without options inherits the earlier ones —
 * notably `runtime` — instead of silently dropping them.
 */
const rendererOptionsByContext = new WeakMap<object, RendererOptions>();

const createRenderer =
  (
    c: Context,
    Layout: ComponentType<{ children?: ComponentChildren }>,
    component?: ComponentType<ComponentProps>,
    options?: RendererOptions,
  ) =>
  async (children: ComponentChildren, props?: Props) => {
    const node = component ? h(component, { children, Layout, c, ...props }) : children;
    const withContext = h(RequestContext.Provider, { value: c }, node);

    if (c.get("dataResponse") === true) {
      const encoder = new DataEncoder();
      const stream = encoder.encode(withContext);

      c.header("Transfer-Encoding", "chunked");
      c.header("Content-Type", "text/x-component; charset=UTF-8");

      return c.body(stream);
    }

    const stream = renderToProgressiveStream(withContext, options);

    c.header("Transfer-Encoding", "chunked");
    c.header("Content-Type", "text/html; charset=UTF-8");

    return c.body(ensureDoctype(stream));
  };

/**
 * Hono middleware that installs `c.render(children, props?)`.
 *
 * ```tsx
 * import { Hono } from "hono";
 * import { dynamicDataResponses, preactRenderer } from "hono-preact-progressive";
 *
 * const app = new Hono();
 *
 * app.use(
 *   dynamicDataResponses(),
 *   preactRenderer(({ children }) => <Shell>{children}</Shell>),
 * );
 *
 * app.get("/", (c) => c.render(<main>...</main>));
 * ```
 *
 * Order matters: `dynamicDataResponses()` runs before the renderer so
 * `c.get("dataResponse")` is set in time.
 *
 * - With a `component`, every `c.render()` mounts
 *   `h(component, { children, Layout, c, ...props })` as the shell. Without
 *   one, children render bare.
 * - `Layout` is whatever `c.getLayout()` returns (default `Fragment`), so
 *   nested layouts compose.
 * - HTML path: `renderToProgressiveStream` with the given `options`
 *   (`namespace`, `nonce`, `prerender`, `runtime`), served as
 *   `text/html; charset=UTF-8`, chunked, with a `<!DOCTYPE html>` prefix
 *   unless already present.
 * - Data path, when `c.get("dataResponse") === true`: the same tree through
 *   `DataEncoder`, served as `text/x-component; charset=UTF-8`. This is the
 *   data half of content negotiation behind client navigation: one route
 *   serves two representations and the `Accept` header picks between them.
 * - The tree sits inside a `RequestContext` provider, so any component can
 *   call `useRequestContext()`.
 *
 * `c.render` returns a `Response` (or `Promise<Response>`). Return it
 * straight from handlers.
 */
export const preactRenderer = (
  component?: FunctionComponent<ComponentProps>,
  options?: RendererOptions,
): MiddlewareHandler =>
  function preactRenderer(c, next) {
    const Layout = (c.getLayout() ?? Fragment) as FunctionComponent<{
      children?: ComponentChildren;
    }>;
    const rendererOptions = options ?? rendererOptionsByContext.get(c);
    if (options) rendererOptionsByContext.set(c, options);
    if (component) {
      c.setLayout((props: any) => {
        return component({ ...props, Layout, c });
      });
    }
    c.setRenderer(createRenderer(c, Layout, component, rendererOptions));
    return next();
  };

/**
 * Returns the current Hono `Context` inside any component the
 * `preactRenderer` rendered, and throws outside that provider. It reaches
 * request headers and params, plus the `dataResponse` flag.
 *
 * ```ts
 * const c = useRequestContext();
 * c.req.header("Accept");
 * c.get("dataResponse");
 * ```
 */
export const useRequestContext = <E extends Env = any>(): Context<E> => {
  const c = useContext(RequestContext);
  if (!c) {
    throw new Error("RequestContext is not provided.");
  }
  return c;
};

/**
 * Flags navigation requests. An `Accept` header containing
 * `text/x-component` sets `c.set("dataResponse", true)` and appends
 * `Vary: Accept`. Renderer and shell branch on that flag.
 *
 * Shells must drop the document wrapper for data responses, because a second
 * `<html>` inside a navigation payload breaks the swap:
 *
 * ```tsx
 * function Shell({ children }) {
 *   const c = useRequestContext();
 *   if (c.get("dataResponse")) return children;
 *   return (
 *     <html lang="en">
 *       <body>
 *         <Router>{children}</Router>
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */
export const dynamicDataResponses = (): MiddlewareHandler => (c, next) => {
  if (c.req.header("Accept")?.match(/\btext\/x-component\b/)) {
    c.set("dataResponse", true);
    c.header("Vary", "Accept", { append: true });
  }
  return next();
};
