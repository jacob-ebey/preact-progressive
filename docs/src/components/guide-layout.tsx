import type { ComponentChildren } from "preact";

import { Header } from "./docs-layout.tsx";
import { GuideWorkspace } from "./guide-workspace.tsx";
import { Highlight } from "./highlight.tsx";

export type GuideStep = {
  href: string;
  number: number;
  name: string;
};

export function GuideLayout({
  children,
  step,
  steps,
  previous,
  next,
  start,
  solution,
  pathname,
  importmap,
}: {
  children?: ComponentChildren;
  step: GuideStep;
  steps: GuideStep[];
  previous?: GuideStep;
  next?: GuideStep;
  start: string;
  solution: string;
  pathname: string;
  importmap: unknown;
}) {
  return (
    <div class="flex flex-col bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
      <Header />
      <div class="flex flex-col lg:h-[calc(100dvh-4rem)] lg:flex-row">
        {/* Guide (left) */}
        <aside
          key={step.name}
          class="w-full shrink-0 border-b border-zinc-200 lg:w-[26rem] lg:overflow-y-auto lg:border-r lg:border-b-0 xl:w-[30rem] dark:border-zinc-800"
        >
          <div class="px-6 py-8 sm:px-8 lg:px-10 lg:py-10">
            <Highlight />

            {/* Breadcrumb */}
            <div class="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <a href="/guide/01-server-components" class="hover:text-zinc-900 dark:hover:text-white">
                Guide
              </a>
              <span class="text-zinc-300 dark:text-zinc-700">/</span>
              <span class="text-zinc-900 dark:text-white">Step {step.number}</span>
            </div>

            {/* Title */}
            <h1 class="font-display mt-3 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">{step.name}</h1>
            <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Step {step.number} of {steps.length}
            </p>

            {/* Progress */}
            <div class="mt-4 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900" aria-hidden="true">
              <div
                class="h-full rounded-full bg-indigo-600 dark:bg-indigo-400"
                style={{ width: `${(step.number / steps.length) * 100}%` }}
              />
            </div>

            {/* Step list */}
            <nav
              class="mt-6 space-y-1 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800"
              aria-label="Guide steps"
            >
              {steps.map((s) => {
                const done = s.number < step.number;
                const active = s.href === step.href;
                return (
                  <a
                    key={s.href}
                    href={s.href}
                    aria-current={active ? "step" : undefined}
                    class={
                      active
                        ? "flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 font-medium text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                        : "flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
                    }
                  >
                    <span
                      class={
                        active
                          ? "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white dark:bg-indigo-500"
                          : done
                            ? "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-xs font-semibold text-white"
                            : "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-xs font-medium text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                      }
                    >
                      {done && !active ? "✓" : s.number}
                    </span>
                    <span class="truncate">{s.name}</span>
                  </a>
                );
              })}
            </nav>

            {/* Guide content */}
            <div class="mt-8">
              <div
                class="prose prose-sm prose-zinc max-w-none dark:prose-invert prose-headings:font-display prose-headings:text-zinc-900 prose-a:text-indigo-600 hover:prose-a:text-indigo-700 dark:prose-headings:text-white dark:prose-a:text-indigo-400"
                key={pathname}
              >
                {children}
              </div>
            </div>

            {/* Prev / next */}
            <nav class="mt-10 grid grid-cols-2 gap-3 border-t border-zinc-200 pt-6 text-sm dark:border-zinc-800">
              {previous ? (
                <a
                  href={previous.href}
                  class="group rounded-xl border border-zinc-200 p-3 transition hover:border-zinc-300 hover:bg-zinc-50 hover:shadow-sm dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  <span class="block text-xs text-zinc-500 dark:text-zinc-400">← Previous</span>
                  <span class="mt-0.5 block font-medium text-zinc-800 group-hover:text-zinc-900 dark:text-zinc-200 dark:group-hover:text-white">
                    {previous.name}
                  </span>
                </a>
              ) : (
                <span class="rounded-xl border border-zinc-100 p-3 text-zinc-300 dark:border-zinc-900 dark:text-zinc-700">
                  <span class="block text-xs">← Previous</span>
                  <span class="mt-0.5 block font-medium">Start of guide</span>
                </span>
              )}
              {next ? (
                <a
                  href={next.href}
                  class="group rounded-xl border border-zinc-200 bg-zinc-900 p-3 text-right text-white transition hover:bg-zinc-800 dark:border-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  <span class="block text-xs opacity-60">Next →</span>
                  <span class="mt-0.5 block font-medium">{next.name}</span>
                </a>
              ) : (
                <span class="rounded-xl border border-zinc-100 p-3 text-right text-zinc-300 dark:border-zinc-900 dark:text-zinc-700">
                  <span class="block text-xs">Next →</span>
                  <span class="mt-0.5 block font-medium">End of guide</span>
                </span>
              )}
            </nav>
          </div>
        </aside>

        {/* Workspace (right) */}
        <section class="flex min-w-0 flex-col bg-zinc-100 lg:min-h-0 lg:flex-1 dark:bg-zinc-900/50">
          <GuideWorkspace
            key={step.name}
            start={start}
            solution={solution}
            pathname={pathname}
            importmap={importmap}
          />
        </section>
      </div>
    </div>
  );
}
