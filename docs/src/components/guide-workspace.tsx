"use client";

import { useEffect, useRef, useState } from "preact/hooks";

import { GuideEditor, type EditableTab, type GuideEdits, type Tab } from "./guide-editor.tsx";

// function escapeHtml(value: string) {
//   return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// }

// function previewSrcdoc(code: string) {
//   return `<!doctype html>
// <html>
//   <body style="margin:0;min-height:100vh;display:grid;place-items:center;gap:1rem;background:#fafafa;color:#9ca3af;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">
//     <p>Your component will render here</p>
//     <pre style="margin:0;white-space:pre-wrap;word-break:break-word;color:#374151">${escapeHtml(code)}</pre>
//   </body>
// </html>`;
// }

export function GuideWorkspace({
  start,
  solution,
  pathname,
  importmap,
}: {
  start: string;
  solution: string;
  pathname: string;
  importmap: unknown;
}) {
  const [tab, setTab] = useState<Tab>("start");
  const [edits, setEdits] = useState<GuideEdits>({ start, solution });
  const [renderedHtml, setRenderedHtml] = useState("");
  const lastSourceRef = useRef(start);

  const handleEdit = (nextTab: EditableTab, value: string) => {
    setEdits((prev) => (prev[nextTab] === value ? prev : { ...prev, [nextTab]: value }));
  };

  // Keep previewing the last real source while the rendered.html tab is active.
  const previewCode = tab === "rendered" ? lastSourceRef.current : edits[tab];
  if (tab !== "rendered") lastSourceRef.current = edits[tab];

  return (
    <>
      <div class="h-[26rem] min-h-0 border-b border-zinc-200 lg:h-auto lg:flex-1 lg:border-b-0 lg:border-l dark:border-zinc-800">
        <GuideEditor
          tab={tab}
          edits={edits}
          renderedHtml={renderedHtml}
          onTabChange={setTab}
          onEdit={handleEdit}
        />
      </div>
      <Preview
        pathname={pathname}
        code={previewCode}
        importmap={importmap}
        onRenderedHtml={setRenderedHtml}
      />
    </>
  );
}

function Preview({
  pathname,
  code,
  importmap,
  onRenderedHtml,
}: {
  pathname: string;
  code: string;
  importmap: unknown;
  onRenderedHtml: (html: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onRenderedHtmlRef = useRef(onRenderedHtml);
  onRenderedHtmlRef.current = onRenderedHtml;

  useEffect(() => {
    const controller = new AbortController();
    // @ts-expect-error
    window.process ??= { env: {} };

    Promise.all([transform(code), import("preact-progressive/server")])
      .then(async ([transformed, { renderToProgressiveStream }]) => {
        const src = "data:text/javascript;base64," + btoa(transformed);
        const mod = await import(/* @vite-ignore */ src);
        const App = mod?.App;
        if (!App) throw new Error("No App export available.");

        const stream = renderToProgressiveStream(
          <html>
            <head>
              <title>Preview</title>
              <script
                type="importmap"
                dangerouslySetInnerHTML={{
                  __html: JSON.stringify(importmap),
                }}
              />
              <script
                async
                type="module"
                dangerouslySetInnerHTML={{
                  __html: `
                    import { prgressiveHydrate } from "preact-progressive/client";
                    prgressiveHydrate(document.documentElement);
                  `,
                }}
              />
            </head>
            <body>
              <App />
            </body>
          </html>,
        );

        const iframe = iframeRef.current;
        if (!iframe) throw new Error("No iframe");
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) throw new Error("No iframe doc");

        iframeDoc.open();
        let rawHtml = "";
        await stream
          .pipeThrough(new TextDecoderStream() as any)
          .pipeTo(
            new WritableStream<string>({
              write(chunk) {
                if (controller.signal.aborted) return;
                rawHtml += chunk;
                iframeDoc.write(chunk);
              },
            }),
          )
          .finally(() => {
            iframeDoc.close();
            // Format the raw response (pre-hydration) for the rendered.html tab.
            // Can't read the iframe's DOM: hydration scripts mutate/remove it.
            if (!controller.signal.aborted) onRenderedHtmlRef.current(formatHtml(rawHtml));
          });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error(error);
      });

    return () => controller.abort();
  }, [code]);

  return (
    <div class="flex h-72 shrink-0 flex-col lg:h-80">
      {/* Browser chrome */}
      <div class="flex items-center gap-3 border-y border-zinc-200 bg-white px-4 py-2 lg:border-l dark:border-zinc-800 dark:bg-zinc-950">
        <div class="flex shrink-0 gap-1.5" aria-hidden="true">
          <span class="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700"></span>
          <span class="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700"></span>
          <span class="h-2.5 w-2.5 rounded-full bg-emerald-400 dark:bg-emerald-600"></span>
        </div>
        <div class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-3.5 w-3.5 shrink-0 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0V11m0 0l-3 3m3-3l3 3"
            />
          </svg>
          <span class="truncate">localhost:5173{pathname}</span>
        </div>
        <button
          type="button"
          title="Refresh preview (coming soon)"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-white"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M4 4v5h5M20 20v-5h-5M4.5 9a8 8 0 0113.4-2.9M19.5 15a8 8 0 01-13.4 2.9"
            />
          </svg>
        </button>
      </div>

      {/* Preview frame */}
      <iframe
        ref={iframeRef}
        key={code}
        title="Preview"
        class="min-h-0 w-full flex-1 bg-white lg:border-l lg:border-zinc-200 dark:bg-white dark:lg:border-zinc-800"
      ></iframe>
    </div>
  );
}

// No native browser API pretty-prints HTML: `outerHTML` is compact. This
// parses the raw response with DOMParser (native, executes no scripts) and
// re-emits it indented, leaning on the browser's own serializer
// (`cloneNode().outerHTML`) for correct escaping.
function formatHtml(rawHtml: string): string {
  // Inline client modules are data: URIs (as script srcs and inside
  // window.__pm() bootstrap calls); show a placeholder instead.
  const displayHtml = rawHtml.replace(
    /data:text\/javascript;base64,[A-Za-z0-9+/=]*/g,
    "/client.js",
  );
  const doc = new DOMParser().parseFromString(displayHtml, "text/html");
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const lines: string[] = [];
  const escape = doc.createElement("span");

  const walk = (node: Node, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (!text) return;
      escape.textContent = text;
      lines.push(pad + escape.innerHTML);
      return;
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      lines.push(pad + `<!--${node.textContent}-->`);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    // cloneNode(false).outerHTML serializes the start tag natively, but
    // includes the end tag even when empty (`<title></title>`), so strip it.
    const serialized = (el.cloneNode(false) as Element).outerHTML;
    const endTag = `</${tag}>`;
    const start = serialized.endsWith(endTag) ? serialized.slice(0, -endTag.length) : serialized;
    lines.push(pad + start);
    if (!voidTags.has(tag)) {
      for (const child of el.childNodes) walk(child, depth + 1);
      lines.push(pad + `</${tag}>`);
    }
  };

  walk(doc.documentElement, 0);
  return lines.join("\n");
}

let initializePromise: Promise<void> | undefined;
async function transform(code: string) {
  const [{ initialize, transform }, babel, babelClientPlugin, babelServerPlugin] =
    await Promise.all([
      import("esbuild-wasm"),
      // @ts-expect-error
      import("https://esm.sh/@babel/standalone@8.0.4"),
      import("../../../packages/babel/src/client.ts"),
      import("../../../packages/babel/src/server.ts"),
    ]);
  await (initializePromise ??= initialize({
    worker: true,
    wasmURL: "https://unpkg.com/esbuild-wasm/esbuild.wasm",
  }));

  const transformed = await transform(code, {
    loader: "tsx",
    jsx: "automatic",
    jsxImportSource: "preact",
    format: "esm",
  });

  const client = await babel.transformAsync(transformed.code, {
    parserOpts: { sourceType: "module" },
    plugins: [babelClientPlugin.default],
  });

  const mod = "data:text/javascript;base64," + btoa(client?.code ?? "");

  const final = await babel.transformAsync(transformed.code, {
    parserOpts: { sourceType: "module" },
    plugins: [[babelServerPlugin.default, { mod, deps: [] }]],
  });

  if (!final?.code) throw new Error("Failed to transform module.");

  return final.code;
}
