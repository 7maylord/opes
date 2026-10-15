import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "fullstack-workspace.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },
  webServer: {
    command: "OPES_E2E_AUTH_STUB=1 NEXT_PUBLIC_OPES_API_URL=http://mock.api NEXT_PUBLIC_PRIVY_APP_ID=fixture pnpm dev --webpack --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
});
