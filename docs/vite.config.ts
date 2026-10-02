import { cloudflare } from "@cloudflare/vite-plugin";
import fullstack from "@hiogawa/vite-plugin-fullstack";
import mdx from "@mdx-js/rollup";
import preact from "@preact/preset-vite";
import withToc from "@stefanprobst/rehype-extract-toc";
import withTocExport from "@stefanprobst/rehype-extract-toc/mdx";
import tailwindcss from "@tailwindcss/vite";
import withSlugs from "rehype-slug";
import remarkGfm from "remark-gfm";
import devtoolsJson from "vite-plugin-devtools-json";
import { defineConfig } from "vite-plus";

import preactProgressive from "vite-plugin-preact-progressive";

export default defineConfig({
  environments: {
    client: {
      build: {
        manifest: true,
        outDir: "./dist/client",
        rolldownOptions: {
          input: {
            index: "./src/entry.client.ts",
            preact: "./src/importmap/preact.ts",
            "preact-progressive": "./src/importmap/preact-progressive.client.ts",
          },
        },
      },
      optimizeDeps: {
        entries: [
          "./src/entry.client.ts",
          "./src/components/guide-editor.tsx",
          "./src/components/guide-workspace.tsx",
          "./src/components/ts-worker.ts",
        ],
      },
    },
    ssr: {
      build: {
        outDir: "./dist/ssr",
        emitAssets: true,
        rolldownOptions: {
          input: {
            index: "./src/entry.server.tsx",
          },
        },
      },
      optimizeDeps: {
        entries: ["./src/entry.server.tsx"],
      },
    },
  },
  resolve: {
    alias: {
      // @valtown/codemirror-ts imports "typescript" expecting the JS compiler
      // API; the project's "typescript" is the native (Go) CLI whose module
      // entry is just a version stub. Point it at the JS API build instead.
      typescript: "ts-js",
    },
  },
  css: {
    postcss: {
      plugins: [
        {
          postcssPlugin: "microlighter",
          Declaration(decl) {
            if (decl.parent?.type === "rule" && decl.parent.selector.includes("::highlight")) {
              decl.important = true;
            }
          },
        },
      ],
    },
  },
  plugins: [
    tailwindcss(),
    mdx({
      jsxImportSource: "preact",
      remarkPlugins: [remarkGfm],
      rehypePlugins: [withSlugs, withToc, withTocExport],
    }),
    preactProgressive(),
    preact({ exclude: ["**/preact-progressive/dist/**"] }),
    fullstack({ serverHandler: false }),
    devtoolsJson(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
    }),
  ],
  fmt: {},
  lint: {
    ignorePatterns: ["docs/guide"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
