import { CopyButton } from "./copy-button.tsx";

const INSTALL = "pnpm dlx degit jacob-ebey/preact-progressive-template my-new-app";

export function Hero() {
  return (
    <div class="not-prose relative -mx-4 -mt-8 overflow-hidden bg-white px-6 py-12 sm:-mx-8 sm:px-10 lg:-mx-12 lg:-mt-10 lg:px-14 lg:py-16 dark:bg-zinc-950">
      {/* grid + glow */}
      <div class="bg-grid dark:bg-grid-dark absolute inset-0 mask-[radial-gradient(ellipse_70%_80%_at_50%_0%,black,transparent)]" aria-hidden="true" />
      <div
        class="absolute -top-24 left-1/2 h-64 w-xl -translate-x-1/2 rounded-full bg-indigo-500/20 blur-[100px] dark:bg-indigo-600/25"
        aria-hidden="true"
      />

      <div class="relative">
        <a
          href="/learn/overview"
          class="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-100/80 py-1 pr-3 pl-1 text-xs font-medium text-zinc-600 backdrop-blur transition hover:border-zinc-300 hover:text-zinc-900 dark:border-white/15 dark:bg-white/5 dark:text-zinc-300 dark:hover:border-white/25 dark:hover:text-white"
        >
          <span class="rounded-full bg-indigo-500 px-2 py-0.5 text-[11px] font-semibold text-white">
            New
          </span>
          Server-first Preact with islands &amp; streaming
          <span aria-hidden="true">→</span>
        </a>

        <h1 class="font-display mt-6 max-w-2xl text-4xl font-bold tracking-tight text-balance text-zinc-950 sm:text-5xl dark:text-white">
          Server first.
          <br />
          Hydrate only what moves.
        </h1>
        <p class="mt-4 max-w-xl text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">
          Preact Progressive renders every request to HTML on the server. Mark
          interactive boundaries with <code class="rounded bg-zinc-950/5 px-1.5 py-0.5 font-mono text-[13px] text-zinc-800 dark:bg-white/10 dark:text-zinc-200">use client</code>. The rest never ships to the browser.
        </p>

        <div class="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="#getting-started"
            class="inline-flex h-10 items-center rounded-lg bg-zinc-950 px-5 text-sm font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            Get started
          </a>
          <a
            href="/guide/01-server-components"
            class="inline-flex h-10 items-center rounded-lg border border-zinc-300 bg-white px-5 text-sm font-semibold text-zinc-900 backdrop-blur transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/10"
          >
            Try the guide →
          </a>
        </div>

        <div class="mt-8 flex max-w-xl items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-100 py-2 pr-2 pl-4 font-mono text-[13px] text-zinc-700 backdrop-blur dark:border-white/10 dark:bg-black/40 dark:text-zinc-300">
          <span class="select-none text-zinc-500 dark:text-zinc-600" aria-hidden="true">$</span>
          <code class="min-w-0 flex-1 truncate">{INSTALL}</code>
          <CopyButton text={INSTALL} />
        </div>

        <dl class="mt-8 grid max-w-xl grid-cols-3 gap-4 border-t border-zinc-200 pt-6 text-sm dark:border-white/10">
          {[
            ["0 kB", "by default"],
            ["Per-island", "payloads"],
            ["Streaming", "Suspense-ready"],
          ].map(([stat, label]) => (
            <div key={label}>
              <dt class="font-display text-lg font-bold text-zinc-900 dark:text-white">{stat}</dt>
              <dd class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
