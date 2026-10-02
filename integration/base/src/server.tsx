import { Hono } from "hono";
import { dynamicDataResponses, preactRenderer, useRequestContext } from "hono-preact-progressive";
import type { ComponentChildren } from "preact";

import basicUseClient from "./routes/basic-use-client.tsx";
import router from "./routes/router.tsx";

export function createApp({
  assets,
  renderer,
}: {
  assets: PageAssets;
  renderer?: Parameters<typeof preactRenderer>[1];
}) {
  const app = new Hono();

  app.use(
    dynamicDataResponses(),
    preactRenderer(({ children }) => <Shell assets={assets}>{children}</Shell>, renderer),
  );

  app.route("", basicUseClient);
  app.route("", router);

  return app;
}

type PageAssets = {
  entry?: string;
  js: { href: string }[];
  css: { href: string }[];
  /**
   * Whether the entry and its chunks are ES modules. Rsbuild's classic JSONP
   * output sets `false`; the Vite/ESM default is `true`.
   */
  module?: boolean;
};

function Shell({ children, assets }: { children?: ComponentChildren; assets: PageAssets }) {
  const c = useRequestContext();
  if (c.get("dataResponse")) return children;

  const isModule = assets.module !== false;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=value, initial-scale=1.0" />
        {/* Classic JSONP output needs its runtime and shared chunks loaded
            before the entry, in order; ES modules import their own graph. */}
        {!isModule ? assets.js.map((file) => <script src={file.href} />) : null}
        {assets.css.map((file) => (
          <link rel="stylesheet" href={file.href} />
        ))}
        {assets.entry ? (
          isModule ? (
            <script async type="module" src={assets.entry} />
          ) : (
            <script async src={assets.entry} />
          )
        ) : null}
      </head>
      <body class="min-h-screen">{children}</body>
    </html>
  );
}
