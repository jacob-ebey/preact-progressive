# Promise Props

Promises can cross the boundary instead of resolving on the server. The prop arrives in the browser as a real promise. Its settlement streams in afterwards to resolve it.

Use this when the browser should start rendering now and fill in data when it lands.

## Your task

Open `start.tsx`. It passes a promise of a name into `ProfileCard`, which stringifies it and renders a cheerful `Hello, [object Promise]`. Three edits fix it:

1. Add `"use client";` inside `ProfileCard` so it becomes an island. The scoped form keeps the rest server only.
2. Read the promise with `const resolved = use(name);` and render that instead of the promise itself.
3. Wrap `<ProfileCard />` in a `Suspense` boundary with a loading fallback, because the island suspends until the promise settles.

Watch the preview. You will see the fallback first, then the greeting with the resolved name. Then open `rendered.html` and find the settlement script. The island row carries a promise placeholder, and a follow up script appends the resolved value to it.

## Placeholders, not blockers

Nothing waits for the promise. The server sends the page with a marker where the value will land. The island hydrates around it. When the settlement arrives, the new value slots into the live tree without another round trip.

This is the same machinery as the previous step, pointed at the browser instead of the server. In step 5 you resolved data before sending HTML. Here the HTML goes first and the data catches up.

## Congratulations

You finished the guide. You rendered on the server, built an island, passed props, added a handler, streamed async UI, and resolved a promise in the browser.

The reference docs pick up from here with exact APIs. The Learn pages explain each idea in full when you want a refresher.
