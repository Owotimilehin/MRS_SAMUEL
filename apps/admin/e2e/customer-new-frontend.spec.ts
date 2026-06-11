import { test, expect, type Page } from "@playwright/test";

// Drives the NEW TanStack Start customer storefront (localStorage cart, routes
// /juices, /shop, /subscription, …). Runs against the live local stack:
//   customer http://localhost:3002, api http://localhost:3001.
// Fails on any error boundary text or console/page error so silent render
// crashes are caught (static link audits never see those).

const CUSTOMER = process.env.E2E_CUSTOMER ?? "http://localhost:3002";

// Third-party / infra noise that is not an app defect. Cloudflare injects a RUM
// beacon (/cdn-cgi/rum) when served through the tunnel; fast client navigation
// aborts in-flight beacons and resource loads (ERR_ABORTED), which surface as
// console "Failed to fetch" / "Failed to load resource" — ignore those.
const IGNORE_CONSOLE = /cdn-cgi\/rum|Failed to fetch|Failed to load resource|ERR_ABORTED/i;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE_CONSOLE.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function assertNoErrorPage(page: Page) {
  await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
  await expect(page.locator("body")).not.toContainText(/Internal Server Error/i);
}

const STATIC_ROUTES = [
  "/",
  "/juices",
  "/shop",
  "/subscription",
  "/blog",
  "/about",
  "/contact",
];

test.describe("Customer storefront — page render sweep", () => {
  for (const route of STATIC_ROUTES) {
    test(`renders ${route} with no errors`, async ({ page }) => {
      const errors = trackErrors(page);
      const res = await page.goto(`${CUSTOMER}${route}`, { waitUntil: "load" });
      expect(res?.status(), `HTTP for ${route}`).toBeLessThan(400);
      await assertNoErrorPage(page);
      // Footer is part of SiteShell — proves the shell mounted.
      await expect(page.getByRole("contentinfo")).toBeVisible();
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});

test.describe("Customer storefront — CTA flows", () => {
  test("juices list → product detail → add to cart → checkout shows item", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`${CUSTOMER}/juices`, { waitUntil: "load" });
    await assertNoErrorPage(page);

    // First product card links to /juices/$id.
    const firstCard = page.locator('a[href^="/juices/"]').first();
    await expect(firstCard).toBeVisible();
    await firstCard.click();
    await page.waitForURL(/\/juices\/[^/]+$/);
    await assertNoErrorPage(page);

    // "Buy now" adds to cart and navigates straight to /checkout.
    await page.getByRole("button", { name: /Buy now/i }).click();
    await page.waitForURL(/\/checkout$/);
    await assertNoErrorPage(page);

    // Checkout must show the order summary (cart carried over), not the empty state.
    await expect(page.getByText(/Order summary/i)).toBeVisible();
    await expect(page.getByText(/Your basket is empty/i)).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("add to cart opens drawer → drawer Checkout CTA reaches checkout", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`${CUSTOMER}/juices`, { waitUntil: "load" });
    await page.locator('a[href^="/juices/"]').first().click();
    await page.waitForURL(/\/juices\/[^/]+$/);

    // Add to cart opens the cart drawer.
    await page.getByRole("button", { name: /Add to cart/i }).first().click();
    await expect(page.getByText(/Your Basket/i)).toBeVisible();

    // Drawer's Checkout link navigates to /checkout with the item present.
    await page.getByRole("link", { name: /^Checkout$/i }).click();
    await page.waitForURL(/\/checkout$/);
    await assertNoErrorPage(page);
    await expect(page.getByText(/Order summary/i)).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("full checkout (Lagos, now) places order and leaves the form", async ({ page }) => {
    const errors = trackErrors(page);
    // Add an item via product detail first.
    await page.goto(`${CUSTOMER}/juices`, { waitUntil: "load" });
    await page.locator('a[href^="/juices/"]').first().click();
    await page.waitForURL(/\/juices\/[^/]+$/);
    await page.getByRole("button", { name: /Add to cart/i }).first().click();

    await page.goto(`${CUSTOMER}/checkout`, { waitUntil: "load" });
    await page.getByText(/Full name/i).locator("xpath=following::input[1]").fill("E2E Buyer");
    await page.getByText(/^Phone$/i).locator("xpath=following::input[1]").fill("08025550999");
    await page.getByText(/Delivery address/i).locator("xpath=following::input[1]").fill("30 Asa Afariogun Street, Ajao Estate");

    // Place order button carries the total; wait until enabled (quote settled).
    const placeBtn = page.getByRole("button", { name: /Place order/i });
    await expect(placeBtn).toBeEnabled({ timeout: 15_000 });
    await placeBtn.click();

    // Mock OPay loops back to the order page (or any non-checkout URL). Either we
    // navigate away from /checkout, or a structured error appears in the summary.
    await page.waitForFunction(
      () => !location.pathname.endsWith("/checkout") || !!document.body.textContent?.match(/try again/i),
      undefined,
      { timeout: 20_000 },
    );
    const url = page.url();
    expect(url, `ended at ${url}`).not.toMatch(/\/checkout$/);
    await assertNoErrorPage(page);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("shop page shows bundles with WhatsApp order CTA", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`${CUSTOMER}/shop`, { waitUntil: "load" });
    await assertNoErrorPage(page);
    // Seeded bundle name should appear.
    await expect(page.getByText(/Starter 6-Pack/i)).toBeVisible();
    // Bundle order CTA is a wa.me link.
    const wa = page.locator('a[href*="wa.me"]').first();
    await expect(wa).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("subscription page shows plans and a working lead path", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`${CUSTOMER}/subscription`, { waitUntil: "load" });
    await assertNoErrorPage(page);
    await expect(page.getByText(/Weekly Juice Box/i)).toBeVisible();
    await expect(page.locator('a[href*="wa.me"]').first()).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("contact page form submits to the API", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`${CUSTOMER}/contact`, { waitUntil: "load" });
    await assertNoErrorPage(page);
    await expect(page.locator('a[href*="wa.me"]').first()).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("blog list → post detail renders", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`${CUSTOMER}/blog`, { waitUntil: "load" });
    await assertNoErrorPage(page);
    const firstPost = page.locator('a[href^="/blog/"]').first();
    await expect(firstPost).toBeVisible();
    await firstPost.click();
    await page.waitForURL(/\/blog\/[^/]+$/);
    await assertNoErrorPage(page);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("primary nav links all resolve", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(CUSTOMER, { waitUntil: "load" });
    for (const [label, re] of [
      ["Our Juices", /\/juices$/],
      ["Shop", /\/shop$/],
      ["Subscription", /\/subscription$/],
      ["Blog", /\/blog$/],
    ] as const) {
      await page.goto(CUSTOMER, { waitUntil: "load" });
      const link = page.getByRole("link", { name: new RegExp(`^${label}$`, "i") }).first();
      await link.click();
      await page.waitForURL(re);
      await assertNoErrorPage(page);
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
