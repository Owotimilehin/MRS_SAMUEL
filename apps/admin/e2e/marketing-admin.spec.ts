import { test, expect, type Page } from "@playwright/test";

// Exercises the new admin storefront management pages: subscription plans,
// bundles, and the leads inbox. Runs against the live local admin (:3010) + API.

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function loginOwner(page: Page) {
  await page.goto("/login");
  await page.locator("#email").fill("owner@example.com");
  await page.locator("#password").fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/owner|\/$/, { timeout: 20_000 });
}

test("Subscriptions page lists plans and opens the New plan modal", async ({ page }) => {
  const errors = trackErrors(page);
  await loginOwner(page);
  await page.goto("/owner/subscriptions");
  await expect(page.locator(".app-head__title", { hasText: /Subscriptions/i })).toBeVisible({ timeout: 8_000 });
  // Seeded plan visible.
  await expect(page.getByText(/Weekly Juice Box/i)).toBeVisible();
  // New plan CTA opens the modal form.
  await page.getByRole("button", { name: /New plan/i }).click();
  await expect(page.getByRole("button", { name: /Create plan/i })).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("Bundles page lists bundles and opens the New bundle modal", async ({ page }) => {
  const errors = trackErrors(page);
  await loginOwner(page);
  await page.goto("/owner/bundles");
  await expect(page.locator(".app-head__title", { hasText: /Bundles/i })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(/Starter 6-Pack/i)).toBeVisible();
  await page.getByRole("button", { name: /New bundle/i }).click();
  await expect(page.getByRole("button", { name: /Create bundle/i })).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("Leads page renders both inbox tabs", async ({ page }) => {
  const errors = trackErrors(page);
  await loginOwner(page);
  await page.goto("/owner/leads");
  await expect(page.locator(".app-head__title", { hasText: /Leads/i })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("button", { name: /Subscription enquiries/i })).toBeVisible();
  // Switch to the contact tab.
  await page.getByRole("button", { name: /Contact messages/i }).click();
  await expect(page.getByRole("button", { name: /Contact messages/i })).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("Subscriptions create + delete round-trips through the API", async ({ page }) => {
  const errors = trackErrors(page);
  await loginOwner(page);
  await page.goto("/owner/subscriptions");
  await page.getByRole("button", { name: /New plan/i }).click();

  const uniq = `e2e-plan-${Date.now()}`;
  const form = page.locator("form");
  await form.locator("input").first().fill("E2E Plan");
  // Slug auto-fills from name; override to a guaranteed-unique value.
  await form.locator("input[pattern]").fill(uniq);
  await form.locator('input[type="number"]').first().fill("9999");
  await form.locator('input[placeholder="/week"]').fill("/month");

  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/v1/marketing/subscription-plans") && r.request().method() === "POST",
      { timeout: 10_000 },
    ),
    page.getByRole("button", { name: /Create plan/i }).click(),
  ]);
  expect(resp.status()).toBe(201);
  await expect(page.getByText("E2E Plan")).toBeVisible({ timeout: 8_000 });

  // Clean up: delete the row we just made (confirm dialog auto-accept).
  page.on("dialog", (d) => void d.accept());
  const row = page.locator("tr", { hasText: "E2E Plan" });
  await row.getByRole("button", { name: /^Delete$/ }).click();
  await expect(page.getByText("E2E Plan")).toHaveCount(0, { timeout: 8_000 });
  expect(errors, errors.join("\n")).toEqual([]);
});
