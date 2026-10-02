import { Hono } from "hono";
import { h, type ComponentChildren, type VNode } from "preact";

import {
  dynamicDataResponses,
  preactRenderer,
  RequestContext,
  useRequestContext,
} from "hono-preact-progressive";
import { DataDecoder } from "preact-progressive/decoder";
import { Router } from "preact-progressive/router";
import { renderToProgressiveStream } from "preact-progressive/server";

import { loadModule } from "virtual:server-load-module";

import { DocsLayout } from "./components/docs-layout.tsx";
import importmap from "./importmap/importmap.ts";
import docs from "./routes/docs.tsx";
import guide from "./routes/guide.tsx";
import reference from "./routes/reference.tsx";

import "./styles.css";
import clientAssets from "./entry.client.ts?assets=client";
import ssrAssets from "./entry.server.tsx?assets=ssr";

const app = new Hono();

app.use(
  dynamicDataResponses(),
  preactRenderer(({ children }) => <Shell>{children}</Shell>),
);

app.notFound((c) => {
  const url = new URL(c.req.url);
  c.status(404);
  return c.render(
    <DocsLayout pathname={url.pathname}>
      <article class="prose prose-zinc max-w-none dark:prose-invert">
        <title>Not Found</title>
        <meta name="description" content="The requested page was not found." />
        <h1>404</h1>
        <p>Not Found</p>
      </article>
    </DocsLayout>,
  );
});

app.route("", guide);
app.route("", reference);
app.route("", docs);

export default app;

const assets = clientAssets.merge(ssrAssets);

function Shell({ children }: { children?: ComponentChildren }) {
  const c = useRequestContext();
  if (c.get("dataResponse")) return children;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=value, initial-scale=1.0" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
        <meta name="color-scheme" content="light dark" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {assets.css.map((f) => (
          <link rel="stylesheet" href={f.href} />
        ))}
        <script
          type="importmap"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(importmap),
          }}
        />
        <script async type="module" src={assets.entry}></script>
      </head>
      <body>
        <Router
          fetch={(request) => {
            "use client";
            if (import.meta.env.PROD) {
              const url = new URL(request.url);
              url.pathname =
                url.pathname.length > 1
                  ? url.pathname.replace(/\/$/, "")
                  : url.pathname;
              url.pathname =
                url.pathname === "/" ? "/_.data" : `${url.pathname}.data`;
              return fetch(url, request);
            }
            return fetch(request);
          }}
        >
          {children}
        </Router>
      </body>
    </html>
  );
}

export async function prerender(path: string, expectedStatus: number = 200) {
  const dataResponse = await app.fetch(
    new Request(new URL(path, "http://localhost"), {
      headers: {
        Accept: "text/x-component",
      },
    }),
  );
  if (dataResponse.status !== expectedStatus) {
    throw new Error(
      `Unexpected response status ${dataResponse.status} for ${path}`,
    );
  }
  if (!dataResponse.body) {
    throw new Error(`No response body for ${path}`);
  }

  const dataResponseClone = dataResponse.clone();
  const [data, html] = await Promise.all([
    dataResponse.text(),
    (async () => {
      const decoder = new DataDecoder({ loadModule });
      const decoded = await decoder.decode(dataResponseClone.body);
      // The data tree drops the document shell, so re-apply it: without
      // Shell the prerendered file would be a fragment with no <html>.
      // Decoded providers resolved inline during encoding, so supply a stub
      // context whose dataResponse flag is falsy (document branch).
      const stub = { get: () => undefined };
      const doc = h(RequestContext.Provider, { value: stub as any }, h(Shell, {
        children: decoded as VNode,
      }));
      const stream = renderToProgressiveStream(doc, {
        prerender: true,
      });
      await stream.allReady;
      let html = "<!DOCTYPE html>";
      await stream.pipeThrough(new TextDecoderStream() as any).pipeTo(
        new WritableStream({
          write(chunk) {
            html += chunk;
          },
        }),
      );
      return html;
    })(),
  ]);

  return { data, html };

  // const [dataResponse, htmlResponse] = await Promise.all([
  //   app.fetch(
  //     new Request(new URL(path, "http://localhost"), {
  //       headers: {
  //         Accept: "text/x-component",
  //       },
  //     }),
  //   ),
  //   app.fetch(new Request(new URL(path, "http://localhost"))),
  // ]);
  // if (dataResponse.status !== expectedStatus) {
  //   throw new Error(`Unexpected response status ${dataResponse.status} for ${path}`);
  // }
  // if (htmlResponse.status !== expectedStatus) {
  //   throw new Error(`Unexpected response status ${htmlResponse.status} for ${path}`);
  // }
  // const [data, html] = await Promise.all([dataResponse.text(), htmlResponse.text()]);

  // return {
  //   data,
  //   html,
  // };
}
