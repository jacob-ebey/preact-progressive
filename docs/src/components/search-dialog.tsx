"use client";

import { useEffect, useRef, useState } from "preact/hooks";

const PAGEFIND = "/pagefind/" + "pagefind.js";
let pagefindPromise: Promise<any> | undefined;
let pagefind: any | undefined;

export function SearchDialog({ id }: { id: string }) {
  const inputId = `${id}-input`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const controllerRef = useRef(new AbortController());

  const [{ state, results, query }, setState] = useState<{
    state: "loading" | "error" | "ready" | "loading-search" | "error-search" | "ready-search";
    query?: string;
    results?: {
      id: string;
      meta: { title?: string };
      excerpt?: string;
      plain_excerpt?: string;
      url: string;
      sub_results?: {
        excerpt?: string;
        plain_excerpt?: string;
        title: string;
        url: string;
      }[];
    }[];
  }>({
    state: "loading",
  });
  useEffect(() => {
    const dialog = document.getElementById(id) as HTMLDialogElement | null;
    dialogRef.current = dialog;

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (dialog?.open) {
          dialog.close();
        } else {
          dialog?.showModal();
          document.getElementById(inputId)?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);

    pagefindPromise ??= import(/* @vite-ignore */ PAGEFIND).then(async (pagefind) => {
      await pagefind.init();
      return pagefind;
    });

    pagefindPromise
      .then((_pagefind) => {
        pagefind = _pagefind;
        if (pendingRef.current) {
          pendingRef.current = false;
          search();
        }
        setState((s) => ({ ...s, state: s.results ? "ready-search" : "ready" }));
      })
      .catch((cause) => {
        console.error("failed to initialize pagefind", cause);
        setState({ state: "error" });
      });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const search = async () => {
    controllerRef.current.abort();
    controllerRef.current = new AbortController();
    const signal = controllerRef.current.signal;

    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const query = input?.value.trim() ?? "";
    if (!query) {
      setState((s) => ({
        ...s,
        state: pagefind ? "ready" : s.state,
        query: undefined,
        results: undefined,
      }));
      return;
    }
    if (!pagefind) {
      pendingRef.current = true;
      setState((s) => ({ ...s, query }));
      return;
    }

    setState((s) => ({ ...s, state: "loading-search", query }));

    try {
      const result = await pagefind.debouncedSearch(query);
      if (signal.aborted) return;
      const results = await Promise.all(
        result?.results.map(async (r: any) => ({
          id: r.id,
          ...(await r.data()),
        })),
      );
      if (signal.aborted) return;

      setState({ state: "ready-search", query, results });
    } catch (cause) {
      if (signal.aborted) return;
      console.error("failed to search", cause);
      setState((s) => ({ ...s, state: "error-search", query }));
    }
  };

  return (
    <dialog
      id={id}
      closedby="any"
      onClick={(event) => {
        "use client";
        // Close when clicking the backdrop
        if (event.target === event.currentTarget) {
          event.currentTarget.close();
        }
      }}
      class="mx-auto mt-[8vh] hidden w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl border border-zinc-200 bg-white p-0 shadow-2xl backdrop:bg-zinc-950/50 open:block dark:border-zinc-800 dark:bg-zinc-950 dark:backdrop:bg-black/60"
    >
      {/* Search input */}
      <div class="flex items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4 shrink-0 text-zinc-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M21 21l-4.35-4.35m1.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          id={inputId}
          onInput={search}
          type="search"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          placeholder={state === "loading" ? "Loading search index…" : "Search docs…"}
          aria-label="Search docs"
          class="w-full flex-1 bg-transparent py-4 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-white dark:placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd class="shrink-0 rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
          esc
        </kbd>
      </div>

      {/* Status line */}
      <div class="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        {state === "loading" ? (
          <p>Loading search index…</p>
        ) : state === "loading-search" ? (
          <p>
            Searching
            {query ? (
              <>
                {" "}
                for <span class="font-medium text-zinc-700">“{query}”</span>…
              </>
            ) : (
              "…"
            )}
          </p>
        ) : state === "error" ? (
          <p>Search failed to load. Try reloading the page.</p>
        ) : state === "error-search" ? (
          <p>Something went wrong while searching. Try again.</p>
        ) : results ? (
          <p>
            {results.length === 0 ? (
              <>
                No results
                {query ? (
                  <>
                    {" "}
                    for <span class="font-medium text-zinc-700">“{query}”</span>
                  </>
                ) : null}
              </>
            ) : (
              <>
                {results.length} {results.length === 1 ? "result" : "results"}
                {query ? (
                  <>
                    {" "}
                    for <span class="font-medium text-zinc-700">“{query}”</span>
                  </>
                ) : null}
              </>
            )}
          </p>
        ) : (
          <p>Type to search the docs</p>
        )}
      </div>

      {/* Results */}
      <div class="max-h-[60vh] overflow-y-auto">
        {state === "loading-search" && !results?.length ? (
          <div class="animate-pulse space-y-3 p-4" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} class="space-y-2 rounded-md border border-zinc-200 p-3">
                <div class="h-3.5 w-1/3 rounded bg-zinc-200" />
                <div class="h-3 w-full rounded bg-zinc-100" />
                <div class="h-3 w-2/3 rounded bg-zinc-100" />
              </div>
            ))}
          </div>
        ) : results && results.length > 0 ? (
          <ul
            // @ts-expect-error - no types for this yet
            focusgroup="menu"
            role="menu"
            class="divide-y divide-zinc-100 p-2 dark:divide-zinc-800"
          >
            {results.map(({ id, meta, excerpt, plain_excerpt, url, sub_results }) => {
              const title = meta.title || url;
              const body = excerpt ?? plain_excerpt;
              return (
                <li role="none" key={id}>
                  <a
                    href={url}
                    onClick={() => dialogRef.current?.close()}
                    class="block rounded-lg px-3 py-3 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    role="menuitem"
                  >
                    <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
                    {body ? (
                      <p
                        class="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400 [&_mark]:rounded [&_mark]:bg-indigo-600/15 [&_mark]:px-0.5 [&_mark]:text-indigo-700 dark:[&_mark]:bg-indigo-400/20 dark:[&_mark]:text-indigo-200"
                        // Pagefind returns excerpt HTML with <mark> highlights
                        dangerouslySetInnerHTML={{ __html: body }}
                      />
                    ) : null}
                    <p class="mt-1 truncate text-xs text-zinc-400 dark:text-zinc-500">{url}</p>
                  </a>
                  {(sub_results?.length ?? 0) > 0 ? (
                    <ul role="menu" class="mb-2 ml-3 space-y-0.5 border-l border-zinc-200 pl-3 dark:border-zinc-800">
                      {sub_results!.map(({ excerpt, plain_excerpt, title, url }, index) => (
                        <li role="none" key={index}>
                          <a
                            role="menuitem"
                            href={url}
                            onClick={() => dialogRef.current?.close()}
                            class="block rounded-md px-2 py-1.5 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
                          >
                            <p class="truncate text-[13px] font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
                            {(excerpt ?? plain_excerpt) ? (
                              <p
                                class="mt-0.5 line-clamp-1 text-xs text-zinc-500 dark:text-zinc-400 [&_mark]:rounded [&_mark]:bg-indigo-600/15 [&_mark]:text-indigo-700 dark:[&_mark]:bg-indigo-400/20 dark:[&_mark]:text-indigo-200"
                                dangerouslySetInnerHTML={{
                                  __html: (excerpt ?? plain_excerpt)!,
                                }}
                              />
                            ) : null}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : results && results.length === 0 ? (
          <div class="px-4 py-10 text-center">
            <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">No matches found</p>
            <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Try a different search term.</p>
          </div>
        ) : state === "error" || state === "error-search" ? (
          <div class="px-4 py-10 text-center">
            <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">Search is unavailable</p>
            <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Check your connection and try again.</p>
          </div>
        ) : (
          <div class="px-4 py-10 text-center">
            <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">Search the documentation</p>
            <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Results will show matching pages and sections.</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div class="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        <p>
          Press <kbd class="rounded border border-zinc-300 bg-white px-1 py-px dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">esc</kbd> to close
        </p>
        <p>
          Search by <span class="font-medium text-zinc-600 dark:text-zinc-300">Pagefind</span>
        </p>
      </div>
    </dialog>
  );
}
