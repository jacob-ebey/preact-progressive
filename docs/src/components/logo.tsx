export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span class="flex items-center gap-2.5">
      <span
        class="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
        aria-hidden="true"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5 14.5 5v6L8 14.5 1.5 11V5L8 1.5Z"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </svg>
      </span>
      {!compact && (
        <span class="font-display text-[17px] font-bold tracking-tight text-zinc-900 dark:text-white">
          preact<span class="text-zinc-400 dark:text-zinc-500">-</span>progressive
        </span>
      )}
    </span>
  );
}
