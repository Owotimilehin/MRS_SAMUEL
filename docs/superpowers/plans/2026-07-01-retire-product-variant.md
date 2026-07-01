# Retire a single product size (variant) + drop "starting from" price — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner retire/restore a single size (variant) of a flavour from admin so it disappears from (or returns to) the customer storefront, and replace the juice grid's "From ₦X" teaser with a plain price.

**Architecture:** Reuse the existing `product_variant.is_active` column. A new authenticated `PATCH /v1/products/:id/variants/:variantId` flips `is_active`. The public catalog already filters `is_active = TRUE`, so no catalog change is needed — retiring hides the size from the storefront immediately, while the POS sync (which filters only `deleted_at`) still sells it (customer-only scope, by design). The admin product-detail page gets per-size Retire/Restore controls. The juice grid drops the "From" wording.

**Tech Stack:** Hono + Drizzle (API), TanStack Router + React (admin & customer), Zod, Vitest + Testcontainers (integration tests).

## Global Constraints

- No database migration — `product_variant.is_active boolean not null default true` already exists.
- Reversible retirement via `is_active` only; never touch `deleted_at` in this feature.
- Scope is customer-website-only: do NOT change `apps/api/src/routes/sync.ts` (the till keeps selling retired sizes by design).
- New endpoint capability: `products.manage` (same as product PATCH/DELETE).
- Retire copy (verbatim, used in both the API guard and admin confirm): a retired size must never be the only active size — "This is the only active size; retiring it would remove the whole flavour from the storefront. Use Deactivate flavour instead."
- Integration tests require Docker running (Testcontainers spins up `postgres:16-alpine`).

---

### Task 1: Backend — `PATCH /v1/products/:id/variants/:variantId` Retire/Restore

**Files:**
- Modify: `apps/api/src/routes/products.ts` (add the route inside `productRoutes`, after the `/:id/prices` route, before `return r;`)
- Test: `apps/api/test/integration/variant-retire.test.ts` (create)

**Interfaces:**
- Consumes: existing imports already in `products.ts` — `product`, `productVariant`, `eq`, `and`, `isNull` (drizzle), `requireCapability`, `writeAudit`, `BusinessError`, `z`.
- Produces: `PATCH /v1/products/:id/variants/:variantId`
  - Request body: `{ "is_active": boolean }`
  - 200 → `{ "data": { "id": string, "size_ml": number, "is_active": boolean } }`
  - 404 if product missing/soft-deleted; 422 if the variant doesn't belong to the product or if retiring the only active size; 401 unauthenticated; 403 without `products.manage`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/variant-retire.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import {
  setupTestDb,
  seedOwner,
  seedUser,
  loginAs,
  setOnlineDefaultBranch,
} from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { branch, product, productVariant, productPrice } from "@ms/db";

/**
 * Integration test: retiring a single size (variant) hides it from the public
 * catalog; restoring brings it back. Guards: cannot retire the only active
 * size; a variant that belongs to a different product is rejected; the
 * endpoint requires products.manage.
 */
describe("product variant retire / restore", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let ownerCookie: string;
  let productId: string;
  let v330: string;
  let v650: string;
  let otherProductId: string;
  let otherVariantId: string;

  async function catalogVariantSizes(pid: string): Promise<number[]> {
    const res = await fetch(`${baseUrl}/v1/public/catalog/products`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; variants: Array<{ size_ml: number }> }>;
    };
    const p = body.data.find((x) => x.id === pid);
    return (p?.variants ?? []).map((v) => v.size_ml).sort((a, b) => a - b);
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);

    const [prod] = await db
      .insert(product)
      .values({ name: "Retire Juice", slug: `retire-juice-${Date.now()}`, category: "regular" })
      .returning();
    if (!prod) throw new Error("product insert failed");
    productId = prod.id;

    const [a] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 330, sku: `RJ330-${Date.now()}` })
      .returning();
    const [b] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 650, sku: `RJ650-${Date.now()}` })
      .returning();
    if (!a || !b) throw new Error("variant insert failed");
    v330 = a.id;
    v650 = b.id;
    await db.insert(productPrice).values({ productId, variantId: v330, priceNgn: 2500 });
    await db.insert(productPrice).values({ productId, variantId: v650, priceNgn: 4000 });

    // A second single-variant product to test the last-active-size guard and
    // the cross-product rejection.
    const [other] = await db
      .insert(product)
      .values({ name: "Solo Juice", slug: `solo-juice-${Date.now()}`, category: "regular" })
      .returning();
    if (!other) throw new Error("other product insert failed");
    otherProductId = other.id;
    const [ov] = await db
      .insert(productVariant)
      .values({ productId: otherProductId, sizeMl: 330, sku: `SOLO330-${Date.now()}` })
      .returning();
    if (!ov) throw new Error("other variant insert failed");
    otherVariantId = ov.id;
    await db.insert(productPrice).values({ productId: otherProductId, variantId: otherVariantId, priceNgn: 3000 });

    const [br] = await db
      .insert(branch)
      .values({ name: "Retire Branch", code: `RB-${Date.now()}` })
      .returning();
    if (!br) throw new Error("branch insert failed");
    await setOnlineDefaultBranch(db, br.id);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  function patchVariant(pid: string, vid: string, isActive: boolean, cookie = ownerCookie) {
    return fetch(`${baseUrl}/v1/products/${pid}/variants/${vid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ is_active: isActive }),
    });
  }

  it("retiring the 330ml removes it from the public catalog", async () => {
    expect(await catalogVariantSizes(productId)).toEqual([330, 650]);
    const res = await patchVariant(productId, v330, false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; is_active: boolean; size_ml: number } };
    expect(body.data.is_active).toBe(false);
    expect(body.data.size_ml).toBe(330);
    expect(await catalogVariantSizes(productId)).toEqual([650]);
  });

  it("restoring the 330ml brings it back to the public catalog", async () => {
    const res = await patchVariant(productId, v330, true);
    expect(res.status).toBe(200);
    expect(await catalogVariantSizes(productId)).toEqual([330, 650]);
  });

  it("rejects retiring the only active size (422)", async () => {
    const res = await patchVariant(otherProductId, otherVariantId, false);
    expect(res.status).toBe(422);
    // The flavour is unchanged: its size is still in the catalog.
    expect(await catalogVariantSizes(otherProductId)).toEqual([330]);
  });

  it("rejects a variant that belongs to a different product (422)", async () => {
    const res = await patchVariant(productId, otherVariantId, false);
    expect(res.status).toBe(422);
  });

  it("requires authentication (401) and the products.manage capability (403)", async () => {
    const anon = await fetch(`${baseUrl}/v1/products/${productId}/variants/${v650}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    expect(anon.status).toBe(401);

    await seedUser(db, { email: "staff-retire@example.com", role: "branch_staff", password: "staffpassword123" });
    const staffCookie = await loginAs(baseUrl, "staff-retire@example.com", "staffpassword123");
    const forbidden = await patchVariant(productId, v650, false, staffCookie);
    expect(forbidden.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && pnpm vitest run test/integration/variant-retire.test.ts`
Expected: FAIL — the retire test gets 404/405 (route not defined) instead of 200, so `catalogVariantSizes` assertions and status checks fail.

- [ ] **Step 3: Add the endpoint**

In `apps/api/src/routes/products.ts`, add this Zod schema near the other input schemas (e.g. right after `PublishPrice`):

```ts
const RetireVariant = z.object({ is_active: z.boolean() });
```

Then add this route inside `productRoutes`, immediately after the `r.post("/:id/prices", ...)` handler and before `return r;`:

```ts
  /**
   * Retire (is_active=false) or restore (is_active=true) a single size of a
   * flavour. The public catalog filters is_active=TRUE, so retiring hides the
   * size from the storefront at once; the POS sync filters only deleted_at, so
   * the till can still ring it up (customer-only scope, by design). Reversible:
   * the size stays in the admin "Cans & prices" list, marked Retired.
   */
  r.patch("/:id/variants/:variantId", requireCapability("products.manage"), async (c) => {
    const id = c.req.param("id");
    const variantId = c.req.param("variantId");
    const body = RetireVariant.parse(await c.req.json());

    const [existingProduct] = await db
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));
    if (!existingProduct) throw new BusinessError("not_found", "product not found", 404);

    const [variant] = await db
      .select()
      .from(productVariant)
      .where(
        and(
          eq(productVariant.id, variantId),
          eq(productVariant.productId, id),
          isNull(productVariant.deletedAt),
        ),
      );
    if (!variant) {
      throw new BusinessError("validation_failed", "variant does not belong to this product", 422);
    }

    // Last-active-size guard: the size tool must never empty a flavour's
    // storefront presence — that's what "Deactivate flavour" is for.
    if (body.is_active === false) {
      const active = await db
        .select({ id: productVariant.id })
        .from(productVariant)
        .where(
          and(
            eq(productVariant.productId, id),
            eq(productVariant.isActive, true),
            isNull(productVariant.deletedAt),
          ),
        );
      const remaining = active.filter((v) => v.id !== variantId);
      if (remaining.length === 0) {
        throw new BusinessError(
          "validation_failed",
          "This is the only active size; retiring it would remove the whole flavour from the storefront. Use Deactivate flavour instead.",
          422,
        );
      }
    }

    const [updated] = await db
      .update(productVariant)
      .set({ isActive: body.is_active, updatedAt: new Date() })
      .where(eq(productVariant.id, variantId))
      .returning();
    if (!updated) throw new BusinessError("internal_error", "variant update failed", 500);

    await writeAudit(db, c, {
      action: body.is_active ? "product_variant.restore" : "product_variant.retire",
      entityType: "product_variant",
      entityId: variantId,
      before: { is_active: variant.isActive },
      after: { is_active: body.is_active },
    });

    return c.json({ data: { id: updated.id, size_ml: updated.sizeMl, is_active: updated.isActive } });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && pnpm vitest run test/integration/variant-retire.test.ts`
Expected: PASS — all 5 `it(...)` cases green.

- [ ] **Step 5: Typecheck the API**

Run: `pnpm --filter @ms/api build`
Expected: exits 0 (no tsc errors).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/products.ts apps/api/test/integration/variant-retire.test.ts
git commit -m "feat(products): PATCH endpoint to retire/restore a single size (variant)"
```

---

### Task 2: Admin UI — per-size Retire/Restore in "Cans & prices"

**Files:**
- Modify: `apps/admin/src/routes/owner/product-detail.tsx` (the "Cans & prices" `<section>` around lines 373-423, plus a `retireVariant` handler alongside `publishPrice`)

**Interfaces:**
- Consumes: `PATCH /v1/products/:id/variants/:variantId` from Task 1; the existing `api`, `humanizeError`, `showFlash`, `load`, `ngn` helpers already in this file; the `Variant` interface already carries `is_active`.
- Produces: no new exported interface — UI behaviour only.

- [ ] **Step 1: Add a per-size retire/restore handler**

In `apps/admin/src/routes/owner/product-detail.tsx`, add state for the in-flight variant near the other `useState` hooks (e.g. after `const [publishingId, setPublishingId] = useState<string | null>(null);`):

```tsx
  const [retiringId, setRetiringId] = useState<string | null>(null);
```

Then add this handler right after the `publishPrice` function:

```tsx
  async function retireVariant(variant: Variant, next: boolean): Promise<void> {
    if (!next) {
      const activeCount = (product?.variants ?? []).filter((v) => v.is_active).length;
      if (activeCount <= 1) {
        setError(
          "This is the only active size. Retiring it would remove the whole flavour from the storefront — use Deactivate above instead.",
        );
        return;
      }
      const ok = window.confirm(
        `Retire the ${variant.size_ml}ml size? It disappears from the customer website immediately. You can Restore it here anytime.`,
      );
      if (!ok) return;
    }
    setRetiringId(variant.id);
    setError(null);
    try {
      await api(`/products/${productId}/variants/${variant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: next }),
      });
      showFlash(next ? `${variant.size_ml}ml restored` : `${variant.size_ml}ml retired from the website`);
      await load();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setRetiringId(null);
    }
  }
```

- [ ] **Step 2: Render status + Retire/Restore per size**

Replace the variant `<form>` block (the `product.variants.map((v) => ( <form ...> ... </form> ))` around lines 380-418) with a version that dims retired rows, shows a Retired pill, hides the price form when retired, and offers Retire/Restore:

```tsx
                {product.variants.map((v) => (
                  <div
                    key={v.id}
                    style={{
                      paddingBottom: 12,
                      borderBottom: "1px solid var(--line)",
                      opacity: v.is_active ? 1 : 0.6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: v.is_active ? 8 : 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontWeight: 700 }}>{v.size_ml}ml</span>
                        {!v.is_active && <span className="pill pill--ink">Retired</span>}
                      </div>
                      {v.is_active ? (
                        <button
                          type="button"
                          className="btn btn--subtle btn--sm"
                          onClick={() => void retireVariant(v, false)}
                          disabled={retiringId === v.id}
                        >
                          {retiringId === v.id ? "…" : "Retire"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => void retireVariant(v, true)}
                          disabled={retiringId === v.id}
                        >
                          {retiringId === v.id ? "…" : "Restore"}
                        </button>
                      )}
                    </div>
                    {v.is_active && (
                      <form
                        onSubmit={(e) => publishPrice(v, e)}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr auto",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <input
                          className="input"
                          type="number"
                          inputMode="numeric"
                          value={drafts[v.id] ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
                          placeholder={v.current_price_ngn != null ? String(v.current_price_ngn) : "Set price"}
                          required
                        />
                        <button
                          type="submit"
                          className="btn btn--primary btn--sm"
                          disabled={publishingId === v.id || !drafts[v.id]}
                        >
                          {publishingId === v.id ? "…" : "Publish"}
                        </button>
                      </form>
                    )}
                    {v.is_active && (
                      <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 4 }}>
                        {v.current_price_ngn != null ? ngn(v.current_price_ngn) : "no price set"}
                      </div>
                    )}
                  </div>
                ))}
```

- [ ] **Step 3: Typecheck the admin app**

Run: `pnpm --filter @ms/admin typecheck`
Expected: exits 0 (no tsc errors).

- [ ] **Step 4: Build the admin app**

Run: `pnpm --filter @ms/admin build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/owner/product-detail.tsx
git commit -m "feat(admin): Retire/Restore a single size from the product page"
```

---

### Task 3: Storefront — drop the "From ₦X" teaser on the juice grid

**Files:**
- Modify: `apps/customer/src/routes/juices.index.tsx:140`

**Interfaces:**
- Consumes: `quickAddSize` (already imported at `juices.index.tsx:10`) and `p.prices` (already in scope in the map).
- Produces: no exported interface — display only.

- [ ] **Step 1: Replace the price label**

In `apps/customer/src/routes/juices.index.tsx`, change line 140 from:

```tsx
                      From ₦{Math.min(...Object.values(p.prices)).toLocaleString("en-NG")}
```

to:

```tsx
                      ₦{p.prices[quickAddSize(p)].toLocaleString("en-NG")}
```

This drops the "From" wording and shows the same representative price the homepage (`ProductCard.tsx:88`) and shop grid (`shop.tsx:90`) already use.

- [ ] **Step 2: Build the customer app to typecheck the change**

Run: `pnpm --filter @ms/customer build`
Expected: build succeeds (no TS error on `p.prices[quickAddSize(p)]`).

- [ ] **Step 3: Run the existing customer tests**

Run: `pnpm --filter @ms/customer test`
Expected: PASS (no regressions; this change is display-only).

- [ ] **Step 4: Commit**

```bash
git add apps/customer/src/routes/juices.index.tsx
git commit -m "feat(customer): drop 'From' price teaser on the juice grid"
```

---

## Self-Review

**Spec coverage:**
- Spec §A (backend endpoint, guard, audit, capability) → Task 1. ✅
- Spec §B (admin Retire/Restore UI, dimmed + pill + hidden price form) → Task 2. ✅
- Spec §C (juice grid "From" removal, plain `quickAddSize` price) → Task 3. ✅
- Spec "Testing" (retire hides / restore restores / last-active 422 / wrong-product 422 / capability) → Task 1 Step 1. ✅
- Spec "Out of scope" (no sync change, no migration, no flavour Delete change) → honoured; only `products.ts`, one admin file, one customer file, and one new test are touched. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code and exact commands. ✅

**Type consistency:** `is_active` (API/admin/test) and `size_ml` used consistently with the existing `Variant` interface and catalog payload. Endpoint path `PATCH /v1/products/:id/variants/:variantId` and body `{ is_active }` match across Task 1 (definition), Task 1 test, and Task 2 (caller). `retireVariant(variant, next)` / `retiringId` names are consistent within Task 2. ✅
