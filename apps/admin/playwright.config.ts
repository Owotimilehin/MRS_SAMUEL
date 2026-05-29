import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright runs against the locally running dev environment.
 * Prerequisites for `pnpm --filter @ms/admin test:e2e`:
 *   - Postgres + Redis are up via docker compose
 *   - apps/api dev server is running on :3001
 *   - apps/admin dev server is running on :3000
 *   - DB has been seeded (owner@example.com / ChangeMe!Owner-1234)
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3010",
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
