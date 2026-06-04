import { test, expect } from "@playwright/test";

/**
 * Smoke E2E. Confirms the admin shell renders and the login flow takes the
 * owner to the dashboard. Deep transfer-flow coverage lives in the api
 * integration test (test/integration/transfer-flow.test.ts) which already
 * exercises the full state machine via real HTTP without browser overhead.
 */

test("login takes owner to the dashboard, products page loads", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("owner@example.com");
  await page.getByLabel(/password/i).fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForURL(/\/owner\/dashboard|\/$/, { timeout: 5_000 });

  // Click into Products and verify the page renders a known seeded SKU.
  await page.getByRole("link", { name: /products/i }).click();
  await expect(page.getByText("Sunrise Blend")).toBeVisible({ timeout: 5_000 });
});

test("transfers page lists transfers (may be empty)", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("owner@example.com");
  await page.getByLabel(/password/i).fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/owner|\/$/, { timeout: 5_000 });

  await page.getByRole("link", { name: /transfers/i }).click();
  await expect(page.getByText(/new transfer/i)).toBeVisible();
});

test("owner inventory cells are clickable (Adjust modal trigger)", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("owner@example.com");
  await page.getByLabel(/password/i).fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/owner|\/$/, { timeout: 5_000 });
  await page.goto("/owner/inventory");
  // The "Click any cell to adjust" hint only renders for owner.
  await expect(page.getByText(/Click any cell to adjust/i)).toBeVisible({ timeout: 5_000 });
});

test("owner sees the Bookkeeping page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("owner@example.com");
  await page.getByLabel(/password/i).fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/owner|\/$/, { timeout: 5_000 });
  await page.goto("/owner/bookkeeping");
  await expect(page.getByRole("button", { name: /add expense/i })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /^P&L$/i })).toBeVisible();
});

test("login page renders the new aesthetic-pass structure", async ({ page }) => {
  await page.goto("/login");

  // New landmarks present
  await expect(page.locator(".login__card")).toBeVisible();
  await expect(page.locator(".login__wordmark-accent")).toHaveText("Samuel");
  await expect(page.locator(".login__brand-headline")).toContainText(
    "Run your day, sunrise to shelf.",
  );

  // Old decorations removed — these locators should match nothing
  await expect(page.locator(".login__deco--bottle")).toHaveCount(0);
  await expect(page.locator(".login__deco--lemon")).toHaveCount(0);
  await expect(page.locator(".login__pill")).toHaveCount(0);
});
