import { Hono } from "hono";
import { useState } from "preact/hooks";

import { Counter } from "../components/counter.tsx";

const app = new Hono();

app.get("/basic-use-client", (c) => {
  const initialCount = 0;

  function InlineCounter({ id }: { id: string }) {
    "use client";

    const [count, setCount] = useState(initialCount);
    return (
      <button data-testid={id} type="button" onClick={() => setCount((c) => c + 1)}>
        {id}: {count}
      </button>
    );
  }

  const increment = (id: string) => {
    "use client";

    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error("element not found");
    const count = Number.parseInt(el.textContent.split(" ").at(1) || "0", 10);
    el.textContent = `${id}: ${count + 1}`;
  };

  return c.render(
    <>
      <h1>Hello, World!</h1>
      <Counter id="counter" />
      <InlineCounter id="inline-counter" />
      <button
        data-testid="event-counter"
        type="button"
        onClick={increment.bind(null, "event-counter")}
      >
        event-counter: 0
      </button>
    </>,
  );
});

export default app;
