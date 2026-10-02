import {
  createContext,
  Fragment,
  h,
  options,
  type ComponentChildren,
  type FunctionComponent,
  type VNode,
} from "preact";
import { useContext, useId } from "preact/hooks";
import { renderToStringAsync } from "preact-render-to-string";
import { renderToReadableStream } from "preact-render-to-string/stream";

import { Encoder } from "./encoder.ts";

// @ts-ignore
import defaultRuntime from "virtual:client-runtime";

/**
 * Marker identifying a client reference.
 *
 * Every reference carries the same metadata (see `ClientReference`).
 * A reference passes through three stages: the babel plugin creates it at
 * build time, the renderer serializes it at render time
 * (`renderToProgressiveStream`), and the client resolves it at hydration
 * time (`prgressiveHydrate` / `Decoder`).
 */
export const CLIENT_REFERENCE = Symbol.for("pp.client-reference");

/**
 * A client reference stands in for code that lives in the browser.
 *
 * On the server it calls like any other function, so client components
 * render to HTML during SSR. It never ships as code. At the wire it becomes
 * a small token naming where the implementation lives, and the browser
 * resolves that token back into the component or function from the
 * referenced module.
 *
 * Every reference carries the same metadata:
 *
 * - `$type`: `Symbol.for("pp.client-reference")`, which identifies a reference.
 * - `$mod`: the module id exporting the implementation.
 * - `$name`: the export to look up inside that module.
 * - `$deps`: chunk dependencies to load before the module (build only).
 * - `$bound`: values captured from an outer server scope (scoped directives
 *   only). Bound values prepend to props or call arguments on decode.
 *
 * Use `isClientReference(v)` as the type guard. Never compare `$type` by hand.
 *
 * Declaring boundaries (`"use client"` module vs scoped directives, the
 * `__pp_create_ref` helper shape, hoisting, and `$bound` capture rules) is
 * documented on the babel server transform.
 */
export type ClientReference = {
  $type: typeof CLIENT_REFERENCE;
  $mod: string;
  $name: string;
  $deps?: string[];
  $bound?: unknown[];
};

/**
 * Type guard for client references. Never compare `$type` by hand.
 */
export function isClientReference(v: unknown): v is ClientReference {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    "$type" in v &&
    v.$type === CLIENT_REFERENCE
  );
}

function encodeClientEvent(event: string, clientReference: ClientReference) {
  const bound = Array.isArray(clientReference.$bound) ? clientReference.$bound : [];
  const boundCode = bound.length === 0 ? "" : `${serializeBoundArgs(bound)},`;
  return [
    `document.currentScript.previousElementSibling.addEventListener(${JSON.stringify(event)},function(){`,
    `return window.__pp?.[${JSON.stringify(clientReference.$mod)}]?.m?.[${JSON.stringify(clientReference.$name)}](${boundCode}...arguments);`,
    "});",
  ].join("");
}

/**
 * Serialize manually-bound scope values (from `ref.bind(null, ...args)` on a
 * `"use client"` function) as inline JavaScript for a DOM event listener.
 *
 * Unlike island props — which travel through the `Encoder` wire protocol and
 * are rebuilt by the `Decoder` — an event listener is a standalone inline
 * script with no decoder available, so its bound arguments must be
 * synchronous JS literals. This covers the same value range as the encoder
 * wherever a literal form exists; values with no literal form (functions,
 * promises, circular values) throw instead of being silently dropped, since dropping
 * an argument would shift every later argument left and deliver the DOM
 * event into the wrong parameter.
 */
function serializeBoundArgs(bound: unknown[]): string {
  const seen = new Set<object>();
  return bound.map((value) => serializeInlineValue(value, seen)).join(",");
}

/** Escape `<` inside an emitted string literal so inlined values can never
 * close their host `<script>` element (`</script>`) or open HTML comments
 * (`<!--`). `\u003c` unescapes back to "<" when the listener runs. */
function escapeInlineString(str: string): string {
  return JSON.stringify(str).replace(/</g, "\\u003c");
}

function bytesLiteral(view: Uint8Array): string {
  let out = "";
  for (let i = 0; i < view.length; i++) out += (i > 0 ? "," : "") + String(view[i]);
  return `[${out}]`;
}

/** Inline-literal form of a nested client reference value: resolves the
 * module export at call time and prepends its own bound scope values, exactly
 * like the decoder's `applyBound` does for references inside island trees. */
function serializeInlineReference(ref: ClientReference, seen: Set<object>): string {
  const nested = Array.isArray(ref.$bound) ? ref.$bound : [];
  const nestedCode =
    nested.length === 0 ? "" : `${nested.map((v) => serializeInlineValue(v, seen)).join(",")},`;
  return `(...__pp_args)=>window.__pp?.[${JSON.stringify(ref.$mod)}]?.m?.[${JSON.stringify(ref.$name)}](${nestedCode}...__pp_args)`;
}

function serializeInlineValue(value: unknown, seen: Set<object>): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "NaN";
      if (value === Infinity) return "Infinity";
      if (value === -Infinity) return "-Infinity";
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${String(value)}n`;
    case "string":
      return escapeInlineString(value);
    case "symbol": {
      const key = Symbol.keyFor(value);
      if (key === undefined) {
        throw new Error(
          `Cannot serialize symbol "${String(value)}" as a bound argument of a "use client" event handler. Only Symbol.for() symbols are supported.`,
        );
      }
      return `Symbol.for(${escapeInlineString(key)})`;
    }
    case "function":
      if (isClientReference(value)) return serializeInlineReference(value, seen);
      throw new Error(
        `Cannot serialize a function as a bound argument of a "use client" event handler. Move it behind a "use client" boundary and pass serializable data instead. (got ${(value as { name?: string }).name ?? "<anonymous>"})`,
      );
    case "object":
      break;
    default:
      throw new Error(
        `Cannot serialize a ${typeof value} value as a bound argument of a "use client" event handler.`,
      );
  }

  const obj = value as object;
  if (isClientReference(obj)) return serializeInlineReference(obj as ClientReference, seen);
  if (typeof (obj as { then?: unknown }).then === "function") {
    throw new Error(
      'Cannot serialize a promise as a bound argument of a "use client" event handler. Pass the settled value via island props instead.',
    );
  }
  if (seen.has(obj)) {
    throw new Error(
      'Cannot serialize a circular value as a bound argument of a "use client" event handler.',
    );
  }
  seen.add(obj);
  try {
    if (obj instanceof Date) {
      const time = obj.getTime();
      return Number.isNaN(time) ? "new Date(NaN)" : `new Date(${escapeInlineString(obj.toJSON())})`;
    }
    if (obj instanceof URL) return `new URL(${escapeInlineString(obj.href)})`;
    if (obj instanceof RegExp) {
      return `new RegExp(${escapeInlineString(obj.source)},${escapeInlineString(obj.flags)})`;
    }
    if (obj instanceof Map) {
      const pairs: string[] = [];
      for (const [k, v] of obj) {
        pairs.push(`[${serializeInlineValue(k, seen)},${serializeInlineValue(v, seen)}]`);
      }
      return `new Map([${pairs.join(",")}])`;
    }
    if (obj instanceof Set) {
      const items: string[] = [];
      for (const v of obj) items.push(serializeInlineValue(v, seen));
      return `new Set([${items.join(",")}])`;
    }
    if (obj instanceof ArrayBuffer)
      return `new Uint8Array(${bytesLiteral(new Uint8Array(obj))}).buffer`;
    if (ArrayBuffer.isView(obj)) {
      if (obj instanceof DataView) {
        return `new DataView(new Uint8Array(${bytesLiteral(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength))}).buffer)`;
      }
      const ctor = (obj as { constructor: { name?: string } }).constructor.name;
      if (ctor === "BigInt64Array" || ctor === "BigUint64Array") {
        return `new ${ctor}([${Array.from(obj as unknown as BigInt64Array)
          .map((n) => `${String(n)}n`)
          .join(",")}])`;
      }
      return `new ${ctor}(${bytesLiteral(new Uint8Array((obj as unknown as Uint8Array).buffer, (obj as unknown as Uint8Array).byteOffset, (obj as unknown as Uint8Array).byteLength))})`;
    }
    if (Array.isArray(obj)) {
      const items: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        items.push(i in obj ? serializeInlineValue((obj as unknown[])[i], seen) : "undefined");
      }
      return `[${items.join(",")}]`;
    }
    // Plain-ish objects travel as their own enumerable string-keyed entries
    // (matching the encoder, which also drops symbol keys with a warning).
    // Every key uses the computed form so a "__proto__" entry stays an own
    // property instead of replacing the object's prototype.
    const symbols = Object.getOwnPropertySymbols(obj);
    if (symbols.length > 0) {
      console.warn("Skipping symbol-keyed properties during serialization.");
    }
    const props: string[] = [];
    for (const [key, propValue] of Object.entries(obj)) {
      props.push(`[${escapeInlineString(key)}]:${serializeInlineValue(propValue, seen)}`);
    }
    return `{${props.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

type EncodeProps = (id: string, obj: any) => void;

/** Mirrors preact-render-to-string's `RenderStream` shape. */
type RenderStream = ReadableStream<Uint8Array> & { allReady: Promise<void> };

/**
 * Streams the rendered HTML through, draining each encoded row's promise
 * settlements into the same response as `<script>` chunks appending
 * `!<id>` result frames. Without these chunks, promise placeholders decoded
 * on the client would never settle.
 *
 * Settlements are flushed as they are generated: after every HTML chunk the
 * encoder's already-settled promises are drained (non-blocking), and once
 * the HTML stream ends a final blocking pass delivers anything still
 * outstanding. Nothing waits for the whole HTML stream before shipping a
 * settlement — a Suspense island whose prop resolves mid-stream gets its
 * result frame immediately after the chunk carrying its payload script.
 */
function streamWithSettlements(
  html: ReadableStream<Uint8Array>,
  encoder: Encoder,
  rows: string[],
  nonce?: string,
): RenderStream {
  const text = new TextEncoder();
  let signalReady!: () => void;
  const allReady = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  return Object.assign(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = html.getReader();
        const enqueue = (chunk: string) => controller.enqueue(text.encode(chunk));
        // Drains every row currently known; rows added by suspense retries
        // (encoded while a chunk was being produced) are picked up on the
        // next pass. `wait` blocks on unsettled promises (final drain) or
        // yields only already-captured settlements (mid-stream drain).
        const drain = async (wait: boolean) => {
          for (const row of rows) {
            for await (const chunk of encoder.flush(row, true, nonce, wait)) {
              enqueue(chunk);
            }
          }
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            await drain(false);
          }
          await drain(true);
          controller.close();
        } catch (cause) {
          controller.error(cause);
        } finally {
          reader.releaseLock();
          signalReady();
        }
      },
    }),
    { allReady },
  );
}

const Progressive = createContext<{
  encodeProps: EncodeProps;
  flushedMods: Set<string>;
  flushedRuntime?: boolean;
  inClient?: boolean;
} | null>(null);

/**
 * Turns a component tree into streaming HTML.
 *
 * References cross the wire at render time, never at build time. The
 * renderer hooks preact's vnode pipeline and inspects each element it
 * renders. Position decides the path, and there are exactly two of them.
 *
 * #### Components: `<Comp />`
 *
 * A reference in JSX type position becomes an island. The server renders the
 * component to HTML like any other and wraps that HTML in comment markers.
 * It encodes the vnode into a data row, then emits an inline script that
 * stores the row while loading the module.
 *
 * ```html
 * <!--h:P0-0 ["__pd","/test.js","ClientComponent"]-->
 * <div>Hello, World P0-1!</div>
 * <script>
 *   // runtime + module registration
 *   window.__pp ??= {};
 *   window.__pm ??= (m, ...d) => {
 *     // imports m, caches {p, m}
 *   };
 *   window.__pm("/test.js");
 *
 *   // encoded island row
 *   globalThis["__pd"] ??= {};
 *   globalThis["__pd"].d ??= {};
 *   globalThis["__pd"].d["P0-0"] =
 *     'P["$V",P["$R","component","/test.js","ClientComponent"],null,{}]\n';
 *
 *   document.currentScript?.remove();
 * </script>
 * <!--/h:P0-0-->
 * ```
 *
 * The open marker carries JSON: namespace, module, export name. The id
 * (`P0-0`) comes from preact's `useId()` and doubles as the row name in the
 * payload store, which is how the client finds the data for an island.
 *
 * The runtime and each module emit once per response. The runtime sets up
 * the module registry (`window.__pp`) and the loader (`window.__pm`), which
 * imports chunk dependencies first and then the module itself while caching
 * the load promise and the resolved exports.
 *
 * Island facts worth holding onto:
 *
 * - Only the outermost boundary becomes an island. Nested client components
 *   render inline, so a page gets one island per top-level client component
 *   rather than one per element.
 * - Server components inside the encoded tree render at encode time. Only
 *   their output travels, and their code never ships.
 * - Payloads hold data, not JavaScript, so nothing in them executes at
 *   decode time.
 * - The rest of the page is static HTML with no client JavaScript beyond
 *   these scripts.
 *
 * The island subtree renders under an `inClient` flag, so nested client
 * references stay inline and open no new islands.
 *
 * #### Events: `onClick={handler}`
 *
 * A reference in an `on*` prop on a DOM element takes the other path. The
 * server strips the prop from the markup and emits a small script that wires
 * the event directly:
 *
 * ```html
 * <button id="event">Alert</button>
 * <script>
 *   window.__pp ??= {};
 *   window.__pm ??= (m, ...d) => {
 *     // imports m, caches {p, m}
 *   };
 *   document.currentScript.previousElementSibling.addEventListener("click", function () {
 *     return window.__pp?.["/alert.ts"]?.m?.["handleAlert"](...arguments);
 *   });
 *   window.__pm("/alert.ts");
 *   document.currentScript?.remove();
 * </script>
 * ```
 *
 * The script sits directly after the element, so `previousElementSibling` is
 * the element itself. Event names drop the `on` prefix and lowercase the
 * rest, turning `onClick` into `click` and `onKeyDown` into `keydown`.
 *
 * This path skips hydration entirely. The element works as soon as the
 * script runs, and the handler resolves from the module registry at call
 * time. Only the module id and export name travel here, while values
 * captured by a scoped directive travel on the data path inside an island's
 * encoded tree.
 *
 * Scoped captures on the event path inline as synchronous JavaScript
 * literals, since no decoder runs inside a standalone listener. Anything
 * with a literal spelling travels. Nested client references work too,
 * resolving at call time like the handler itself. The rest throws.
 * Non-reference functions have no literal form, and neither do promises or
 * circular values. Silence would shift arguments left and land the DOM event
 * in the wrong parameter. Inline strings escape `<` as `\u003c`, so values
 * can never close their host `<script>` tag, and a `"__proto__"` key stays
 * an own property through the computed form.
 *
 * #### Streaming settlements
 *
 * Promise placeholders claimed during encoding queue up per row. The HTML
 * stream wears a wrapper (`streamWithSettlements`) that drains them: after
 * each HTML chunk it flushes already-settled promises without blocking, and
 * once the HTML ends it makes a final blocking pass for stragglers. Each
 * settlement leaves as a `<script>` chunk that appends a result frame to the
 * stored row and then calls into the namespace hook (`ns.f(row)`), so the
 * client applies it on the spot. Rows added by Suspense retries join the
 * next drain pass.
 *
 * - `namespace`: the row store at `globalThis[namespace].d[id]`. One
 *   namespace per response, shared by islands and settlement frames.
 * - `nonce`: applied to emitted inline `<script nonce="...">` for CSP. Leave
 *   it out without a CSP.
 * - `prerender`: `true` buffers through `renderToStringAsync` into a single
 *   chunk instead of `renderToReadableStream`. Static output and tests want
 *   this.
 * - `runtime`: override for the `window.__pp` / `window.__pm` loader source.
 *   Defaults to the bundled `virtual:client-runtime`.
 *
 * Settlements drain beside the HTML. Already-settled promises flush after
 * each HTML chunk without blocking, and anything still outstanding flushes
 * once the HTML ends, blocking. `allReady` resolves when the stream,
 * settlements included, is fully delivered.
 *
 * Client references render inside this call only. Outside it they throw.
 */
export function renderToProgressiveStream(
  vnode: ComponentChildren,
  {
    namespace = "__pd",
    nonce,
    prerender,
    runtime,
  }: {
    namespace?: string;
    nonce?: string;
    prerender?: boolean;
    runtime?: string;
  } = {},
) {
  const encoder = new Encoder(namespace, { isClientReference });
  // Row names handed to encodeVNode; each may carry promise placeholders
  // whose settlement frames are streamed after the HTML.
  const encodedRows: string[] = [];

  const otherB = (options as any).__b;

  const getNeededRuntime = (ctx: { flushedRuntime?: boolean }) => {
    if (!ctx.flushedRuntime) {
      ctx.flushedRuntime = true;
      return runtime ?? defaultRuntime;
    }
    return "";
  };

  try {
    (options as any).__b = function (vnode: VNode<any>) {
      otherB?.(...arguments);

      const Type = vnode.type;
      if (typeof Type === "string") {
        let i, v;
        let neededScripts = "";
        let references: ClientReference[] = [];
        for (i in vnode.props) {
          v = vnode.props[i];
          if (i.startsWith("on") && isClientReference(v)) {
            vnode.props[i] = undefined;
            neededScripts += encodeClientEvent(i[2].toLowerCase() + i.slice(3), v);
            references.push(v);
          }
        }

        if (references.length === 0) return;

        vnode.type = () => {
          const ctx = useContext(Progressive);
          if (!ctx)
            throw new Error("Client references must be rendered with renderToProgressiveStream");

          let neededRuntime = getNeededRuntime(ctx) + neededScripts;
          for (const ref of references) {
            if (!ctx.flushedMods.has(ref.$mod)) {
              ctx.flushedMods.add(ref.$mod);
              let deps = "";
              if (ref.$deps?.length) {
                deps = "," + ref.$deps.map((dep) => JSON.stringify(dep)).join(",");
              }
              neededRuntime += `window.__pm(${JSON.stringify(ref.$mod)}${deps});`;
            }
          }

          if (ctx.inClient) return h(Type, vnode.props);

          return h(
            Fragment,
            {},
            h(Type, vnode.props),
            neededRuntime
              ? h("script", {
                  nonce,
                  dangerouslySetInnerHTML: {
                    __html: `${neededRuntime}document.currentScript?.remove();`,
                  },
                })
              : null,
          );
        };
      } else if (isClientReference(Type)) {
        const boundaryVNode = {
          type: Type,
          props: vnode.props,
          key: vnode.key,
          ref: vnode.ref,
        };
        vnode.type = (props) => {
          const id = useId();
          const ctx = useContext(Progressive);
          if (!ctx)
            throw new Error("Client references must be rendered with renderToProgressiveStream");

          if (ctx.inClient) return (Type as FunctionComponent)(props);

          let neededRuntime = getNeededRuntime(ctx);
          if (!ctx.flushedMods.has(Type.$mod)) {
            ctx.flushedMods.add(Type.$mod);
            let deps = "";
            if (Type.$deps?.length) {
              deps = "," + Type.$deps.map((dep) => JSON.stringify(dep)).join(",");
            }
            neededRuntime += `window.__pm(${JSON.stringify(Type.$mod)}${deps});`;
          }

          const encoded = encoder.encodeVNode(id, boundaryVNode);
          if (!encodedRows.includes(id)) encodedRows.push(id);

          return h(
            Progressive.Provider,
            {
              value: {
                ...ctx,
                get flushedRuntime() {
                  return ctx.flushedRuntime;
                },
                set flushedRuntime(value) {
                  ctx.flushedRuntime = value;
                },
                inClient: true,
              },
            },
            h(Fragment, {
              // @ts-expect-error - unstable, untyped API
              UNSTABLE_comment: `h:${id} ${JSON.stringify([namespace, Type.$mod, Type.$name])}`,
            }),
            h(() => (Type as FunctionComponent)(props), {}),
            h("script", {
              nonce,
              dangerouslySetInnerHTML: {
                __html: `${neededRuntime}${encoded}document.currentScript?.remove();`,
              },
            }),
            // @ts-expect-error - unstable, untyped API
            h(Fragment, { UNSTABLE_comment: `/h:${id}` }),
          );
        };
      }
    };

    const toEncode: [string, any][] = [];

    const root = h(
      Progressive.Provider,
      {
        value: {
          encodeProps: (id, obj) => {
            toEncode.push([id, obj]);
          },
          flushedMods: new Set<string>(),
        },
      },
      vnode,
    );

    let stream: ReadableStream<Uint8Array>;
    if (prerender) {
      stream = new ReadableStream({
        async start(controller) {
          const body = await renderToStringAsync(root, { nonce });
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
    } else {
      stream = renderToReadableStream(root, { nonce });
    }

    return streamWithSettlements(stream, encoder, encodedRows, nonce);
  } finally {
    (options as any).__b = otherB;
  }
}
