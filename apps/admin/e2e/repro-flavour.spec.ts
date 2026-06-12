import { test, expect, type Page } from "@playwright/test";

// Regression guard for the "invalid request on creating a flavour" bug.
// Root cause: the slug input's pattern `^[a-z0-9-]+$` failed to compile under
// Chromium's `v`-flag regex engine (bare `-` in a class), which silently
// disabled native validation; a messy slug then reached the API and was
// rejected with a bare "invalid request". Fix: escape the dash AND normalise
// the slug as the owner types so an invalid address is impossible.

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

test("a messy flavour slug self-corrects and the create succeeds", async ({ page }) => {
  const errors = trackErrors(page);
  await loginOwner(page);
  await page.goto("/owner/products");
  await page.getByRole("button", { name: /New flavour/i }).click();

  const form = page.locator("form");
  await form.locator("input").first().fill("Pineapple Punch");
  // Exactly what a non-technical owner would type into the address box.
  const slug = form.locator("input[pattern]").first();
  await slug.fill(`Pineapple Punch! ${Date.now()}`);

  // The field normalises to a valid web address on its own.
  expect(await slug.inputValue()).toMatch(/^[a-z0-9-]+$/);
  expect(await slug.evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(true);

  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/v1/products") && r.request().method() === "POST",
      { timeout: 15_000 },
    ),
    page.getByRole("button", { name: /Create flavour/i }).click(),
  ]);
  expect(resp.status()).toBe(201);

  // The broken-regex console error must be gone.
  expect(errors.find((e) => /Invalid regular expression/i.test(e))).toBeUndefined();
});
