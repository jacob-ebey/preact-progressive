import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      client: "./src/client.ts",
      server: "./src/server.ts",
    },
    exports: true,
    unbundle: true,
  },
  fmt: {},
  lint: {
    ignorePatterns: ["docs/guide"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
