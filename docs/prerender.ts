import * as fs from "node:fs";
import * as path from "node:path";

// @ts-expect-error - no types
import { prerender } from "./dist/ssr/index.js";

const TO_PRERENDER = ["/"];

for (const entry of fs.globSync("content/*/**/*.mdx")) {
  TO_PRERENDER.push("/" + entry.replace(/^content\//, "").replace(/\.mdx$/, ""));
}

for (const entry of fs.globSync("guide/*/guide.md")) {
  TO_PRERENDER.push("/guide/" + entry.replace(/^guide\//, "").replace(/\/guide\.md$/, ""));
}

for (const entry of fs.globSync("../packages/*/docs/*.md")) {
  TO_PRERENDER.push(
    "/reference/" + entry.replace(/^\.\.\/packages\//, "").replace(/\/docs\//, "/").replace(/\.md$/, ""),
  );
}

async function doPrerender(pathname: string) {
  const { data, html } = await prerender(pathname);

  const dataFile = `dist/client${pathname === "/" ? "/_.data" : `${pathname}.data`}`;
  const htmlFile = `dist/client${pathname === "/" ? "/index.html" : `${pathname}/index.html`}`;

  fs.mkdirSync(path.dirname(htmlFile), { recursive: true });
  fs.writeFileSync(dataFile, data, "utf-8");
  fs.writeFileSync(htmlFile, html, "utf-8");
}

await Promise.all(TO_PRERENDER.map(doPrerender));
