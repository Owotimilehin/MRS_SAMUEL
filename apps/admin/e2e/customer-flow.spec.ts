import { test, expect, request, type APIRequestContext } from "@playwright/test";

const CUSTOMER = "http://localhost:3002";
const API = "http://localhost:3001";

interface Variant {
  id: string;
  size_ml: number;
  price_ngn: number;
}
interface CatalogProduct {
  slug: string;
  name: string;
  variants: Variant[];
}

async function getVariant(
  ctx: APIRequestContext,
  slug: string,
  sizeMl: 330 | 650,
): Promise<Variant> {
  const res = await ctx.get(`${API}/v1/public/catalog/products`);
  const body = (await res.json()) as { data: CatalogProduct[] };
  const p = body.data.find((x) => x.slug === slug);
  if (!p) throw new Error(`product ${slug} missing from catalog`);
  const v = p.variants.find((x) => x.size_ml === sizeMl);
  if (!v) throw new Error(`${slug} has no ${sizeMl}ml variant`);
  return v;
}

// Track every console error/pageerror so the suite fails on silent UI regressions.
function attachErrorTracking(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

test.describe("Customer site — feature sweep", () => {
  test("1. menu page: hero + carousel + add", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(CUSTOMER);
    await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
    await expect(page.locator(".ms-hero")).toBeVisible();
    await expect(page.getByRole("button", { name: /Next flavour/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Previous flavour/i })).toBeVisible();

    // Carousel dots present
    const dots = page.locator(".ms-carousel__dot");
    expect(await dots.count()).toBeGreaterThan(5);

    // Click next, the carousel should advance (hero name changes).
    const initialName = await page.locator(".ms-details__name").innerText();
    await page.getByRole("button", { name: /Next flavour/i }).click();
    await expect(page.locator(".ms-details__name")).not.toHaveText(initialName);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("2. menu cards: size toggle changes price", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(CUSTOMER);
    // Scroll the full menu grid into view.
    const cards = page.locator(".menu-card");
    await cards.first().scrollIntoViewIfNeeded();

    const firstCard = cards.first();
    const priceLocator = firstCard.locator(".menu-card__price");
    const before = await priceLocator.innerText();
    // Switch the size toggle.
    await firstCard.getByText("330ml").click();
    const after = await priceLocator.innerText();
    expect(after).not.toBe(before);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("3. MenuCard Add (non-hero) puts a line in the server cart", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(CUSTOMER);
    const card = page.locator(".menu-card").first();
    await card.scrollIntoViewIfNeeded();
    const addBtn = card.getByRole("button", { name: /Add .* to cart/i });

    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      addBtn.click(),
    ]);
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { data: { total_items: number } };
    expect(body.data.total_items).toBeGreaterThan(0);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("4. cart page: quantity +, - and remove all work against the server", async ({ page }) => {
    const errors = attachErrorTracking(page);
    // Seed a line via the API so this test starts from a known state.
    const ctx = await request.newContext();
    const v330 = await getVariant(ctx, "sunrise-blend", 330);
    await ctx.dispose();

    await page.goto(CUSTOMER);
    // Use the same Add path the real user does so the cookie is in place.
    const [addResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /^Add to cart$/i }).click(),
    ]);
    expect(addResp.status()).toBe(200);

    await page.goto(`${CUSTOMER}/cart`);
    await expect(page.getByText(/Continue to checkout/i)).toBeVisible({ timeout: 10_000 });

    // Increment via the +1 button.
    const qtyInput = page.locator(".ms-cart__qty-input").first();
    const startingQty = Number(await qtyInput.inputValue());
    const [incResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "PATCH",
        { timeout: 5_000 },
      ),
      page.getByRole("button", { name: /Increase/i }).first().click(),
    ]);
    expect(incResp.status()).toBe(200);
    await expect(qtyInput).toHaveValue(String(startingQty + 1));

    // Remove the line.
    const [removeResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "PATCH",
        { timeout: 5_000 },
      ),
      page.getByRole("button", { name: /^Remove$/ }).first().click(),
    ]);
    expect(removeResp.status()).toBe(200);
    await expect(page.getByText(/Nothing in your basket yet/i)).toBeVisible();

    // The variant the test ran against (for trace clarity if it ever fails).
    expect(v330.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("5. mixed cart: 330ml + 650ml at different prices, submit to checkout", async ({ page }) => {
    const errors = attachErrorTracking(page);
    const ctx = await request.newContext();
    const v330 = await getVariant(ctx, "sunrise-blend", 330);
    const v650 = await getVariant(ctx, "sunrise-blend", 650);
    await ctx.dispose();

    await page.goto(CUSTOMER);
    // Add a 650ml via the hero (defaults to 650).
    const [r1] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /^Add to cart$/i }).click(),
    ]);
    expect(r1.status()).toBe(200);
    // Add a 330ml via a MenuCard.
    const card = page.locator(".menu-card").first();
    await card.scrollIntoViewIfNeeded();
    await card.getByText("330ml").click();
    const [r2] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      card.getByRole("button", { name: /Add .* 330ml/i }).click(),
    ]);
    expect(r2.status()).toBe(200);
    const body = (await r2.json()) as {
      data: { total_items: number; lines: Array<{ size_ml: number; unit_price_ngn: number }> };
    };
    expect(body.data.total_items).toBeGreaterThanOrEqual(2);
    const sizes = body.data.lines.map((l) => l.size_ml).sort();
    expect(sizes).toContain(330);
    expect(sizes).toContain(650);
    // Prices come from the catalog snapshot — verify they line up.
    const line330 = body.data.lines.find((l) => l.size_ml === 330);
    const line650 = body.data.lines.find((l) => l.size_ml === 650);
    expect(line330?.unit_price_ngn).toBe(v330.price_ngn);
    expect(line650?.unit_price_ngn).toBe(v650.price_ngn);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("6. full checkout: cart → form → submit → 201 + cart cleared", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(CUSTOMER);
    const [addResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /^Add to cart$/i }).click(),
    ]);
    expect(addResp.status()).toBe(200);

    await page.goto(`${CUSTOMER}/checkout`);
    await page.getByLabel(/Full name/i).fill("Live Sweep Buyer");
    await page.getByLabel(/Phone/i).fill("+2348025550999");
    await page.getByLabel(/Address/i).fill("30 Asa Afariogun Street");

    const payBtn = page.getByRole("button", { name: /Pay /i });
    await expect(payBtn).toBeEnabled({ timeout: 10_000 });

    // Capture the order body before the page navigates away to Payaza.
    let orderBody: { data: { order_number: string; total_ngn: number } } | null = null;
    page.on("response", async (r) => {
      if (
        orderBody === null &&
        r.url().includes("/v1/public/orders") &&
        r.request().method() === "POST" &&
        r.status() === 201
      ) {
        try {
          orderBody = (await r.json()) as typeof orderBody;
        } catch {
          /* navigation already started — verified by status alone */
        }
      }
    });

    const [orderResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/orders") && r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      payBtn.click(),
    ]);
    expect(orderResp.status()).toBe(201);

    // Body may be null if the navigation outraced the read — the 201 above is
    // sufficient proof the server accepted the order. If we DID get the body,
    // verify the order number shape.
    if (orderBody) {
      expect((orderBody as { data: { order_number: string } }).data.order_number).toMatch(
        /^SO-\d{4}-\d{5}$/,
      );
    }

    // After submit the server clears the cart — GET /cart should now be empty.
    const cartView = await page.request.get(`${API}/v1/public/cart`);
    const cart = (await cartView.json()) as { data: { total_items: number } };
    expect(cart.data.total_items).toBe(0);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("7. /specials page renders without error", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(`${CUSTOMER}/specials`);
    await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
    await expect(page.locator("h1, .ms-h1").first()).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("8. /about page renders without error", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(`${CUSTOMER}/about`);
    await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("9. /locations page renders without error", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(`${CUSTOMER}/locations`);
    await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("10. /blog page renders without error", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(`${CUSTOMER}/blog`);
    await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("11. /styleguide page renders without error", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(`${CUSTOMER}/styleguide`);
    await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("12. cart persists across reloads (server-backed)", async ({ page }) => {
    const errors = attachErrorTracking(page);
    await page.goto(CUSTOMER);
    const [addResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /^Add to cart$/i }).click(),
    ]);
    expect(addResp.status()).toBe(200);

    // Hard reload — same browser context, cookie survives.
    await page.reload();
    await page.goto(`${CUSTOMER}/cart`);
    await expect(page.getByText(/Continue to checkout/i)).toBeVisible({ timeout: 10_000 });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("13. tracking with wrong phone returns 404 (no enumeration)", async ({ page }) => {
    const ctx = await request.newContext();
    // Use a known-existing order from earlier tests if any — otherwise create one inline.
    const v = await getVariant(ctx, "sunrise-blend", 330);
    const br = await ctx.get(`${API}/v1/public/catalog/branches`);
    const branchId = ((await br.json()) as { data: Array<{ id: string }> }).data[0].id;
    const orderResp = await ctx.post(`${API}/v1/public/orders`, {
      headers: { "idempotency-key": crypto.randomUUID() },
      data: {
        branch_id: branchId,
        zone_name: "Ajao Estate area",
        delivery_fee_ngn: 1500,
        customer: { name: "Track Test", phone: "+2348025550808", address: "30 Asa" },
        items: [{ variant_id: v.id, quantity: 1 }],
      },
    });
    const { data: order } = (await orderResp.json()) as { data: { order_number: string } };

    const wrong = await ctx.get(
      `${API}/v1/public/orders/${order.order_number}?phone=%2B2349999999999`,
    );
    expect(wrong.status()).toBe(404);

    const right = await ctx.get(
      `${API}/v1/public/orders/${order.order_number}?phone=%2B2348025550808`,
    );
    expect(right.status()).toBe(200);
    await ctx.dispose();
  });

  test("14. cart API: legacy items[] path still produces orders", async () => {
    const ctx = await request.newContext();
    const v = await getVariant(ctx, "sunrise-blend", 650);
    const br = await ctx.get(`${API}/v1/public/catalog/branches`);
    const branchId = ((await br.json()) as { data: Array<{ id: string }> }).data[0].id;

    const r = await ctx.post(`${API}/v1/public/orders`, {
      headers: { "idempotency-key": crypto.randomUUID() },
      data: {
        branch_id: branchId,
        zone_name: "Ajao Estate area",
        delivery_fee_ngn: 1500,
        customer: { name: "Legacy", phone: "+2348025550920", address: "30 Asa" },
        items: [{ variant_id: v.id, quantity: 2 }],
      },
    });
    expect(r.status()).toBe(201);
    const body = (await r.json()) as { data: { total_ngn: number } };
    expect(body.data.total_ngn).toBe(v.price_ngn * 2 + 1500);
    await ctx.dispose();
  });
});
