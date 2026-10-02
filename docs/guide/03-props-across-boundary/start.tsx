import { useState } from "preact/hooks";

// TODO: Make the button interactive and use the initial value
// 1. Add "use client" to the Counter component.
// 2. Use `initial` as the default count value.

export function App() {
  return (
    <main class="p-8">
      <h1>Props across the boundary</h1>
      <Counter initial={5} />
    </main>
  );
}

function Counter({}: { initial: number }) {
  const [count, setCount] = useState(0);

  return (
    <button type="button" class="rounded border px-4 py-2" onClick={() => setCount((c) => c + 1)}>
      Count: {count}
    </button>
  );
}
