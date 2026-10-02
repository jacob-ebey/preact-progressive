import { Hono } from "hono";
import { preactRenderer, useRequestContext } from "hono-preact-progressive";
import type { ComponentChildren } from "preact";
import { Suspense, use } from "preact/compat";
import { Router } from "preact-progressive/router";

import { Counter } from "../components/counter.tsx";

const app = new Hono();

function Shell({ children }: { children?: ComponentChildren }) {
  const c = useRequestContext();
  if (c.get("dataResponse")) return children;

  return (
    <>
      <nav>
        <ul>
          <li>
            <a href="/router">Home</a>
          </li>
          <li>
            <a href="/router/about">About</a>
          </li>
          <li>
            <a href="/router/async">Async</a>
          </li>
        </ul>
      </nav>
      <Counter id="layout" />
      <Router>{children}</Router>
    </>
  );
}

app.use(
  preactRenderer(({ children, Layout }) => (
    <Layout>
      <Shell>{children}</Shell>
    </Layout>
  )),
);

app.get("/router", (c) => {
  return c.render(
    <>
      <h1>Hello, World!</h1>
      <Counter id="counter" />
    </>,
  );
});

app.get("/router/about", (c) => {
  return c.render(
    <>
      <h1>About!</h1>
      <Counter id="counter" />
    </>,
  );
});

app.get("/router/async", (c) => {
  const title = Promise.resolve("Async!");

  const Title = () => {
    "use client";
    return <h1>{use(title)}</h1>;
  };

  return c.render(
    <>
      <Suspense fallback="Loading...">
        <Title />
      </Suspense>
      <Counter id="counter" />
    </>,
  );
});

export default app;
