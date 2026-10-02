"use client";

import { useEffect, useState } from "preact/hooks";
import type { TocEntry } from "@stefanprobst/rehype-extract-toc";

function flatten(entries: TocEntry[], depth = 0): { id: string; value: string; depth: number }[] {
  const out: { id: string; value: string; depth: number }[] = [];
  for (const e of entries) {
    if (e.depth > 1 && e.id && e.value) out.push({ id: e.id, value: e.value, depth });
    if (e.children?.length) out.push(...flatten(e.children as TocEntry[], depth + 1));
  }
  return out;
}

export function TocNav({ tableOfContents }: { tableOfContents: TocEntry[] }) {
  const items = flatten(tableOfContents);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableOfContents]);

  if (!items.length) return null;

  return (
    <nav class="space-y-0.5 text-[13px] leading-5" aria-label="On this page">
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          aria-current={active === item.id ? "true" : undefined}
          class={
            active === item.id
              ? "block border-l-2 border-indigo-600 py-1 pr-2 pl-3 font-medium text-zinc-900 dark:border-indigo-400 dark:text-white"
              : "block border-l-2 border-transparent py-1 pr-2 pl-3 text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
          }
          style={{ marginLeft: `${Math.min(item.depth, 3) * 0.75}rem` }}
        >
          {item.value}
        </a>
      ))}
    </nav>
  );
}
