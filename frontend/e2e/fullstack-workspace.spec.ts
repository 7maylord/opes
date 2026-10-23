import { expect, test } from "@playwright/test";

test("authenticated workspace reloads persisted history from the real API", async ({ page }) => {
  const token = process.env.OPES_FULLSTACK_SESSION_TOKEN;
  if (!token) throw new Error("Full-stack session fixture is missing");

  await page.goto("/");
  await page.evaluate((sessionToken) => {
    localStorage.setItem("opes:session-token", sessionToken);
    // The normal sign-in journey creates an embedded owner wallet before the
    // OPES session is restored. Reproduce that persisted browser state here.
    localStorage.setItem("opes:e2e-wallet-created", "1");
    window.dispatchEvent(new Event("opes-storage"));
    window.dispatchEvent(new Event("opes-e2e-wallet"));
  }, token);
  await page.reload();

  await expect(page.getByRole("heading", { name: "P9 Full-stack Fixture" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invoice INV-P9-001" })).toBeVisible();
  await page.getByRole("button", { name: "View detail" }).click();
  await expect(page.getByText("invoice verified")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "P9 Full-stack Fixture" })).toBeVisible();
  await expect(page.getByText("Invoice INV-P9-001", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View detail" }).click();
  await expect(page.getByRole("heading", { name: "Invoice INV-P9-001" })).toBeVisible();
});
