import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * End-to-end coverage for the in-store half of preorders (Workstream D): a
 * cashier takes a prepaid preorder at the POS, and the owner fulfils it later
 * from the Preorders queue. The order only ships — and stock only moves — at
 * that manual fulfil step, never at payment.
 *
 * Self-contained: it produces stock for the target flavour via the
 * inventory-adjust API before fulfilling, so it runs on any (even dirty) dev
 * database. The blocked-at-zero-stock fulfil guard is covered server-side by
 * apps/api/test/integration/preorders-fulfil.test.ts.
 *
 * Prerequisites (same as the other admin e2e specs): API on :3001 and admin on
 * :3010 (or E2E_BASE_URL), DB seeded (owner@example.com / ChangeMe!Owner-1234).
 */

const OWNER = { email: "owner@example.com", password: "ChangeMe!Owner-1234" };
const FLAVOUR = "Crimson Cooler"; // a seeded flavour whose 330ml is preorder_only

function watchErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/telemetry|Failed to load resource|favicon/i.test(t)) return; // known noise
    errs.push(`console.error: ${t}`);
  });
  return errs;
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  const email = page.locator("#email");
  const password = page.locator("#password");
  const submit = page.getByRole("button", { name: /sign in/i });
  await expect(email).toBeVisible();
  // The app runs an auth check on load that can remount the login form and wipe
  // a too-early fill. Re-fill until the values stick (and the button enables).
  await expect(async () => {
    await email.fill(OWNER.email);
    await password.fill(OWNER.password);
    await expect(email).toHaveValue(OWNER.email, { timeout: 1_000 });
    await expect(submit).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await submit.click();
  await page.waitForURL(/\/owner|\/$/, { timeout: 8_000 });
}

async function firstBranchId(req: APIRequestContext): Promise<string> {
  const res = await req.get("/v1/branches");
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data[0]!.id;
}

async function productIdByName(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.get("/v1/products");
  const body = (await res.json()) as { data: Array<{ id: string; name: string }> };
  return body.data.find((p) => p.name === name)!.id;
}

// Set a product's branch stock to an absolute quantity (product-level bucket).
async function setBranchStock(
  req: APIRequestContext,
  branchId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  const res = await req.post("/v1/inventory/adjust", {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: {
      location_type: "branch",
      location_id: branchId,
      reason_code: "physical_recount",
      items: [{ product_id: productId, new_quantity: quantity }],
    },
  });
  expect(res.ok(), `adjust failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function crimsonPreorderNumbers(req: APIRequestContext): Promise<Set<string>> {
  const res = await req.get("/v1/preorders");
  if (!res.ok()) return new Set();
  const body = (await res.json()) as {
    data: Array<{ order_number: string; items: Array<{ name: string | null }> }>;
  };
  return new Set(
    body.data.filter((o) => o.items.some((i) => i.name === FLAVOUR)).map((o) => o.order_number),
  );
}

test("take a prepaid preorder at the till, then fulfil it from the queue", async ({ page }) => {
  test.setTimeout(120_000);
  const errs = watchErrors(page);
  await login(page);
  const req = page.request;

  const branchId = await firstBranchId(req);
  const productId = await productIdByName(req, FLAVOUR);
  const before = await crimsonPreorderNumbers(req);

  // ── Take the preorder at the POS ──────────────────────────────────────────
  await page.goto("/branch/sell");
  await expect(page.getByText("Cart")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder(/search products/i).fill(FLAVOUR);
  const tile = page.getByRole("button").filter({ hasText: FLAVOUR }).first();
  await expect(tile).toBeVisible({ timeout: 15_000 });

  // Out of stock, but a preorder size keeps the flavour tappable.
  await expect(tile).toBeEnabled();
  await tile.click();
  const preorderSize = page
    .getByRole("button")
    .filter({ hasText: /preorder · made to order/i })
    .first();
  await expect(preorderSize).toBeVisible({ timeout: 5_000 });
  await preorderSize.click();

  await expect(page.getByText(/preorder — fulfil on/i)).toBeVisible();
  const takeBtn = page.getByRole("button", { name: /take preorder/i });

  // Guard: a preorder needs a fulfilment date.
  await takeBtn.click();
  await expect(page.getByText(/pick a fulfilment date/i)).toBeVisible({ timeout: 5_000 });

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await page.locator('input[type="date"]').fill(tomorrow);
  await takeBtn.click();
  await expect(page.getByText(/preorder taken/i)).toBeVisible({ timeout: 8_000 });
  await page.screenshot({ path: "e2e/_preorder-taken.png", fullPage: true });

  // The till is offline-first: confirm + pay sit in the local outbox and flush
  // on the sync tick. Nudge an immediate flush via the `online` event, then
  // wait for the new preorder to surface in the queue. Capture its number.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  let orderNumber = "";
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        const now = await crimsonPreorderNumbers(req);
        for (const n of now) if (!before.has(n)) orderNumber = n;
        return orderNumber;
      },
      { timeout: 60_000, intervals: [1500, 2500, 4000] },
    )
    .not.toEqual("");

  // ── Produce stock, then fulfil from the queue (stock deducts here, not at
  //    payment — this is the manual-approval step) ───────────────────────────
  await setBranchStock(req, branchId, productId, 100);
  page.on("dialog", (d) => void d.accept());
  await page.goto("/owner/preorders");
  const row = () => page.getByRole("row").filter({ hasText: orderNumber });
  await expect(row()).toBeVisible({ timeout: 8_000 });
  await row().getByRole("button", { name: /^fulfil$/i }).click();
  await expect(page.getByText(new RegExp(`${orderNumber} fulfilled`, "i"))).toBeVisible({ timeout: 8_000 });
  await expect(row()).toHaveCount(0); // left the queue
  await page.screenshot({ path: "e2e/_preorder-fulfilled.png", fullPage: true });

  expect(errs, `unexpected console/page errors:\n${errs.join("\n")}`).toEqual([]);
});
