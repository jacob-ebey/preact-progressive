import { defineConfig } from "@rsbuild/core";
import { pluginPreact } from "@rsbuild/plugin-preact";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";

import preactProgressive from "rsbuild-plugin-preact-progressive";

export default defineConfig({
  environments: {
    client: {
      source: {
        entry: {
          index: { import: "./src/entry.client.ts", html: false },
        },
      },
    },
    ssr: {
      source: {
        entry: {
          index: "./src/entry.server.ts",
        },
      },
      output: {
        target: "node",
      },
    },
  },
  plugins: [
    pluginTailwindcss(),
    preactProgressive(),
    pluginPreact({
      prefreshEnabled: true,
      preactRefreshOptions: {
        exclude: [/[\\/]node_modules[\\/]/, "**/preact-progressive/dist/**"],
      },
    }),
  ],
});
