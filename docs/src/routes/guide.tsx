import type { TocEntry } from "@stefanprobst/rehype-extract-toc";
import { Hono } from "hono";
import type { ComponentType } from "preact";

import importmap from "../importmap/importmap.ts";
import { GuideLayout, type GuideStep } from "../components/guide-layout";

const app = new Hono();

const guideSteps = import.meta.glob<{
  default: ComponentType;
  tableOfContents: TocEntry[];
}>("../../guide/*/guide.md");

const guideSource = import.meta.glob<string>("../../guide/*/*.tsx", {
  query: "?raw",
  import: "default",
});

const guideStepName = (dir: string) =>
  dir
    .replace(/^\d+-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const guideOrder: GuideStep[] = Object.keys(guideSteps)
  .map((key) => key.replace(/\.\.\/\.\.\/guide\//, "").replace(/\/guide\.md$/, ""))
  .sort()
  .map((dir, index) => ({
    href: `/guide/${dir}`,
    number: index + 1,
    name: guideStepName(dir),
  }));

app.get("/guide/:step", async (c) => {
  const step = c.req.param("step");
  const entry = guideSteps[`../../guide/${step}/guide.md`];

  if (!entry) return c.notFound();

  const { default: Guide } = await entry();
  const start = (await guideSource[`../../guide/${step}/start.tsx`]?.()) ?? "";
  const solution = (await guideSource[`../../guide/${step}/solution.tsx`]?.()) ?? "";

  const index = guideOrder.findIndex((s) => s.href === `/guide/${step}`);
  const current = guideOrder[index];
  const pathname = `/guide/${step}`;

  return c.render(
    <GuideLayout
      step={current}
      steps={guideOrder}
      previous={guideOrder[index - 1]}
      next={guideOrder[index + 1]}
      start={start}
      solution={solution}
      pathname={pathname}
      importmap={importmap}
    >
      <article key={pathname} data-pagefind-body>
        <title>{current.name} | Guide</title>
        <meta
          name="description"
          content={`Step ${current.number} of ${guideOrder.length}: ${current.name} in the preact-progressive guide.`}
        />
        <Guide />
      </article>
    </GuideLayout>,
  );
});

export default app;
