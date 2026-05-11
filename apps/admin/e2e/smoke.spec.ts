import { test, expect } from "@playwright/test";

/**
 * Smoke E2E. Confirms the admin shell renders and the login flow takes the
 * owner to the dashboard. Deep transfer-flow coverage lives in the api
 * integration test (test/integration/transfer-flow.test.ts) which already
 * exercises the full state machine via real HTTP without browser overhead.
 */

test("login takes owner to the dashboard, products page loads", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder(/email/i).fill("owner@example.com");
  await page.getByPlaceholder(/password/i).fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForURL(/\/owner\/dashboard|\/$/, { timeout: 5_000 });

  // Click into Products and verify the page renders a known seeded SKU.
  await page.getByRole("link", { name: /products/i }).click();
  await expect(page.getByText("Sunrise Blend")).toBeVisible({ timeout: 5_000 });
});

test("transfers page lists transfers (may be empty)", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder(/email/i).fill("owner@example.com");
  await page.getByPlaceholder(/password/i).fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/owner|\/$/, { timeout: 5_000 });

  await page.getByRole("link", { name: /transfers/i }).click();
  await expect(page.getByText(/new transfer/i)).toBeVisible();
});
