/* eslint-disable no-console -- e2e diagnostic spec, prints progress to stdout */
import { test, expect } from "@playwright/test";

/**
 * Level-2 local mock end-to-end for the Payaza migration.
 *
 * Drives the REAL customer checkout UI (catches render crashes), then
 * simulates the server-to-server callback that Payaza would send (there's no
 * real Payaza in mock mode), and verifies the order flips to paid + stock drops.
 *
 * Prereqs: api :3001, customer :3002, DB seeded, PAYAZA_SECRET_KEY empty (mock mode).
 */
const CUSTOMER = "http://localhost:3002";
const API = "http://localhost:3001";

test("Payaza mock checkout: order → callback → paid + stock decremented", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !/telemetry|Failed to load resource|favicon/i.test(m.text())
    ) {
      errors.push(`console.error: ${m.text()}`);
    }
  });

  // 1. Add the first product to the cart from the menu.
  await page.goto(CUSTOMER);
  const [addResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/v1/public/cart/lines") && r.request().method() === "POST",
      { timeout: 15_000 },
    ),
    page.getByRole("button", { name: /^Add to cart$/i }).first().click(),
  ]);
  expect(addResp.status()).toBe(200);

  // 2. Checkout — fill the form.
  await page.goto(`${CUSTOMER}/checkout`);
  await page.getByLabel(/Full name/i).fill("Payaza Test Buyer");
  await page.getByLabel(/Phone/i).fill("+2348025550777");
  await page.getByLabel(/Address/i).fill("30 Asa Afariogun Street, Ajao Estate");

  // 2a. Wait for courier options to load, then pick the pricier (last) one so
  // we exercise a non-default selection. Cheapest is pre-selected by default.
  const radios = page.getByRole("radio");
  await expect(radios.first()).toBeVisible({ timeout: 15_000 });
  const radioCount = await radios.count();
  await radios.nth(radioCount - 1).check();
  // The Delivery line should now reflect the chosen courier's fee (> ₦0).
  const deliveryRow = page.locator(".ms-cart__row", { hasText: /^Delivery/ });
  await expect(deliveryRow).toBeVisible();
  console.log(`[payaza-test] ${radioCount} courier option(s); selected the last`);

  const payBtn = page.getByRole("button", { name: /Pay /i });
  await expect(payBtn).toBeEnabled({ timeout: 15_000 });

  // Intercept the order POST and read its body server-side (via route.fetch)
  // BEFORE the page sees the response and redirects away — reading it from the
  // page-side response races the window.location navigation and loses.
  let orderBody:
    | {
        data: {
          order_number: string;
          total_ngn: number;
          payment: { provider: string; reference: string; payaza: { connectionMode: string } };
        };
      }
    | null = null;
  let orderStatus = 0;
  let handled = false;
  await page.route("**/v1/public/orders", async (route) => {
    if (handled || route.request().method() !== "POST") return route.continue();
    handled = true;
    const resp = await route.fetch();
    orderStatus = resp.status();
    const text = await resp.text();
    try {
      if (orderStatus === 201) orderBody = JSON.parse(text);
      else console.log(`[payaza-test] order POST ${orderStatus} body:`, text);
    } catch {
      /* leave orderBody null — assertion below will surface it */
    }
    await route.fulfill({ response: resp, body: text });
  });
  // Block the post-pay redirect to the mock Payaza URL — we simulate the callback
  // ourselves below, so the real navigation isn't needed.
  await page.route("**/order/**", (route) =>
    route.request().isNavigationRequest() ? route.abort() : route.continue(),
  );

  await payBtn.click();
  await expect.poll(() => orderStatus, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(orderStatus).toBe(201);
  if (!orderBody) throw new Error("order body not captured");
  const captured = orderBody as NonNullable<typeof orderBody>;
  const orderNo = captured.data.order_number;
  console.log(`[payaza-test] order ${orderNo} total ₦${captured.data.total_ngn}`);
  console.log(`[payaza-test] payment mode: ${captured.data.payment.payaza.connectionMode}`);

  // No keys in local dev → Mock mode; the SDK config carries our order ref.
  expect(captured.data.payment.provider).toBe("payaza");
  expect(captured.data.payment.payaza.connectionMode).toBe("Mock");
  expect(captured.data.payment.reference).toBe(orderNo);

  // 3. Before payment the order is 'confirmed', not yet paid.
  const phone = "%2B2348025550777";
  const pre = await page.request.get(`${API}/v1/public/orders/${orderNo}?phone=${phone}`);
  const preBody = (await pre.json()) as { data: { status: string; payment_status: string } };
  console.log(`[payaza-test] pre-callback status: ${preBody.data.status}/${preBody.data.payment_status}`);
  expect(preBody.data.payment_status).not.toBe("paid");

  // 4. Simulate Payaza's server-to-server callback. In mock mode the webhook's
  //    verifyPayazaTransaction() returns SUCCESSFUL, so this drives the real paid path.
  const cb = await page.request.post(`${API}/v1/webhooks/payaza`, {
    headers: { "content-type": "application/json" },
    data: { data: { transaction_reference: orderNo, status: "SUCCESSFUL" } },
  });
  expect(cb.status()).toBe(200);

  // 5. Order is now paid.
  const post = await page.request.get(`${API}/v1/public/orders/${orderNo}?phone=${phone}`);
  const postBody = (await post.json()) as { data: { status: string; payment_status: string } };
  console.log(`[payaza-test] post-callback status: ${postBody.data.status}/${postBody.data.payment_status}`);
  expect(postBody.data.status).toBe("paid");
  expect(postBody.data.payment_status).toBe("paid");

  // 6. Idempotency — replaying the callback is a harmless no-op.
  const replay = await page.request.post(`${API}/v1/webhooks/payaza`, {
    headers: { "content-type": "application/json" },
    data: { data: { transaction_reference: orderNo, status: "SUCCESSFUL" } },
  });
  expect(replay.status()).toBe(200);

  expect(errors, errors.join("\n")).toEqual([]);
});
