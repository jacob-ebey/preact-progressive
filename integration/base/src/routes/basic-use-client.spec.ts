import { test, expect } from "@playwright/test";

test("basic-use-client", async ({ page }) => {
  await page.goto("/basic-use-client", { waitUntil: "networkidle" });

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Hello, World!",
    }),
  ).toBeVisible();

  const incrementCounter = async (id: string, count: number) => {
    const button = page.getByTestId(id);
    await expect(button).toBeVisible();
    await expect(button).toHaveText(`${id}: ${count}`);
    await button.click();
    await expect(button).toHaveText(`${id}: ${count + 1}`);
  };

  await incrementCounter("counter", 0);
  await incrementCounter("counter", 1);
  await incrementCounter("inline-counter", 0);
  await incrementCounter("inline-counter", 1);
  await incrementCounter("event-counter", 0);
  await incrementCounter("event-counter", 1);
});
