import { defineConfig } from "@playwright/test";

/**
 * Runs the integration against `rsbuild dev`. Dev keeps ESM output (rsbuild's
 * HMR runtime needs ESM chunk loading), so this guards the dev path against
 * the production JSONP configuration regressing it.
 */
export default defineConfig({
  testDir: "../base/src",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/basic-use-client",
    reuseExistingServer: !process.env.CI,
  },
});
