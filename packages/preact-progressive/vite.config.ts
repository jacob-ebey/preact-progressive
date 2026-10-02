import * as path from "node:path";

import { defineConfig, minifySync, transformWithOxc, type Plugin } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      client: "./src/client.ts",
      decoder: "./src/decoder.ts",
      encoder: "./src/encoder.ts",
      router: "./src/router.ts",
      server: "./src/server.ts",
    },
    exports: true,
    plugins: [virtualClientRuntime()],
    unbundle: true,
  },
  test: {
    projects: [
      {
        test: {
          setupFiles: "./src/test/setup.ts",
        },
        plugins: [virtualClientRuntime()],
      },
    ],
  },
  fmt: {},
  lint: {
    ignorePatterns: ["docs/guide"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});

function virtualClientRuntime() {
  return {
    name: "virtual-client-runtime",
    enforce: "pre",
    resolveId: {
      order: "pre",
      async handler(id) {
        if (id !== "virtual:client-runtime") return;
        return "\0virtual:client-runtime";
      },
    },
    async load(id) {
      if (id === "\0virtual:client-runtime") {
        const file = path.resolve("src/client-runtime.ts");
        const code = await this.fs.readFile(file, {
          encoding: "utf8",
        });
        const transformed = await transformWithOxc(code, file);
        const minified = minifySync(id, transformed.code);
        if (minified.errors.length) {
          this.error(minified.errors[0]);
        }
        return `export default ${JSON.stringify(minified.code)};`;
      }
    },
  } satisfies Plugin;
}
