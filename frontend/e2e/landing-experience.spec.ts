import { expect, test } from "@playwright/test";

test("visitors can trace an illustrative payment and open Privy from either primary action", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Money moves.",
  );
  await page.getByRole("link", { name: "Follow a payment" }).click();
  const stages = page.getByRole("group", { name: "Payment stages" });
  await stages.getByRole("button", { name: "03 Route" }).click();
  await page.getByRole("button", { name: "USDT", exact: true }).click();
  await expect(
    page.getByText("USDC · Circle Gateway · USDT swap", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "USDT", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await stages.getByRole("button", { name: "04 Record" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Reconciled", { exact: true })).toBeVisible();
  await expect(
    page.getByText("EXAMPLE ONLY / NOT A TRANSACTION"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Make your next move" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opes:e2e-login-opened"))).toBe("1");
  await page.evaluate(() => localStorage.removeItem("opes:e2e-login-opened"));
  await page.getByRole("button", { name: "Enter workspace" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opes:e2e-login-opened"))).toBe("1");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("the instrument can be paused and respects reduced motion", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const orbit = page.locator('svg[viewBox="0 0 600 600"]');
  const instrument = page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: "Pause motion" }) })
    .filter({ has: orbit })
    .last();
  if (!isMobile) {
    await instrument.hover({ position: { x: 70, y: 100 } });
    await expect(instrument).toHaveAttribute("style", /--ry:/);
  }
  await page.getByRole("button", { name: "Pause motion" }).click();
  await expect(orbit).toHaveCSS("animation-play-state", "paused");
  await expect(
    page.getByRole("button", { name: "Resume motion" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Resume motion" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(orbit).toHaveCSS("animation-name", "none");
  await page
    .getByRole("group", { name: "Payment stages" })
    .getByRole("button", { name: "02 Policy" })
    .click();
  await expect(page.getByText("Human approval recorded")).toBeVisible();
});
