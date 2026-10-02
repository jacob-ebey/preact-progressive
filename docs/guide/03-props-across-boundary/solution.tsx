import { useState } from "preact/hooks";

export function App() {
  return (
    <main class="p-8">
      <h1>Props across the boundary</h1>
      <Counter initial={5} />
    </main>
  );
}

function Counter({ initial }: { initial: number }) {
  "use client";

  const [count, setCount] = useState(initial);

  return (
    <button type="button" class="rounded border px-4 py-2" onClick={() => setCount((c) => c + 1)}>
      Count: {count}
    </button>
  );
}
