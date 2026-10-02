import type { TocEntry } from "@stefanprobst/rehype-extract-toc";
import { Hono } from "hono";
import type { ComponentType } from "preact";

import { DocsLayout } from "../components/docs-layout";
import { Hero } from "../components/hero.tsx";
import { LearnGrid } from "../components/learn-grid.tsx";

const app = new Hono();

const components = import.meta.glob<{
  default: ComponentType;
  tableOfContents: TocEntry[];
}>("../../content/**/*.mdx");

const docs = new Map(
  Object.entries(components).map(([key, value]) => {
    const name = key.replace(/\.\.\/\.\.\/content\//, "").replace(/\.mdx$/, "");
    return [name === "_" ? "/" : `/${name}`, value];
  }),
);

app.get("*", async (c) => {
  const url = new URL(c.req.url);
  const doc = docs.get(url.pathname);

  if (!doc) {
    return c.notFound();
  }

  const { default: Doc, tableOfContents } = await doc();

  const title =
    tableOfContents?.[0]?.value ?? (url.pathname === "/" ? "Getting Started" : url.pathname);

  return c.render(
    <DocsLayout pathname={url.pathname} tableOfContents={tableOfContents}>
      {url.pathname === "/" ? <Hero /> : null}
      <article
        data-pagefind-body
        class="prose prose-zinc max-w-none pt-8 dark:prose-invert prose-headings:font-display prose-headings:tracking-tight prose-headings:text-zinc-900 prose-a:font-medium prose-a:text-indigo-600 prose-a:decoration-indigo-200 prose-a:underline-offset-4 hover:prose-a:text-indigo-700 hover:prose-a:decoration-indigo-400 prose-pre:rounded-xl prose-pre:border prose-pre:border-zinc-200 prose-pre:shadow-sm dark:prose-headings:text-white dark:prose-a:text-indigo-400 dark:prose-a:decoration-indigo-900 dark:hover:prose-a:text-indigo-300 dark:prose-pre:border-zinc-800"
        key={url.pathname}
      >
        <title>{title} | Docs</title>
        <meta name="description" content={`${title} – preact-progressive documentation.`} />
        <Doc />
      </article>
      {url.pathname === "/" ? <LearnGrid /> : null}
    </DocsLayout>,
  );
});

export default app;
