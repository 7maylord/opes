import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "fullstack-workspace.spec.ts",
  globalSetup: "./e2e/fullstack-setup.ts",
  globalTeardown: "./e2e/fullstack-teardown.ts",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:3205", trace: "on-first-retry" },
  webServer: [
    {
      command: "set -a; [ ! -f .env ] || source .env; set +a; DATABASE_URL=${OPES_TEST_DATABASE_URL:-$DATABASE_URL} NODE_ENV=test PORT=3204 OPES_ALLOWED_ORIGINS=http://127.0.0.1:3205 pnpm start:dev",
      cwd: "../backend",
      url: "http://127.0.0.1:3204/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "OPES_E2E_AUTH_STUB=1 NEXT_PUBLIC_OPES_API_URL=http://127.0.0.1:3204 NEXT_PUBLIC_PRIVY_APP_ID=fixture pnpm dev --webpack --hostname 127.0.0.1 --port 3205",
      cwd: ".",
      url: "http://127.0.0.1:3205",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
