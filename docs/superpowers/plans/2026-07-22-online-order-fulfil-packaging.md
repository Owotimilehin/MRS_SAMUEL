# Online-order fulfil packaging (straw + bag) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let whoever fulfils an online order record the straws and bags used to pack it, with editable smart defaults, decrementing the branch packaging ledger.

**Architecture:** A single new `PUT .../sales/:id/packaging` endpoint records the order's straws/bags on the existing `sale_order_packaging` table and posts a *diff* into `packaging_stock_ledger` (so edits stay truthful). A Packaging card on the till's online-order detail prefills sensible defaults (straws = bottle count; bag size by count), stays editable, and the produce/advance CTA flushes any unsaved change before advancing. No schema change, no migration.

**Tech Stack:** Hono + Drizzle (API), Zod validation, Vitest + testcontainers (API tests), React + TanStack Router (admin), Vitest (admin unit tests).

## Global Constraints

- Packaging on online orders is **warn-but-allow**: the branch `packaging_stock_ledger` may go negative and must NEVER block fulfilment. (copied from spec)
- Packaging edits are allowed while the order is **non-terminal**; reject only `delivered`/`cancelled`. (copied from spec)
- Reuse existing `sale_order_packaging`, `packaging_stock_ledger`, and the `bag`/`straw` `packaging_material` kinds. **No schema change, no migration.** (copied from spec)
- Never touch juice/finished-goods stock in this feature — packaging only. (copied from spec)
- Quality gates: 0 lint errors, clean typecheck. Run the affected API test file ALONE (`vitest run <file>`) — the full API suite hits testcontainer timeouts. (from reference_quality_gates / reference_local_run)
- Endpoint gate mirrors `/advance`: `requireBranchScope()` + `requireAnyCapability("pos.sell", "orders.manage")`. (copied from spec)

---

### Task 1: `PUT .../sales/:id/packaging` endpoint (diff-ledger record)

**Files:**
- Modify: `apps/api/src/routes/sales.ts` (add Zod schema near `ConfirmSale`; add route handler after the `/advance` handler, before `/delivery-address` at ~line 626)
- Test: `apps/api/test/integration/online-packaging.test.ts` (create)

**Interfaces:**
- Consumes: existing imports already in `sales.ts` — `saleOrder`, `saleOrderItem`, `saleOrderPackaging`, `packagingStockLedger`, `packagingMaterial`, `writeAudit`, `requireBranchScope`, `requireAnyCapability`, `BusinessError`, `z`, `and`, `eq`, `inArray`. (Verify each is imported; add any missing to the existing import blocks.)
- Produces: `PUT /v1/branches/:branchId/sales/:id/packaging`, body `{ packaging: Array<{ packaging_material_id: string; quantity: number }> }`, returns `{ data: { ok: true } }`. Audit action string `sale.packaging_set`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/online-packaging.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import {
  branch,
  product,
  productVariant,
  productPrice,
  packagingMaterial,
  packagingStockLedger,
  packagingBalanceAt,
  saleOrder,
  saleOrderItem,
  saleOrderPackaging,
  type createDbClient,
} from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("online order fulfil packaging (straw + bag)", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branchId: string;
  let orderId: string;
  let strawId: string;
  let bagId: string;

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT", "DELETE"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  const branchBal = (materialId: string): Promise<number> =>
    packagingBalanceAt(db, { locationType: "branch", locationId: branchId }, materialId);

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const [b] = await db.insert(branch).values({ name: "Pack Branch", code: "PKB1" }).returning();
    branchId = b!.id;
    const [p] = await db.insert(product).values({ name: "Zobo", slug: "zobo", category: "regular" }).returning();
    const [v] = await db.insert(productVariant).values({ productId: p!.id, sizeMl: 330, sku: "zobo-330" }).returning();
    const [pr] = await db.insert(productPrice).values({ productId: p!.id, variantId: v!.id, priceNgn: 2000 }).returning();

    const [straw] = await db.insert(packagingMaterial).values({ name: "Straw", unitLabel: "straw", kind: "straw" }).returning();
    const [bag] = await db.insert(packagingMaterial).values({ name: "Small Bag", unitLabel: "bag", kind: "bag" }).returning();
    strawId = straw!.id;
    bagId = bag!.id;

    // Branch opening stock so balances start positive.
    await db.insert(packagingStockLedger).values([
      { locationType: "branch", locationId: branchId, packagingMaterialId: strawId, delta: 100, sourceType: "opening_balance", sourceId: uuid() },
      { locationType: "branch", locationId: branchId, packagingMaterialId: bagId, delta: 50, sourceType: "opening_balance", sourceId: uuid() },
    ]);

    // A paid online order with 3 bottles.
    const [o] = await db.insert(saleOrder).values({
      orderNumber: "ORD-PKG-001",
      branchId,
      channel: "online",
      status: "paid",
      subtotalNgn: 6000,
      totalNgn: 6000,
      paymentMethod: "transfer",
      paymentStatus: "paid",
      createdAtLocal: new Date("2026-07-22T10:00:00+01:00"),
      idempotencyKey: uuid(),
    }).returning();
    orderId = o!.id;
    await db.insert(saleOrderItem).values({
      saleOrderId: orderId, productId: p!.id, variantId: v!.id, productPriceId: pr!.id,
      quantity: 3, unitPriceNgn: 2000, lineTotalNgn: 6000,
    });
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("records straws + bags and decrements the branch ledger", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [
        { packaging_material_id: strawId, quantity: 3 },
        { packaging_material_id: bagId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(strawId)).toBe(97);
    expect(await branchBal(bagId)).toBe(49);
    const rows = await db.select().from(saleOrderPackaging).where(eq(saleOrderPackaging.saleOrderId, orderId));
    expect(rows).toHaveLength(2);
  });

  it("re-save diffs correctly (3 -> 2 straws returns +1 to stock)", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [
        { packaging_material_id: strawId, quantity: 2 },
        { packaging_material_id: bagId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(strawId)).toBe(98); // was 97, +1 back
    expect(await branchBal(bagId)).toBe(49);   // unchanged
  });

  it("qty 0 removes the row and restores its stock", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [
        { packaging_material_id: strawId, quantity: 0 },
        { packaging_material_id: bagId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(strawId)).toBe(100); // fully restored
    const rows = await db.select().from(saleOrderPackaging).where(eq(saleOrderPackaging.saleOrderId, orderId));
    expect(rows.map((r) => r.packagingMaterialId)).toEqual([bagId]);
  });

  it("rejects a non-online channel and a terminal order", async () => {
    // flip to delivered → 409
    await db.update(saleOrder).set({ status: "delivered" }).where(eq(saleOrder.id, orderId));
    const res = await call<{ error?: { code: string } }>(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [{ packaging_material_id: bagId, quantity: 1 }],
    });
    expect(res.status).toBe(409);
    await db.update(saleOrder).set({ status: "paid" }).where(eq(saleOrder.id, orderId)); // restore
  });

  it("allows the branch ledger to go negative (warn-but-allow)", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [{ packaging_material_id: bagId, quantity: 999 }],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(bagId)).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/online-packaging.test.ts`
Expected: FAIL — the `PUT .../packaging` route returns 404 (not registered), so the first assertion `expect(res.status).toBe(200)` fails.

- [ ] **Step 3: Add the Zod schema**

In `apps/api/src/routes/sales.ts`, near the existing `ConfirmSale` schema, add:

```typescript
const SetPackaging = z.object({
  packaging: z
    .array(
      z.object({
        packaging_material_id: z.string().uuid(),
        quantity: z.number().int().min(0),
      }),
    )
    .max(50),
});
```

- [ ] **Step 4: Add the route handler**

In `apps/api/src/routes/sales.ts`, immediately after the `/:id/advance` handler closes (before the `// ============ Edit delivery address ============` block ~line 627), add:

```typescript
  // ============ Set packaging on an online order (fulfiller-added straw/bag) ============
  // Records the straws + bags used to pack an online/phone order and decrements the
  // branch packaging ledger by the DIFFERENCE vs what was previously recorded, so the
  // fulfiller can edit/correct until the order is delivered. Warn-but-allow: the branch
  // ledger may go negative; packaging never blocks fulfilment. Never touches juice stock.
  r.put(
    "/:id/packaging",
    requireBranchScope(),
    requireAnyCapability("pos.sell", "orders.manage"),
    async (c) => {
      const branchId = c.req.param("branchId");
      const id = c.req.param("id");
      if (!branchId || !id) throw new BusinessError("validation_failed", "branchId and id required", 400);
      const body = SetPackaging.parse(await c.req.json());
      const auth = c.get("auth");

      await db.transaction(async (tx) => {
        const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
        if (!o || o.branchId !== branchId) throw new BusinessError("not_found", "sale not found", 404);
        if (!["online", "phone"].includes(o.channel)) {
          throw new BusinessError("conflict", `not an online order: ${o.channel}`, 409);
        }
        if (o.status === "delivered" || o.status === "cancelled") {
          throw new BusinessError("conflict", `cannot change packaging on a ${o.status} order`, 409);
        }

        // Every requested material must be an active bag/straw consumable.
        const wantIds = body.packaging.map((p) => p.packaging_material_id);
        if (wantIds.length > 0) {
          const mats = await tx
            .select({ id: packagingMaterial.id })
            .from(packagingMaterial)
            .where(
              and(
                inArray(packagingMaterial.id, wantIds),
                inArray(packagingMaterial.kind, ["bag", "straw"]),
                eq(packagingMaterial.isActive, true),
              ),
            );
          const okIds = new Set(mats.map((m) => m.id));
          for (const wid of wantIds) {
            if (!okIds.has(wid)) {
              throw new BusinessError("validation_failed", "not an active bag/straw material", 422);
            }
          }
        }

        // Desired quantities (merge dupes).
        const wantQty = new Map<string, number>();
        for (const p of body.packaging) {
          wantQty.set(p.packaging_material_id, (wantQty.get(p.packaging_material_id) ?? 0) + p.quantity);
        }
        // Previously-recorded quantities.
        const prevRows = await tx
          .select()
          .from(saleOrderPackaging)
          .where(eq(saleOrderPackaging.saleOrderId, id));
        const prevQty = new Map<string, number>();
        for (const r of prevRows) prevQty.set(r.packagingMaterialId, r.quantity);

        // Diff → one compensating ledger row per changed material + reconcile rows.
        const allIds = new Set<string>([...prevQty.keys(), ...wantQty.keys()]);
        for (const mid of allIds) {
          const prev = prevQty.get(mid) ?? 0;
          const next = wantQty.get(mid) ?? 0;
          const delta = next - prev;
          if (delta !== 0) {
            await tx.insert(packagingStockLedger).values({
              locationType: "branch",
              locationId: o.branchId,
              packagingMaterialId: mid,
              delta: -delta, // consuming more decrements; reducing count returns stock
              sourceType: "consumption",
              sourceId: id,
              recordedByUserId: auth.userId,
              note: `Online packaging ${o.orderNumber}`,
            });
          }
          if (next <= 0 && prev > 0) {
            await tx
              .delete(saleOrderPackaging)
              .where(and(eq(saleOrderPackaging.saleOrderId, id), eq(saleOrderPackaging.packagingMaterialId, mid)));
          } else if (next > 0 && prev === 0) {
            await tx.insert(saleOrderPackaging).values({ saleOrderId: id, packagingMaterialId: mid, quantity: next });
          } else if (next > 0 && prev > 0 && next !== prev) {
            await tx
              .update(saleOrderPackaging)
              .set({ quantity: next })
              .where(and(eq(saleOrderPackaging.saleOrderId, id), eq(saleOrderPackaging.packagingMaterialId, mid)));
          }
        }
      });

      await writeAudit(db, c, {
        action: "sale.packaging_set",
        entityType: "sale_order",
        entityId: id,
        after: { packaging: body.packaging },
      });
      return c.json({ data: { ok: true } });
    },
  );
```

Then confirm `packagingMaterial` is imported in `sales.ts` (the `/bags` handler at line 138 uses it, so it already is). If `inArray` is not imported, add it to the `drizzle-orm` import.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run test/integration/online-packaging.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Typecheck + lint**

Run: `cd apps/api && npx tsc --noEmit && npx eslint src/routes/sales.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/sales.ts apps/api/test/integration/online-packaging.test.ts
git commit -m "feat(api): PUT sales/:id/packaging records online-order straw+bag with diff ledger"
```

---

### Task 2: Expose saved packaging on the order-detail response

**Files:**
- Modify: `apps/api/src/routes/sales.ts` (the `GET /:id` handler, ~line 779–852)
- Test: `apps/api/test/integration/online-packaging.test.ts` (add one case)

**Interfaces:**
- Consumes: the `PUT .../packaging` endpoint from Task 1; `saleOrderPackaging` (already imported).
- Produces: `GET /v1/branches/:branchId/sales/:id` response `data` gains `packaging: Array<{ packaging_material_id: string; quantity: number }>`.

- [ ] **Step 1: Add the failing test case**

Append to `apps/api/test/integration/online-packaging.test.ts` inside the `describe`:

```typescript
  it("GET /:id returns the saved packaging array", async () => {
    // Reset to a known state: 2 straws only.
    await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [{ packaging_material_id: strawId, quantity: 2 }],
    });
    const res = await call<{ data: { packaging: Array<{ packaging_material_id: string; quantity: number }> } }>(
      "GET",
      `/v1/branches/${branchId}/sales/${orderId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.packaging).toEqual([{ packaging_material_id: strawId, quantity: 2 }]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/online-packaging.test.ts -t "returns the saved packaging"`
Expected: FAIL — `res.body.data.packaging` is `undefined`.

- [ ] **Step 3: Extend the GET /:id handler**

In `apps/api/src/routes/sales.ts`, inside `r.get("/:id", ...)`, before the final `return c.json({ data: { ... } })`, add:

```typescript
    const packagingRows = await db
      .select({
        packaging_material_id: saleOrderPackaging.packagingMaterialId,
        quantity: saleOrderPackaging.quantity,
      })
      .from(saleOrderPackaging)
      .where(eq(saleOrderPackaging.saleOrderId, id));
```

Then add `packaging: packagingRows,` to the returned `data` object (alongside `items`, `delivery`, etc.).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run test/integration/online-packaging.test.ts`
Expected: PASS (all cases including the new one).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sales.ts apps/api/test/integration/online-packaging.test.ts
git commit -m "feat(api): include saved packaging array in sale detail response"
```

---

### Task 3: Client-side packaging default calculator (pure, unit-tested)

**Files:**
- Create: `apps/admin/src/lib/packaging-defaults.ts`
- Test: `apps/admin/src/lib/packaging-defaults.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `defaultStrawCount(items: Array<{ sizeMl: number | null; quantity: number }>): number`
  - `defaultBagSize(bottleCount: number): "Small" | "Medium" | "Large"`
  - `pickBagMaterial(bags: Array<{ material_id: string; name: string }>, size: "Small" | "Medium" | "Large"): { material_id: string; name: string } | null`

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/lib/packaging-defaults.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { defaultStrawCount, defaultBagSize, pickBagMaterial } from "./packaging-defaults.js";

describe("packaging defaults", () => {
  it("straws = sum of bottle quantities (ignores non-sized lines)", () => {
    expect(defaultStrawCount([{ sizeMl: 330, quantity: 2 }, { sizeMl: 650, quantity: 1 }])).toBe(3);
    expect(defaultStrawCount([{ sizeMl: null, quantity: 5 }])).toBe(0);
    expect(defaultStrawCount([])).toBe(0);
  });

  it("bag size by bottle count with boundaries at 2/3 and 5/6", () => {
    expect(defaultBagSize(1)).toBe("Small");
    expect(defaultBagSize(2)).toBe("Small");
    expect(defaultBagSize(3)).toBe("Medium");
    expect(defaultBagSize(5)).toBe("Medium");
    expect(defaultBagSize(6)).toBe("Large");
    expect(defaultBagSize(20)).toBe("Large");
  });

  it("picks the bag whose name contains the size word, else the first bag, else null", () => {
    const bags = [
      { material_id: "s", name: "Small Bag" },
      { material_id: "m", name: "Medium Bag" },
      { material_id: "l", name: "Large Bag" },
    ];
    expect(pickBagMaterial(bags, "Medium")?.material_id).toBe("m");
    expect(pickBagMaterial([{ material_id: "x", name: "Generic Carrier" }], "Large")?.material_id).toBe("x");
    expect(pickBagMaterial([], "Small")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/admin && npx vitest run src/lib/packaging-defaults.test.ts`
Expected: FAIL — module `./packaging-defaults.js` not found.

- [ ] **Step 3: Write the implementation**

Create `apps/admin/src/lib/packaging-defaults.ts`:

```typescript
/**
 * Pure helpers that prefill the fulfiller's packaging picker for an online order.
 * All values are only defaults — the fulfiller edits them freely before saving.
 */
export type BagSize = "Small" | "Medium" | "Large";

/** One straw per bottle: sum of quantities across sized (bottle) line items. */
export function defaultStrawCount(items: Array<{ sizeMl: number | null; quantity: number }>): number {
  return items.reduce((sum, it) => sum + (it.sizeMl != null ? it.quantity : 0), 0);
}

/** Bag size from bottle count: <=2 Small, 3-5 Medium, 6+ Large. */
export function defaultBagSize(bottleCount: number): BagSize {
  if (bottleCount <= 2) return "Small";
  if (bottleCount <= 5) return "Medium";
  return "Large";
}

/** Match a bag material to a size by name, falling back to the first bag. */
export function pickBagMaterial<T extends { name: string }>(bags: T[], size: BagSize): T | null {
  const byName = bags.find((b) => b.name.toLowerCase().includes(size.toLowerCase()));
  return byName ?? bags[0] ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/admin && npx vitest run src/lib/packaging-defaults.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/packaging-defaults.ts apps/admin/src/lib/packaging-defaults.test.ts
git commit -m "feat(admin): packaging default calculator for online-order fulfilment"
```

---

### Task 4: Packaging card on the online-order detail + flush-on-CTA + humanizer

**Files:**
- Create: `apps/admin/src/components/PackagingCard.tsx`
- Modify: `apps/admin/src/routes/branch/online-order-detail.tsx` (render the card; flush before `produce()`/`advance()`; extend the `Sale` interface with `packaging`)
- Modify: `apps/admin/src/lib/audit-humanize.ts` (add `sale.packaging_set` case ~line 278)

**Interfaces:**
- Consumes: `GET .../sales/bags` (`{ data: Array<{ material_id, name, kind, balance }> }`); the order detail's new `packaging` array (Task 2); `defaultStrawCount`, `defaultBagSize`, `pickBagMaterial` (Task 3); the shared `api()` client.
- Produces: `PackagingCard` with an imperative handle `{ saveIfDirty: () => Promise<void> }` exposed via `ref`, so the parent can flush before a state transition.

- [ ] **Step 1: Add the humanizer case**

In `apps/admin/src/lib/audit-humanize.ts`, after the `case "sale.cancel":` block (~line 278), add:

```typescript
    case "sale.packaging_set":
      return `Recorded packaging for ${orderNum()}`;
```

- [ ] **Step 2: Create the PackagingCard component**

Create `apps/admin/src/components/PackagingCard.tsx`:

```tsx
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { humanizeError } from "../lib/humanizeError.js";
import { toast } from "../lib/toast.js";
import { defaultStrawCount, defaultBagSize, pickBagMaterial } from "../lib/packaging-defaults.js";

interface BagStockRow { material_id: string; name: string; kind: "bag" | "straw"; balance: number }
export interface PackagingCardHandle { saveIfDirty: () => Promise<void> }

interface Props {
  branchId: string;
  orderId: string;
  items: Array<{ sizeMl: number | null; quantity: number }>;
  savedPackaging: Array<{ packaging_material_id: string; quantity: number }>;
  readOnly?: boolean;
  onSaved?: () => void;
}

/**
 * Lets whoever fulfils an online order record the straws + bags used to pack it.
 * Prefills sensible defaults (1 straw per bottle; bag size by bottle count) but every
 * field is editable. Saving PUTs to /sales/:id/packaging (diff-ledger). The parent
 * calls `saveIfDirty()` on the produce/advance CTA so packaging is flushed in one tap.
 */
export const PackagingCard = forwardRef<PackagingCardHandle, Props>(function PackagingCard(
  { branchId, orderId, items, savedPackaging, readOnly, onSaved },
  ref,
) {
  const [materials, setMaterials] = useState<BagStockRow[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  // The last-persisted quantities, keyed by material id — dirtiness is measured against this.
  const savedRef = useRef<Record<string, number>>({});

  const bottleCount = useMemo(() => defaultStrawCount(items), [items]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: BagStockRow[] }>(`/branches/${branchId}/sales/bags`);
        if (cancelled) return;
        setMaterials(res.data);

        const saved: Record<string, number> = {};
        for (const p of savedPackaging) saved[p.packaging_material_id] = p.quantity;
        savedRef.current = saved;

        if (savedPackaging.length > 0) {
          setQty(saved); // already packed — show what was saved
        } else {
          // Prefill defaults: 1 straw per bottle + 1 bag sized by count.
          const next: Record<string, number> = {};
          const straw = res.data.find((m) => m.kind === "straw");
          if (straw && bottleCount > 0) next[straw.material_id] = bottleCount;
          const bag = pickBagMaterial(res.data.filter((m) => m.kind === "bag"), defaultBagSize(bottleCount));
          if (bag) next[bag.material_id] = 1;
          setQty(next);
        }
      } catch {
        if (!cancelled) setMaterials([]); // offline/no access — card renders empty
      }
    })();
    return () => { cancelled = true; };
  }, [branchId, orderId, savedPackaging, bottleCount]);

  const isDirty = useMemo(() => {
    const ids = new Set([...Object.keys(qty), ...Object.keys(savedRef.current)]);
    for (const id of ids) {
      if ((qty[id] ?? 0) !== (savedRef.current[id] ?? 0)) return true;
    }
    return false;
  }, [qty]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const packaging = Object.entries(qty)
        .filter(([, q]) => q > 0)
        .map(([packaging_material_id, quantity]) => ({ packaging_material_id, quantity }));
      await api(`/branches/${branchId}/sales/${orderId}/packaging`, {
        method: "PUT",
        body: JSON.stringify({ packaging }),
      });
      savedRef.current = { ...qty };
      onSaved?.();
      toast.success("Packaging saved");
    } catch (err) {
      toast.error(humanizeError(err));
      throw err; // let a CTA flush abort on failure
    } finally {
      setSaving(false);
    }
  }

  useImperativeHandle(ref, () => ({
    saveIfDirty: async () => { if (isDirty) await save(); },
  }), [isDirty, qty]);

  if (materials.length === 0) return null;

  function setQtyFor(id: string, value: number): void {
    setQty((q) => ({ ...q, [id]: Math.max(0, Math.floor(value || 0)) }));
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">Packaging</h3>
      <div className="space-y-2">
        {materials.map((m) => (
          <div key={m.material_id} className="flex items-center justify-between gap-3">
            <div>
              <span className="text-sm text-slate-800">{m.name}</span>
              <span className={`ml-2 text-xs ${m.balance < 0 ? "text-red-500" : "text-slate-400"}`}>
                {m.balance} in stock
              </span>
            </div>
            <input
              type="number"
              min={0}
              disabled={readOnly || saving}
              value={qty[m.material_id] ?? 0}
              onChange={(e) => setQtyFor(m.material_id, Number(e.target.value))}
              className="w-20 rounded-md border border-slate-300 px-2 py-1 text-right text-sm"
            />
          </div>
        ))}
      </div>
      {!readOnly && (
        <button
          type="button"
          disabled={!isDirty || saving}
          onClick={() => void save()}
          className="mt-3 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save packaging"}
        </button>
      )}
    </section>
  );
});
```

Note: verify the import paths for `api`, `humanizeError`, and `toast` against how `online-order-detail.tsx` imports them, and match its Tailwind class conventions. Adjust the three import lines if the project uses different module paths (e.g. a barrel).

- [ ] **Step 3: Wire the card into online-order-detail**

In `apps/admin/src/routes/branch/online-order-detail.tsx`:

1. Add to the `Sale` interface: `packaging?: Array<{ packaging_material_id: string; quantity: number }>;` and confirm `items` carries `sizeMl` (the detail API returns it).
2. Import and create a ref:

```tsx
import { PackagingCard, type PackagingCardHandle } from "../../components/PackagingCard.js";
// inside the component:
const packagingRef = useRef<PackagingCardHandle>(null);
```

3. Flush before the transition at the TOP of both `produce()` and `advance()` (right after `if (!data) return;`):

```tsx
    try {
      await packagingRef.current?.saveIfDirty();
    } catch {
      return; // packaging save failed — do not advance
    }
```

4. Render the card where the order body is shown (e.g. below the items list), only for online/phone orders that are not terminal:

```tsx
{["online", "phone"].includes(data.channel) && (
  <PackagingCard
    ref={packagingRef}
    branchId={branchId}
    orderId={orderId}
    items={(data.items ?? []).map((it) => ({ sizeMl: it.sizeMl ?? null, quantity: it.quantity }))}
    savedPackaging={data.packaging ?? []}
    readOnly={data.status === "delivered" || data.status === "cancelled"}
    onSaved={() => void loadOrder()}
  />
)}
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd apps/admin && npx tsc --noEmit && npx eslint src/components/PackagingCard.tsx src/routes/branch/online-order-detail.tsx src/lib/audit-humanize.ts`
Expected: no errors. Fix any import-path mismatches surfaced here.

- [ ] **Step 5: Manual verification (local run)**

Boot the stack locally (see reference_local_run: standalone pg/redis, export `DATABASE_URL`) and drive the till with Playwright or by hand:
1. Open a paid online order's detail in the branch app.
2. Confirm the Packaging card shows prefilled straws (= bottle count) and a bag sized by count, and the in-stock numbers.
3. Change a straw count, click **Save packaging** → toast success; reload → value persists.
4. On a fresh order, tap **Fulfil & produce** / **Mark ready for pickup** without saving first → the order advances AND the packaging is recorded (verify via the owner packaging/ledger view or a DB check that `packaging_stock_ledger` has the branch decrement).
Expected: all four behave as described. Capture the result.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/PackagingCard.tsx apps/admin/src/routes/branch/online-order-detail.tsx apps/admin/src/lib/audit-humanize.ts
git commit -m "feat(admin): fulfiller packaging card on online-order detail with flush-on-produce"
```

---

## Self-Review

**Spec coverage:**
- New `PUT .../packaging` endpoint with replace-with-diff, warn-but-allow, terminal-reject, active-consumable validation, audit → **Task 1**. ✅
- Order-detail payload extended with `packaging` array → **Task 2**. ✅
- Smart prefill (straws = bottle count; bag size ≤2/3–5/6+) → **Task 3** (calculator) + **Task 4** (applied in card). ✅
- Packaging card, editable, balance hints, read-only when terminal → **Task 4**. ✅
- Flush-on-CTA one-tap → **Task 4** step 3. ✅
- Reporting: `sale_order_packaging` already feeds reports; no code change (per spec). ✅ (no task needed)
- `sale.packaging_set` audit + humanizer → **Task 1** (write) + **Task 4** (humanize). ✅
- No schema change / no migration → confirmed; no migration task exists. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. The only soft notes ("verify import paths", "match Tailwind conventions") are legitimate adaptation checks with concrete fallbacks, not deferred work.

**Type consistency:** `saveIfDirty` used consistently in `PackagingCardHandle`, the ref, and the CTA flush. `packaging_material_id`/`quantity` shape identical across endpoint body, GET response, and card. `defaultStrawCount`/`defaultBagSize`/`pickBagMaterial` signatures match between Task 3 definition and Task 4 usage. `material_id`/`name`/`kind`/`balance` match the existing `/bags` response used in Task 4.
