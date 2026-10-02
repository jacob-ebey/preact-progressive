# Server Components

Every component in Preact Progressive is a server component by default. It runs once on the server. The browser receives the HTML it produced. No JavaScript ships for it.

Think of this step as your baseline. Before you add any interactivity, make sure you can render static HTML and read it like the browser does.

## Your task

Open `start.tsx` in the editor on the right. It renders an empty `<main>` element. Fill in the `App` component so it renders:

- an `<h1>` with the text `Hello from the server`
- a `<p>` explaining that this component ran once on the server and the browser received HTML only

When you are done, open `solution.tsx` to compare. Then open the `rendered.html` tab. That tab shows the raw HTML the browser receives, before any client JavaScript runs. There is no script here because there is nothing to hydrate.

## How server components work

The tree renders to HTML on the server for every request. That keeps responses fast. Content sits in the document so search engines can read it. No bundle needs to boot before the user sees something.

```tsx
export function App() {
  return (
    <main>
      <h1>Hello from the server</h1>
      <p>This component ran once, on the server. The browser only received HTML.</p>
    </main>
  );
}
```

Notice there is no `use client` directive anywhere. So everything here is finished markup by the time it reaches the browser.

## Next up

Now that static rendering feels concrete, you will mark a module interactive with `use client` and build your first client island.
