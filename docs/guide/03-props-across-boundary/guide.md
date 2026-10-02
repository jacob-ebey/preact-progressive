# Props Across the Boundary

The server renders client islands first. The browser hydrates them after. Props are how data travels between those two moments, in a format that carries more than JSON.

Think of this step as handing server data to client state. The server knows the starting value. The island needs it to hydrate correctly.

## Your task

Open `start.tsx`. It passes an `initial` count to `Counter`, but `Counter` ignores it. It still starts at `0`, and it is not a client island yet. Wire it up in two moves:

1. Add `"use client";` inside the `Counter` function. This scoped form keeps the rest of the module server only.
2. Read the `initial` prop and use it as the starting value for `useState`.

Open `solution.tsx` when you want to compare. Then open the `rendered.html` tab. You will see the props serialized into the island inline script, right next to the markup they hydrate. That script is the handoff.

## Passing props from server to client

A server component can render a client island and hand it data. The server serializes the props into a small inline script next to the island HTML. The browser reads that script during hydration.

```tsx
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
```

Only serializable values cross the boundary. A database connection or a `ReadableStream` cannot travel. Resolve those on the server first, then pass the result down.

## Next up

You have covered data. Next you will cover behavior without a component: a single event handler with no island.
