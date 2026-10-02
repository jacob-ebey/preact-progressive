import type { ComponentChildren } from "preact";

export function Callout({
  title,
  children,
  tone = "info",
}: {
  title?: string;
  children?: ComponentChildren;
  tone?: "info" | "tip" | "warn";
}) {
  const tones = {
    info: "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300",
    tip: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200",
    warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200",
  } as const;

  const dot = {
    info: "bg-indigo-500",
    tip: "bg-emerald-500",
    warn: "bg-amber-500",
  } as const;

  return (
    <div class={`not-prose my-6 flex gap-3 rounded-xl border px-4 py-3.5 text-sm leading-relaxed ${tones[tone]}`}>
      <span class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[tone]}`} aria-hidden="true" />
      <div class="min-w-0">
        {title && <p class="font-semibold text-zinc-900 dark:text-zinc-100">{title}</p>}
        <div class="[&>p]:my-1">{children}</div>
      </div>
    </div>
  );
}
