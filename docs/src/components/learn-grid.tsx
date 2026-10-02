const CARDS = [
  { href: "/learn/overview", title: "Overview", body: "Mental model: server HTML, islands, and payloads.", icon: "◈" },
  { href: "/learn/server-components", title: "Server components", body: "The default. Run once per request, emit HTML.", icon: "▣" },
  { href: "/learn/use-client", title: "`use client`", body: "Where interactivity starts. Boundaries explained.", icon: "✦" },
  { href: "/learn/islands", title: "Islands", body: "Independent payloads and modules per boundary.", icon: "◍" },
  { href: "/learn/props", title: "Props", body: "Richer than JSON. Server values arrive intact.", icon: "⇄" },
  { href: "/learn/events", title: "Events", body: "Single listeners for the price of a small script.", icon: "↯" },
  { href: "/learn/streaming", title: "Streaming & Suspense", body: "Paint order and async values resolving in place.", icon: "≋" },
  { href: "/learn/routing", title: "Routing & Navigation", body: "Link clicks fetch payloads, not full reloads.", icon: "→" },
  { href: "/learn/hono", title: "Serving with Hono", body: "Wire routes to HTML and navigation payloads.", icon: "⬡" },
];

export function LearnGrid() {
  return (
    <div class="not-prose mt-12">
      <div class="flex items-baseline justify-between">
        <h2 class="font-display text-lg font-bold tracking-tight text-zinc-900 dark:text-white">
          Learn the model
        </h2>
        <a
          href="/learn/overview"
          class="text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          Start with Overview →
        </a>
      </div>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => (
          <a
            key={card.href}
            href={card.href}
            class="group rounded-xl border border-zinc-200 bg-white p-4 transition hover:-translate-y-px hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
          >
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 font-mono text-sm text-zinc-600 transition group-hover:bg-indigo-600 group-hover:text-white dark:bg-zinc-900 dark:text-zinc-400 dark:group-hover:bg-indigo-500 dark:group-hover:text-white">
              {card.icon}
            </div>
            <p class="mt-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{card.title}</p>
            <p class="mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">{card.body}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
