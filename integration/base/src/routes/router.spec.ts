import { test, expect } from "@playwright/test";

test("router can navigate", async ({ page }) => {
  await page.goto("/router", { waitUntil: "networkidle" });

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

  await incrementCounter("layout", 0);
  await incrementCounter("layout", 1);
  await incrementCounter("counter", 0);
  await incrementCounter("counter", 1);

  await page
    .getByRole("link", {
      name: "About",
    })
    .click();

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "About!",
    }),
  ).toBeVisible();

  await incrementCounter("layout", 2);
  await incrementCounter("layout", 3);
  await incrementCounter("counter", 2);
  await incrementCounter("counter", 3);

  await page
    .getByRole("link", {
      name: "Async",
    })
    .click();
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Async!",
    }),
  ).toBeVisible();

  await incrementCounter("layout", 4);
  await incrementCounter("layout", 5);
  await incrementCounter("counter", 4);
  await incrementCounter("counter", 5);
});
