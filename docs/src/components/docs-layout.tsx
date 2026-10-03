import type { TocEntry } from "@stefanprobst/rehype-extract-toc";
import cn from "clsx";
import type { ComponentChildren } from "preact";
import { Logo } from "./logo.tsx";
import { SearchDialog } from "./search-dialog.tsx";
import { TocNav } from "./toc-nav.tsx";

export function DocsLayout({
  children,
  pathname,
  tableOfContents,
}: {
  children?: ComponentChildren;
  pathname: string;
  tableOfContents?: TocEntry[];
}) {
  return (
    <div class="flex min-h-screen flex-col bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
      <Header sidebarButton />

      <div class="mx-auto flex w-full max-w-360 flex-1">
        <SidebarLeft pathname={pathname} />
        <main class="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12 lg:py-10">{children}</main>
        {tableOfContents ? (
          <SidebarRight pathname={pathname} tableOfContents={tableOfContents} />
        ) : null}
      </div>

      <Footer />
    </div>
  );
}

export function Header({ sidebarButton }: { sidebarButton?: boolean }) {
  return (
    <>
      <header class="sticky top-0 z-20 overflow-x-auto border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div class="mx-auto flex h-16 max-w-360 items-center justify-between gap-3 px-4 sm:px-6">
          <a tabIndex={-1} href="/" class="flex shrink-0 items-center" aria-label="preact-progressive home">
            <Logo />
          </a>

          <nav
            // @ts-expect-error - no types for this yet
            focusgroup="menubar"
            role="menubar"
            class="hidden items-center gap-1 text-sm font-medium sm:flex"
          >
            {[
              ["/", "Docs"],
              ["/guide/01-server-components", "Guide"],
            ].map(([href, label]) => (
              <a
                key={href}
                role="menuitem"
                href={href}
                class="rounded-md px-3 py-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
              >
                {label}
              </a>
            ))}
            <a
              role="menuitem"
              href="https://github.com/jacob-ebey/preact-progressive"
              class="rounded-md px-3 py-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
            >
              GitHub
            </a>
          </nav>

          <div class="flex items-center gap-2">
            <button
              class="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-500 shadow-sm transition hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
              command="show-modal"
              commandfor="search-dialog"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4"
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
              <span class="text-nowrap">Search</span>
              <kbd class="hidden rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 md:inline dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                ⌘K
              </kbd>
            </button>
            {sidebarButton ? (
              <>
                <div class="h-6 w-px bg-zinc-200 lg:hidden dark:bg-zinc-800"></div>
                <button
                  class="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
                  aria-label="Menu"
                  command="show-modal"
                  commandfor="docs-sidebar"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  </svg>
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>
      <SearchDialog id="search-dialog" />
    </>
  );
}

function SidebarLeft({ pathname }: { pathname: string }) {
  const link = (to: string) =>
    ({
      role: "menuitem",
      href: to,
      class:
        to === pathname
          ? "block rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 font-medium text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
          : "block rounded-lg border border-transparent px-3 py-2 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100",
    }) as const;

  const section = "px-3 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase dark:text-zinc-500";

  return (
    <dialog
      tabIndex={-1}
      class="hidden h-screen max-h-none w-72 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white p-5 open:block lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-4rem)] dark:border-zinc-800 dark:bg-zinc-950"
      id="docs-sidebar"
      closedby="any"
      onClick={(event) => {
        "use client";
        if (event.target instanceof HTMLAnchorElement) {
          event.currentTarget.close();
        }
      }}
    >
      <div class="mb-3 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase dark:text-zinc-500">
        Documentation
      </div>

      <nav
        // @ts-expect-error - no types for this yet
        focusgroup="menu"
        role="menu"
        class="space-y-1 text-sm"
      >
        <a {...link("/")}>Getting started</a>

        <div class="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800"></div>

        <div class={section}>Learn</div>
        <a {...link("/learn/overview")}>Overview</a>
        <a {...link("/learn/server-components")}>Server components</a>
        <a {...link("/learn/use-client")}>`use client`</a>
        <a {...link("/learn/islands")}>Islands</a>
        <a {...link("/learn/props")}>Props</a>
        <a {...link("/learn/events")}>Events</a>
        <a {...link("/learn/streaming")}>Streaming & Suspense</a>
        <a {...link("/learn/routing")}>Routing & Navigation</a>
        <a {...link("/learn/hono")}>Serving with Hono</a>

        <div class="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800"></div>

        <div class={section}>Reference</div>
        <a {...link("/reference/preact-progressive/client")}>preact-progressive/client</a>
        <a {...link("/reference/preact-progressive/server")}>preact-progressive/server</a>
        <a {...link("/reference/preact-progressive/router")}>preact-progressive/router</a>
        <a {...link("/reference/preact-progressive/encoder")}>preact-progressive/encoder</a>
        <a {...link("/reference/preact-progressive/decoder")}>preact-progressive/decoder</a>
        <a {...link("/reference/hono/hono")}>hono-preact-progressive</a>
        <a {...link("/reference/vite-plugin/vite")}>vite-plugin-preact-progressive</a>
        <a {...link("/reference/rsbuild-plugin/rsbuild")}>rsbuild-plugin-preact-progressive</a>
        <a {...link("/reference/rsbuild-plugin/client")}>rsbuild-plugin-preact-progressive/client</a>
        <a {...link("/reference/rsbuild-plugin/server")}>rsbuild-plugin-preact-progressive/server</a>
        <a {...link("/reference/babel/client")}>babel-plugin-preact-progressive/client</a>
        <a {...link("/reference/babel/server")}>babel-plugin-preact-progressive/server</a>

        <div class="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800"></div>

        <a
          href="/guide/01-server-components"
          class="block rounded-xl border border-zinc-200 bg-zinc-50 p-3 transition hover:border-indigo-300 hover:bg-indigo-50 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
        >
          <p class="text-sm font-semibold text-zinc-900 dark:text-white">Interactive guide →</p>
          <p class="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            6 steps with a live editor. No setup required.
          </p>
        </a>
      </nav>
    </dialog>
  );
}

function SidebarRight({
  pathname,
  tableOfContents,
}: {
  pathname: string;
  tableOfContents: TocEntry[];
}) {
  const isContentPage = !pathname.startsWith("/reference") && !pathname.startsWith("/guide");
  const editHref = `https://github.com/jacob-ebey/preact-progressive/edit/main/docs/content${pathname.endsWith("/") ? `${pathname}_` : pathname}.mdx`;

  return (
    <aside class="sticky top-16 hidden h-[calc(100vh-4rem)] w-60 shrink-0 overflow-y-auto border-l border-zinc-200 p-6 xl:block dark:border-zinc-800">
      <div class="mb-3 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase dark:text-zinc-500">
        On this page
      </div>
      <TocNav tableOfContents={tableOfContents} />

      {isContentPage && (
        <div
          class={cn(
            "mt-8 border-t border-zinc-200 pt-6 text-[13px] dark:border-zinc-800",
          )}
        >
          <p class="font-medium text-zinc-900 dark:text-zinc-100">Suggest an edit</p>
          <p class="mt-1 leading-relaxed text-zinc-500 dark:text-zinc-400">
            Found a typo? Docs are MDX in the repo.
          </p>
          <a
            href={editHref}
            class="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-zinc-200 bg-white px-2 py-1.5 font-medium text-zinc-700 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Edit on GitHub
          </a>
        </div>
      )}
    </aside>
  );
}

function Footer() {
  const cols: { title: string; links: [string, string][] }[] = [
    {
      title: "Docs",
      links: [
        ["/", "Getting started"],
        ["/learn/overview", "Learn"],
        ["/guide/01-server-components", "Guide"],
        ["/reference/preact-progressive/server", "Reference"],
      ],
    },
    {
      title: "Packages",
      links: [
        ["/reference/preact-progressive/server", "preact-progressive"],
        ["/reference/hono/hono", "hono integration"],
        ["/reference/vite-plugin/vite", "vite plugin"],
        ["/reference/babel/server", "babel plugin"],
      ],
    },
    {
      title: "Community",
      links: [
        ["https://github.com/jacob-ebey/preact-progressive", "GitHub"],
        ["https://github.com/jacob-ebey/preact-progressive/issues", "Issues"],
        ["https://github.com/jacob-ebey/preact-progressive/discussions", "Discussions"],
      ],
    },
  ];

  return (
    <footer class="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div class="mx-auto grid max-w-360 gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.2fr_repeat(3,1fr)] lg:px-8">
        <div>
          <Logo />
          <p class="mt-3 max-w-xs text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            Server-first Preact. Every request returns HTML, and you hydrate only the islands that need it.
          </p>
        </div>
        {cols.map((col) => (
          <div key={col.title}>
            <p class="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase dark:text-zinc-500">
              {col.title}
            </p>
            <ul class="mt-3 space-y-2 text-sm">
              {col.links.map(([href, label]) => (
                <li key={href + label}>
                  <a
                    href={href}
                    class="text-zinc-600 transition hover:text-zinc-900 hover:underline hover:underline-offset-4 dark:text-zinc-400 dark:hover:text-white"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div class="border-t border-zinc-200 dark:border-zinc-800">
        <div class="mx-auto flex max-w-360 flex-col items-center justify-between gap-2 px-4 py-5 text-[13px] text-zinc-400 sm:flex-row sm:px-6 lg:px-8 dark:text-zinc-500">
          <p>© 2026 preact-progressive. MIT licensed.</p>
          <p>
            Built with <span class="font-medium text-zinc-500 dark:text-zinc-400">preact-progressive</span> itself.
          </p>
        </div>
      </div>
    </footer>
  );
}
