import { test, expect } from "@playwright/test";

test("applies styles", async ({ page }) => {
  await page.goto("/basic-use-client");

  const body = page.locator("body");
  const minHeightSet = await body.evaluate(
    (el) => window.getComputedStyle(el).minHeight === window.innerHeight + "px",
  );
  expect(minHeightSet).toBe(true);
});
