"use client";

import { useState } from "preact/hooks";

const initialCount = 0;

export function Counter({ id }: { id: string }) {
  const [count, setCount] = useState(initialCount);
  return (
    <button data-testid={id} type="button" onClick={() => setCount((c) => c + 1)}>
      {id}: {count}
    </button>
  );
}
