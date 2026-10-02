import type { TocEntry } from "@stefanprobst/rehype-extract-toc";
import { Hono } from "hono";
import type { ComponentType } from "preact";

import { DocsLayout } from "../components/docs-layout";

const app = new Hono();

function formatDocs(
  pkg: string,
  components: Record<
    string,
    () => Promise<{
      default: ComponentType;
      tableOfContents: TocEntry[];
    }>
  >,
) {
  return Object.fromEntries(
    Object.entries(components).map(([key, value]) => {
      const name = key
        .replace(new RegExp(`\\.\\.\\/\\.\\.\\/\\.\\.\\/packages\\/${pkg}\\/docs\\/`), "")
        .replace(/\.md$/, "");
      return [name, value];
    }),
  );
}

const docs: Record<
  string,
  Record<
    string,
    () => Promise<{
      default: ComponentType;
      tableOfContents: TocEntry[];
    }>
  >
> = {
  babel: formatDocs(
    "babel",
    import.meta.glob<{
      default: ComponentType;
      tableOfContents: TocEntry[];
    }>("../../../packages/babel/docs/*.md"),
  ),
  hono: formatDocs(
    "hono",
    import.meta.glob<{
      default: ComponentType;
      tableOfContents: TocEntry[];
    }>("../../../packages/hono/docs/*.md"),
  ),
  "preact-progressive": formatDocs(
    "preact-progressive",
    import.meta.glob<{
      default: ComponentType;
      tableOfContents: TocEntry[];
    }>("../../../packages/preact-progressive/docs/*.md"),
  ),
  "rsbuild-plugin": formatDocs(
    "rsbuild-plugin",
    import.meta.glob<{
      default: ComponentType;
      tableOfContents: TocEntry[];
    }>("../../../packages/rsbuild-plugin/docs/*.md"),
  ),
  "vite-plugin": formatDocs(
    "vite-plugin",
    import.meta.glob<{
      default: ComponentType;
      tableOfContents: TocEntry[];
    }>("../../../packages/vite-plugin/docs/*.md"),
  ),
};

app.get("/reference/:pkg/:doc", async (c) => {
  const url = new URL(c.req.url);
  const doc = docs[c.req.param("pkg")][c.req.param("doc")];

  if (!doc) {
    return c.notFound();
  }

  const { default: Doc, tableOfContents } = await doc();

  const pkg = c.req.param("pkg");
  const name = c.req.param("doc");
  const packageName =
    pkg === "babel"
      ? "babel-plugin-preact-progressive"
      : pkg === "hono"
        ? "hono-preact-progressive"
        : pkg === "rsbuild-plugin"
          ? "rsbuild-plugin-preact-progressive"
          : pkg === "vite-plugin"
            ? "vite-plugin-preact-progressive"
            : "preact-progressive";
  const title =
    pkg === "hono" || pkg === "rsbuild-plugin" || pkg === "vite-plugin"
      ? packageName
      : `${packageName}/${name}`;

  return c.render(
    <DocsLayout pathname={url.pathname} tableOfContents={tableOfContents}>
      <div class="not-prose mb-6 flex flex-wrap items-center gap-2">
        <span class="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {packageName}
        </span>
        <span class="rounded-full bg-indigo-600/10 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-400/10 dark:text-indigo-300">
          Reference
        </span>
      </div>
      <article
        data-pagefind-body
        class="prose prose-zinc max-w-none dark:prose-invert prose-headings:font-display prose-headings:tracking-tight prose-headings:text-zinc-900 prose-a:font-medium prose-a:text-indigo-600 prose-a:decoration-indigo-200 prose-a:underline-offset-4 hover:prose-a:text-indigo-700 prose-pre:rounded-xl prose-pre:border prose-pre:border-zinc-200 dark:prose-headings:text-white dark:prose-a:text-indigo-400 dark:prose-pre:border-zinc-800"
        key={url.pathname}
      >
        <title>{title} | Reference</title>
        <meta name="description" content={`API reference for ${title}.`} />
        <h1>{title}</h1>
        <Doc />
      </article>
    </DocsLayout>,
  );
});

export default app;
