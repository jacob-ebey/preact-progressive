# Client Islands

A static page stays static until you ask for interactivity. In Preact Progressive you opt in with a `use client` directive, either at the top of a module or on a scoped function. Either placement creates a boundary. This step uses the module form because it is the clearest.

## Your task

Open `start.tsx`. You will find a complete counter. State is wired. The handler is wired. But the module ships no client JavaScript, so the button arrives as dead HTML. Clicking does nothing.

Add `"use client";` at the top of the module. That one line is the whole task.

Then open `solution.tsx` to check your work. Open the `rendered.html` tab to see what changed. You will find the island as the browser first sees it: server rendered markup wrapped in a boundary comment, with the hydration script right after it.

## The `use client` directive

Marking a module with `use client` turns every export into a client reference. The server still renders the component once for the initial HTML. Then it ships the module to the browser so it can hydrate that HTML and handle events from then on.

```tsx
"use client";

import { useState } from "preact/hooks";

export function App() {
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
```

The server still renders the initial `Count: 0` markup, so there is no flash of an empty button. The page turns interactive as soon as that markup exists. It never waits for the full document.

## Next up

You have an island that owns its own state. Next you will feed it data from the server by passing props across the boundary.
