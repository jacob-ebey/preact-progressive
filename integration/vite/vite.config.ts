import fullstack from "@hiogawa/vite-plugin-fullstack";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
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
          },
        },
      },
      optimizeDeps: {
        entries: ["./src/entry.client.ts"],
      },
    },
    ssr: {
      build: {
        outDir: "./dist/ssr",
        emitAssets: true,
        rolldownOptions: {
          input: {
            index: "./src/entry.server.ts",
          },
        },
      },
      resolve: {
        external: ["hono"],
        noExternal: true,
      },
    },
  },
  plugins: [
    tailwindcss(),
    preactProgressive(),
    preact({ exclude: ["**/preact-progressive/dist/**"] }),
    fullstack(),
  ],
  fmt: {},
  lint: {
    ignorePatterns: ["docs/guide"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
