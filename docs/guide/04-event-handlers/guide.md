# Event Handlers

Islands are not the only way to add behavior. If you put a `"use client"` directive on a single event handler, only that handler ships. There is no component and no hydration.

Use this when static markup only needs a little response. It is the lightest interaction on the page.

## Your task

Open `start.tsx`. It renders a greeting button with its click handler already written. Right now that handler is plain server code, so the button arrives dead. Clicking does nothing.

Add `"use client";` as the first line inside `handleClick`. That one line is the whole task. Click the button in the preview to check your work.

Then open the `rendered.html` tab and compare with the islands you built earlier. There are no island boundary comments here. Instead a small script sits right after the `<button>` and wires the listener directly. The captured `name` value is written into that script as a plain string.

## Handlers instead of islands

An island hydrates a component. A handler skips that entirely. The element works as soon as its script runs. That makes handlers the right default for buttons and logging on server rendered markup.

The tradeoff is what the handler can carry. Captured values inline into the script as literals, so promises and non reference functions are rejected. Anything richer belongs in island props, which you practiced in the previous step.

## Next up

So far every page arrived whole. Next you will slow the server down on purpose and stream the page in parts.
