import { expect, test } from "@playwright/test";

test("authenticated workspace reloads persisted history from the real API", async ({ page }) => {
  const token = process.env.OPES_FULLSTACK_SESSION_TOKEN;
  if (!token) throw new Error("Full-stack session fixture is missing");

  await page.goto("/");
  await page.evaluate((sessionToken) => localStorage.setItem("opes:session-token", sessionToken), token);
  await page.reload();

  await expect(page.getByRole("heading", { name: "P9 Full-stack Fixture" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invoice INV-P9-001" })).toBeVisible();
  await page.getByRole("button", { name: "View detail" }).click();
  await expect(page.getByText("invoice verified")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Invoice INV-P9-001" })).toBeVisible();
});
