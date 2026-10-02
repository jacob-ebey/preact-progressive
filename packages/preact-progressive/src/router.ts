import { h, type ComponentChildren } from "preact";
import { Suspense } from "preact/compat";
import { useEffect, useState } from "preact/hooks";

import { DataDecoder, type LoadModule } from "./decoder.ts";

/**
 * Client navigation without document reloads. Same-document link clicks
 * re-fetch the component payload alone and swap it in.
 *
 * ```tsx
 * import { Router } from "preact-progressive/router";
 *
 * <Router>{children}</Router>;
 * ```
 *
 * Render the `Router` inside the document shell so full loads and navigations
 * share one tree. The server has to answer `Accept: text/x-component` with a
 * component stream (see `dynamicDataResponses` and the Hono integration).
 *
 * The bytes behind client navigation:
 *
 * #### Content negotiation
 *
 * One route serves two representations, and the `Accept` header picks between
 * them:
 *
 * - Full document loads omit the header. `renderToProgressiveStream` answers
 *   with `text/html; charset=UTF-8`, chunked, `<!DOCTYPE html>` prefixed
 *   unless already present.
 * - Navigations send `Accept: text/x-component`. `DataEncoder` answers with
 *   `text/x-component; charset=UTF-8`.
 *
 * The Hono `dynamicDataResponses()` middleware does the flagging. A matching
 * header sets `dataResponse: true` and appends `Vary: Accept`, and renderer
 * and shell branch on the flag. Shells must drop the document wrapper for
 * data responses, since a second `<html>` inside a navigation payload breaks
 * the swap.
 *
 * The `Router` builds each navigation request itself with destination URL
 * plus navigation headers, abort signal, and a cache mode mapped from
 * `navigationType` (`traverse` → `force-cache`, `reload` → `reload`,
 * `push` / `replace` → `default`). It skips what it cannot intercept, plus
 * hash-only changes, downloads, and form data.
 *
 * #### Data streams
 *
 * Document rows share one reference-id space with a namespace bag on
 * `globalThis`. Data streams work differently. Each `DataEncoder` call owns
 * a fresh writer with reference ids starting at 0. One self-contained root
 * frame leads, with settlement frames following for promises left
 * placeholder in the root. A promise that never settles holds its stream
 * open by design.
 *
 * `DataDecoder.decode(stream, onValue?)` reads incrementally, parsing each
 * newline-terminated frame on arrival. The root delivers through `onValue`
 * before close so hosts can paint early, while settlements apply to the same
 * parse context and resolve placeholders in place. The returned promise
 * resolves with the root on close. Malformed input rejects, whether trailing
 * bytes or an empty stream.
 *
 * Module resolution here has no `__pm` inline scripts to lean on, since
 * those exist only in HTML responses. When the decoder imports a module
 * itself it mirrors `__pm`: it caches the load promise and exposes resolved
 * exports on the registry entry. Otherwise component lookups miss their
 * export and hang suspended forever.
 *
 * #### Reconciliation
 *
 * The `Router` wraps output in `Suspense` with no remount key. Preact
 * reconciles each navigation payload against the mounted tree, reusing
 * component instances and Suspense boundaries where they match. State
 * survives the swap instead of resetting with it. The `fallback` prop holds
 * the previous tree, and it shows while the incoming payload suspends.
 * Aborts from interrupted navigations fail silently, and everything else
 * logs.
 *
 * @param children - The current server-rendered tree, which the first
 * navigation payload replaces.
 * @param fetch - Receives the constructed `Request` carrying the destination
 * URL with navigation headers, abort signal, and a cache mode derived from
 * `navigationType`. Override it for tests or request prefixing.
 * @param loadModule - Module loader for client references in navigation
 * payloads; see `LoadModule`. Defaults to the `__pp` registry plus a dynamic
 * ESM `import()`.
 */
export function Router({
  children,
  fetch = globalThis.fetch,
  loadModule,
}: {
  children?: ComponentChildren;
  fetch?: (request: Request) => Promise<Response>;
  /** Module loader for client references in navigation payloads; see `LoadModule`. */
  loadModule?: LoadModule;
}): ComponentChildren {
  "use client";

  const [[rendered, fallback], setRendered] = useState<[ComponentChildren, ComponentChildren]>([
    children,
    children,
  ]);

  useEffect(() => {
    const controller = new AbortController();

    navigation.addEventListener("navigate", (event) => {
      // TODO: Flush this out
      if (!event.canIntercept || event.hashChange || event.downloadRequest || event.formData)
        return;

      event.intercept({
        async handler() {
          try {
            const response = await fetch(
              new Request(event.destination.url, {
                headers: {
                  Accept: "text/x-component",
                },
                signal: event.signal,
                cache:
                  event.navigationType === "traverse"
                    ? "force-cache"
                    : event.navigationType === "reload"
                      ? "reload"
                      : "default",
              }),
            );
            const decoder = new DataDecoder({ loadModule });
            try {
              await decoder.decode(response.body!, (payload) => {
                if (!event.signal.aborted) {
                  setRendered(([current]) => [payload as ComponentChildren, current]);
                }
              });
            } catch (cause) {
              // The stream is torn down when a newer navigation interrupts
              // this one; that abort is expected, anything else is a bug.
              if (!event.signal.aborted) {
                console.error("Failed to decode navigation response", cause);
              }
            }
          } catch (cause) {
            // Same: an interrupted navigation aborts its fetch.
            if (!event.signal.aborted) {
              console.error("Failed to fetch navigation response", cause);
            }
          }
        },
      });
    });

    return () => controller.abort();
  }, []);

  return h(Suspense, { fallback }, rendered);
}
