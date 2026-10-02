import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../base/src",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: "http://127.0.0.1:3001",
  },
  webServer: {
    command: "pnpm build && pnpm start",
    port: 3001,
    reuseExistingServer: !process.env.CI,
  },
});
