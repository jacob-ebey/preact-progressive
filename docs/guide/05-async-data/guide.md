# Async Data

Server components can wait on data. When you read a promise with `use()`, the component suspends until the value arrives. A `Suspense` boundary decides what the browser sees in the meantime.

This is how you keep slow data from holding the whole page hostage.

## Your task

Open `start.tsx`. It waits 800 milliseconds for a greeting. With no boundary around it, the whole page holds back. The preview sits blank, then everything appears at once.

Wrap `<SlowGreeting />` in a `Suspense` boundary with a loading fallback:

```tsx
<Suspense fallback={<p>Loading…</p>}>
  <SlowGreeting />
</Suspense>
```

Watch the preview frame, not just the code. The heading and the fallback paint immediately. Then the greeting swaps in when the promise resolves. That two beat paint is streaming. The server sends what it has and follows with the rest.

## Fallbacks stream first

Calling `use()` throws the promise, and the nearest `Suspense` boundary catches it. The server streams the fallback HTML right away and retries the boundary when the promise settles. Nothing else waits for the slowest data. Each boundary resolves on its own schedule.

This works because the data lives on the server. The greeting promise could have been a database query. The browser never sees the query, only the HTML it produced.

## Next up

Here the server resolved data before sending HTML. In the final step you will pass the promise itself to the browser and let it resolve there.
