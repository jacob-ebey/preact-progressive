import { useState } from "preact/hooks";

export function App() {
  // TODO: Make this button interactive by adding
  // "use client" to the top of this module

  const [count, setCount] = useState(0);

  const handleClick = () => {
    setCount((c) => c + 1);
  };

  return (
    <main>
      <h1>Counter</h1>
      <p>This module is a client island. The button below is hydrated in the browser.</p>
      <button type="button" onClick={handleClick}>
        Count: {count}
      </button>
    </main>
  );
}
