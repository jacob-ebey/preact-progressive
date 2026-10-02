import { type ComponentChild, type ContainerNode } from "preact";
import { hydrate } from "preact/compat";
import { createRootFragment } from "preact-root-fragment";

import "./client-runtime.ts";
import { Decoder, pump, type DecoderOptions, type LoadModule } from "./decoder.ts";

/**
 * Settlement frames stream in as `<script>` chunks appending to the stored
 * row payload (`Encoder.appendFrame`) followed by `ns.f?.(row)`. Install
 * that hook once per namespace so appended frames are applied immediately
 * — a promise prop may settle long after its island decoded, and without
 * the hook nothing would ever resolve it.
 *
 * Settlement application is order-independent (the decoder stashes
 * frames whose placeholder has not materialized), and hydration itself
 * waits out any placeholders its own decode created — so no timing
 * handshake with the transport swap or script chunks is required here.
 */
function installAppendHook(namespace: string, loadModule?: LoadModule): void {
  const bag = ((globalThis as Record<string, any>)[namespace] ??= {});
  bag.f ??= (row: string) => {
    const apply = () => {
      try {
        pump(namespace, row, loadModule);
      } catch (cause) {
        console.error(`Failed to apply settlement frame for ${namespace}/${row}`, cause);
      }
    };
    apply();
  };
}

/**
 * Hydrates server-rendered islands in place. Import it once in the client
 * entry and call it once, on the document element. Per island it is
 * idempotent.
 *
 * How the client converts island markers and payload rows into live
 * components. `prgressiveHydrate` scans the document for island markers and
 * pairs each open with its close. Each island runs the same pipeline:
 *
 * 1. `preload(id)` walks the row and constructs nothing. It collects `$R`
 *    module ids, including through references into other rows, and ensures
 *    each module load promise exists, importing through `__pm` where needed.
 *    Modules load before decode, so component references resolve to
 *    implementations directly and hydration never suspends.
 * 2. `decode(id)` parses the row into a live tree. `P["$V"]` becomes a
 *    preact vnode through `h()`, and `P["$R"]` becomes a resolved reference.
 *    Component kind means the loaded export when present, else a `lazy()`
 *    wrapper that resolves on module load. Function kind means the loaded
 *    export when present, else a function resolving the module at call time.
 *    `$bound` values prepend to props or call arguments.
 * 3. The decoded tree hydrates into the nodes between the markers with
 *    preact's `hydrate`, and the island marks done.
 *
 * Loaded modules return implementations directly, so initial hydration
 * suspends on nothing. That directness matters because preact `lazy` always
 * throws once on first render, which would mis-hydrate sibling DOM.
 *
 * #### Late islands
 *
 * Some islands arrive after first parse, mid-stream or mid-suspense, and a
 * `MutationObserver` catches them. The scan re-runs from scratch on every
 * mutation batch until `document.readyState === "complete"`. Fresh scans are
 * necessary because streaming moves markers into place after the initial
 * parse, where a live iterator would never revisit regions it already
 * passed. The scan stays idempotent, with a `hydrated` set blocking
 * double-hydration.
 *
 * Islands inside an in-flight navigation shell wait their turn. Their
 * markers reach the tree when the shell's buffered children land between
 * the transport markers, and hydrating any earlier would race that move. The
 * post-swap pass collects them at their real position.
 *
 * #### Settlements after hydration
 *
 * Settlement frames keep streaming after islands decode, and a hook on the
 * namespace (`ns.f`) applies them by calling `pump(row)`, which parses only
 * newly appended frames. Each frame carries its own base header, and
 * placeholders resolve or reject as their frames land.
 *
 * Application order does not matter. A frame that outruns its placeholder
 * stashes until the placeholder materializes. Hydration waits out
 * placeholders its own decode created, so no timing handshake with the
 * transport runs anywhere.
 *
 * #### Suspense ownership
 *
 * Suspense segments belong to preact, and the client keeps its hands off.
 * Server segments stream as `<!--$s:id-->fallback<!--/$s:id-->`. When a
 * segment suspends at hydration, core parks it: server markup stays mounted
 * and the fallback stays out. Never strip those markers or re-run hydrate
 * on suspension. On settlement the subtree force-updates and hydrates
 * whatever the transport swap placed there.
 *
 * #### Module registry
 *
 * Each HTML response emits the loader once:
 *
 * - `window.__pp[mod] = { p: Promise, m: exports }`, the load promise plus
 *   resolved exports.
 * - `window.__pm(mod, ...deps)`, which imports chunk dependencies first and
 *   then the module, caching both. Repeat calls are safe (`??=`).
 *
 * Preloading gathers every referenced module id before decode, so component
 * references resolve directly and first-render hydration never suspends.
 *
 * Note the export keeps its historical spelling (`prgressiveHydrate`, one
 * `o`), so import it exactly as shown.
 *
 * @param element - The subtree to scan for island markers; usually
 * `document.documentElement`.
 * @param options - Decoder options shared by every island, including the
 * client-reference module loader; see `DecoderOptions`.
 */
export function prgressiveHydrate(element: Element, options: DecoderOptions = {}) {
  const hydrated = new Set<string>();

  function scan() {
    // Rescan from scratch every pass: suspense streaming moves islands'
    // comment markers into place after the initial HTML parse, and a live
    // NodeIterator would never revisit a region it already advanced past.
    const opens = new Map<string, { data: [string, string, string]; node: Comment }>();
    const ittr = document.createNodeIterator(element, 128);
    for (let n = ittr.nextNode(); n; n = ittr.nextNode()) {
      const comment = n as Comment;
      const match = comment.data.match(/^\/?h:(\S+)/);
      if (!match) continue;
      // Islands inside an as-yet-unswapped transport shell are not live
      // content: their markers reach the tree when the shell's buffered
      // children land between the `$s` markers, and hydrating any earlier
      // would race that move. Skip shells; the post-swap pass picks the
      // island up at its real position.
      if (comment.parentElement?.closest("preact-island[data-target]")) continue;
      const id = match[1]!;

      if (!comment.data.startsWith("/")) {
        try {
          const data = JSON.parse(decodeEntities(comment.data.split(" ").slice(1).join(" "))) as [
            string,
            string,
            string,
          ];
          if (typeof data?.[0] === "string") installAppendHook(data[0], options.loadModule);
          opens.set(id, { data, node: comment });
        } catch (cause) {
          console.error("Failed to hydrate", cause);
        }
        continue;
      }

      if (hydrated.has(id)) continue;
      const open = opens.get(id);
      if (!open) continue; // close marker seen before its open in this pass
      hydrated.add(id);
      void hydrateClientComponent([id, open.data, open.node, comment], options);
    }
  }

  // Scan on every mutation batch: the MutationObserver already coalesces
  // each parser task into one callback, and scan() is idempotent (the
  // `hydrated` set guards double-hydration), so no frame-rate throttle is
  // needed. Islands become interactive as soon as their markers exist
  // rather than on the following animation frame.
  scan();

  if (document.readyState !== "complete") {
    const observer = new MutationObserver(scan);
    observer.observe(element, { childList: true, subtree: true });
    document.addEventListener(
      "readystatechange",
      () => {
        if (document.readyState !== "complete") return;
        observer.disconnect();
        scan();
      },
      { once: true },
    );
  }
}

/**
 * Suspense segments are owned by preact itself — the client must not touch
 * them. Server-rendered segments stream as
 * `<!--$s:id-->fallback<!--/$s:id-->`; while such a segment suspends during
 * hydration, core parks the segment's start marker on the suspending
 * component (`_component._excess`) and compat keeps the server markup
 * mounted instead of swapping in the fallback. On settlement the subtree
 * force-updates, core re-scans the DOM between those same markers, and
 * hydrates whatever it finds there. What it finds is placed by prs's
 * streamed transport swap exactly as upstream intended. Stripping markers
 * or re-running hydrate on suspension corrupts that handshake.
 */
async function hydrateClientComponent(
  [id, [namespace], start, end]: [string, [string, string, string], Comment, Comment],
  options: DecoderOptions,
) {
  try {
    const decoder = new Decoder(namespace, options);

    // Modules are loaded before decode, so client references resolve to
    // their implementation directly (no suspension), matching the SSR'd
    // DOM.
    await decoder.preload(id);
    const tree = decoder.decode(id);

    requestAnimationFrame(() => {
      // Collect the SSR'd nodes between the island's comment markers.
      let c: ChildNode | null = start;
      let nodes = [];
      while (c && c !== end) {
        nodes.push(c);
        c = c.nextSibling;
      }
      nodes.push(end);
      const element = createRootFragment(start.parentElement!, nodes);
      hydrate(tree as ComponentChild, element as unknown as ContainerNode);
    });
  } catch (cause) {
    console.error(`Failed to hydrate island ${id}`, cause);
  }
}

let div: HTMLElement;
function decodeEntities(encoded: string) {
  div ??= document.createElement("div");
  div.innerHTML = encoded;
  return div.textContent;
}
