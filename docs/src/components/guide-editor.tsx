"use client";

import { useEffect, useRef, useState } from "preact/hooks";

import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { autocompletion } from "@codemirror/autocomplete";
import { lintGutter } from "@codemirror/lint";
import * as Comlink from "comlink";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import { githubLight } from "@fsegurai/codemirror-theme-github-light";
import { githubDark } from "@fsegurai/codemirror-theme-github-dark";

export type Tab = "start" | "solution" | "rendered";
export type EditableTab = "start" | "solution";
export type GuideEdits = Record<EditableTab, string>;

function isDarkMode(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const themeCompartment = new Compartment();

const baseExtensions = [
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  history(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  javascript({ typescript: true, jsx: true }),
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  lintGutter(),
  EditorView.theme({
    "&": { fontSize: "13px" },
    ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
    ".cm-gutters": { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "12px" },
  }),
];

const renderedBaseExtensions = [
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  drawSelection(),
  bracketMatching(),
  html(),
  EditorState.readOnly.of(true),
  EditorView.lineWrapping,
  keymap.of(defaultKeymap),
  EditorView.theme({
    "&": { fontSize: "13px" },
    ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
    ".cm-gutters": { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "12px" },
  }),
];

let workerPromise: Promise<Comlink.Remote<WorkerShape>> | undefined;

export function GuideEditor({
  tab,
  edits,
  renderedHtml,
  onTabChange,
  onEdit,
}: {
  tab: Tab;
  edits: GuideEdits;
  renderedHtml: string;
  onTabChange: (tab: Tab) => void;
  onEdit: (tab: EditableTab, value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef<Partial<Record<Tab, EditorState>>>(null!);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const renderedHtmlRef = useRef(renderedHtml);
  renderedHtmlRef.current = renderedHtml;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let view: EditorView | null = null;
    let media: MediaQueryList | null = null;
    let onMediaChange: ((event: MediaQueryListEvent) => void) | null = null;

    // @valtown/codemirror-ts is imported dynamically: at module scope it reads
    // `ts.ScriptElementKind` off the JS-compiler TypeScript, which the SSR
    // bundle can't provide (the project's "typescript" is the native CLI).
    const init = async () => {
      const { tsAutocompleteWorker, tsFacetWorker, tsHoverWorker, tsLinterWorker, tsSyncWorker } =
        await import("@valtown/codemirror-ts");
      if (disposed) return;

      workerPromise ??= (async () => {
        const innerWorker = new Worker(new URL("./ts-worker.ts", import.meta.url), {
          type: "module",
        });
        const worker = Comlink.wrap<WorkerShape>(innerWorker);
        await worker.initialize();
        return worker;
      })();

      const worker = await workerPromise;
      if (disposed) return;

      // One EditorState per editable tab keeps each tab's document, undo
      // history and cursor position; switching tabs swaps states on the view.
      const makeState = (t: EditableTab, code: string) =>
        EditorState.create({
          doc: code,
          extensions: [
            ...baseExtensions,
            themeCompartment.of(isDarkMode() ? githubDark : githubLight),
            // start is the editable exercise; solution is a fixed reference.
            ...(t === "solution" ? [EditorState.readOnly.of(true)] : []),
            autocompletion({ override: [tsAutocompleteWorker()] }),
            tsFacetWorker.of({ worker, path: `/${t}.tsx` }),
            tsSyncWorker(),
            tsLinterWorker(),
            tsHoverWorker(),
            EditorView.updateListener.of((u) => {
              // States are immutable; keep the latest one per tab so tab
              // switches restore the edited document, not the initial one.
              statesRef.current[t] = u.state;
              if (u.docChanged) onEditRef.current(t, u.state.doc.toString());
            }),
          ],
        });

      statesRef.current = {
        start: makeState("start", edits.start),
        solution: makeState("solution", edits.solution),
        rendered: EditorState.create({
          doc: renderedHtmlRef.current,
          extensions: [
            ...renderedBaseExtensions,
            themeCompartment.of(isDarkMode() ? githubDark : githubLight),
          ],
        }),
      };
      view = new EditorView({ state: statesRef.current[tabRef.current], parent: container });
      viewRef.current = view;
      setReady(true);

      // Follow the OS preference. The editor
      // lives outside Tailwind's `dark:` cascade, so reconfigure CodeMirror.
      const applyTheme = (dark: boolean) => {
        const effect = themeCompartment.reconfigure(dark ? githubDark : githubLight);
        const states = statesRef.current;
        if (!states) return;
        for (const key of ["start", "solution", "rendered"] as const) {
          const state = states[key];
          if (!state) continue;
          const next = state.update({ effects: effect });
          states[key] = next.state;
        }
        const active = states[tabRef.current];
        if (active) viewRef.current?.setState(active);
      };
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = (event: MediaQueryListEvent) => {
        applyTheme(event.matches);
      };
      mq.addEventListener("change", handleChange);
      media = mq;
      onMediaChange = handleChange;
    };
    void init();

    return () => {
      disposed = true;
      if (media && onMediaChange) media.removeEventListener("change", onMediaChange);
      view?.destroy();
      viewRef.current = null;
    };
    // One-time setup: edits only ever change through onEdit, never externally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the rendered.html tab in sync with the latest preview output.
  useEffect(() => {
    const state = statesRef.current?.rendered;
    if (!state) return;
    const next = state.update({
      changes: { from: 0, to: state.doc.length, insert: renderedHtmlRef.current },
    });
    statesRef.current.rendered = next.state;
    if (tabRef.current === "rendered") viewRef.current?.setState(next.state);
  }, [renderedHtml]);

  const handleTabChange = (t: Tab) => {
    tabRef.current = t;
    const state = statesRef.current[t];
    if (state) viewRef.current?.setState(state);
    onTabChange(t);
  };

  useEffect(() => {
    requestAnimationFrame(() => {
      // @ts-expect-error - consume from CDN to avoid having to deal with bundler concerns
      void import("https://cdn.jsdelivr.net/npm/microlighter@2.1.0/dist/highlight.js").then((mod) =>
        mod.highlightAll(),
      );
    });
  }, [renderedHtml, tab]);

  return (
    <div class="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      {/* Tab bar */}
      <div class="flex items-end gap-1 overflow-x-auto overflow-y-hidden border-b border-zinc-200 bg-zinc-50 py-1 pr-4 pl-2 dark:border-zinc-800 dark:bg-zinc-900">
        <TabButton
          active={tab === "start"}
          onClick={() => handleTabChange("start")}
          label="start.tsx"
          hint="Your starting point"
        />
        <TabButton
          active={tab === "solution"}
          onClick={() => handleTabChange("solution")}
          label="solution.tsx"
          hint="One possible answer"
        />
        <TabButton
          active={tab === "rendered"}
          onClick={() => handleTabChange("rendered")}
          label="rendered.html"
          hint="Rendered output of the preview"
        />
        <div class="ml-auto hidden pb-1.5 text-xs text-zinc-400 sm:block dark:text-zinc-500">
          {tab === "start"
            ? "Edit the start file"
            : tab === "solution"
              ? "Reference solution"
              : "Rendered output of the preview"}
        </div>
      </div>

      {/* Code area */}
      <div class="relative min-h-0 flex-1 overflow-hidden bg-white dark:bg-zinc-950">
        {!ready && (
          <div class="absolute inset-0 z-10 flex items-center justify-center font-mono text-xs text-zinc-400 dark:text-zinc-500">
            Loading editor…
          </div>
        )}
        <div class="h-full overflow-y-auto [&>div]:h-full" ref={containerRef}></div>
      </div>

      {/* Status bar */}
      <div class="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-4 py-1.5 font-mono text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        <span>{tab === "rendered" ? "rendered.html · HTML" : `${tab}.tsx · TypeScript`}</span>
        <span class="flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          ready
        </span>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      class={
        active
          ? "-mb-px flex items-center gap-2 rounded-t-lg border border-b-0 border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
          : "flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      }
    >
      <span
        class={
          active
            ? "h-1.5 w-1.5 rounded-full bg-indigo-600 dark:bg-indigo-400"
            : "h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-700"
        }
      ></span>
      {label}
    </button>
  );
}
