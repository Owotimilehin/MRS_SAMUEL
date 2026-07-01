# Per-Shift Reporting Integrity (Plan 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A shift-end is strictly that shift's record — make the daily-close **preview** shift-scoped so it matches the shift-scoped figure the submit actually reconciles against.

**Architecture:** The submit path already computes expected cash with `expectedCashForShift(openedAt → now)`. The pre-close **preview** endpoint still uses the whole-day helpers, so on a day with an earlier shift it shows staff a false variance before they submit. Fix: the preview resolves the branch's currently-open shift and scopes to its window; with no open shift it falls back to the day figure (matching the legacy detail-read fallback).

**Tech Stack:** Hono + Drizzle API, Vitest.

## Audit result (why only one fix)

Traced the full shift-end chain; only the preview leaks whole-day:
- **Submit** (`daily-close.ts:71`) — `expectedCashForShift` ✓ shift-scoped.
- **Closes list `/` & detail `/:id`** — read stored `dailyClose.varianceNgn`/`systemCashTotalNgn`, computed shift-scoped at submit ✓. Detail's cash-sales itemization already prefers the shift window (`:329-333`) ✓.
- **Telegram `daily_close.submitted`** (`worker/outbox.ts:271`) — reads the shift-scoped `variance_ngn`/`transfer_ngn` from the payload enqueued at submit ✓.
- **Preview** (`daily-close.ts:268-269`) — `expectedCashForDay`/`cashSalesForDay` ✗ **whole-day**. THIS is the fix.

## Global Constraints

- `expectedCashForShift(db, branchId, openedAt, closedAt)` and `cashSalesForShift(...)` already exist in `@ms/domain`; reuse them.
- Open shift = `shift_open` row with `status='open'` for the branch (same query submit uses).
- With an open shift: window is `[openedAt, now)`. With none: fall back to `expectedCashForDay`/`cashSalesForDay` for the requested `date` (preserves the existing no-shift preview test).
- `expectedStockForDay` is a point-in-time on-hand (not windowed) — leave it unchanged.
- Integration tests run `TZ=UTC`.

---

### Task 1: Shift-scope the daily-close preview

**Files:**
- Modify: `apps/api/src/routes/daily-close.ts` (the `r.get("/preview", ...)` handler, ~264-274)
- Modify: `apps/api/test/integration/daily-close-flow.test.ts` (add a shift-scoped preview test; existing no-shift preview test must stay green)

**Interfaces:**
- Consumes: `expectedCashForShift`, `cashSalesForShift` (already imported in the file), `shiftOpen`, `and`, `eq`.
- Produces: `GET /daily-close/preview` returns `expected_cash_ngn`/`cash_sales` scoped to the open shift when one exists.

- [ ] **Step 1: Write the failing test**

Add to `daily-close-flow.test.ts` (after the existing "preview returns expected cash + stock" test):

```ts
  it("preview is scoped to the open shift, not the whole day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // No open shift yet → preview falls back to the day figure (3 earlier sales).
    const dayView = await call<{ data: ClosePreview }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close/preview?date=${today}`,
    );
    expect(dayView.body.data.expected_cash_ngn).toBe(7500);

    // Open a fresh shift NOW (after those 3 sales), then sell 1 more inside it.
    await openShift(branch.id, today, 17);
    const sale = await call<{ data: SaleOrderRow }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "transfer",
      created_at_local: new Date().toISOString(),
    });
    await call("PATCH", `/v1/branches/${branch.id}/sales/${sale.body.data.id}/pay`);

    // Preview now reflects ONLY the in-shift sale (₦2,500), not the 3 earlier ones.
    const shiftView = await call<{ data: ClosePreview }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close/preview?date=${today}`,
    );
    expect(shiftView.body.data.expected_cash_ngn).toBe(2500);

    // Clean up: close the shift so later tests start with no open shift.
    const { createDbClient, shiftOpen } = await import("@ms/db");
    const { and, eq } = await import("drizzle-orm");
    const tmpDb = createDbClient(process.env.DATABASE_URL!);
    await tmpDb.update(shiftOpen).set({ status: "closed", closedAt: new Date() })
      .where(and(eq(shiftOpen.branchId, branch.id), eq(shiftOpen.status, "open")));
  });
```

(If `ClosePreview` lacks `cash_sales`, the assertions above only use `expected_cash_ngn`, which it already has.)

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC pnpm --filter @ms/api test -- --run daily-close-flow`
Expected: the new test FAILS — `expected_cash_ngn` is 10000 (whole day: 4 sales) instead of 2500.

- [ ] **Step 3: Shift-scope the preview handler**

Replace the `/preview` body in `daily-close.ts`:

```ts
  r.get("/preview", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);

    // Scope money to the open shift's window so the preview matches what the
    // submit will reconcile against. With no open shift, fall back to the day.
    const [openShift] = await db
      .select()
      .from(shiftOpen)
      .where(and(eq(shiftOpen.branchId, branchId), eq(shiftOpen.status, "open")));

    let cash: number;
    let cashSales;
    if (openShift?.openedAt) {
      const now = new Date();
      cash = await expectedCashForShift(db, branchId, openShift.openedAt, now);
      cashSales = await cashSalesForShift(db, branchId, openShift.openedAt, now);
    } else {
      cash = await expectedCashForDay(db, branchId, new Date(date));
      cashSales = await cashSalesForDay(db, branchId, new Date(date));
    }
    const stock = await expectedStockForDay(db, branchId);
    return c.json({
      data: { expected_cash_ngn: cash, expected_stock: stock, cash_sales: cashSales },
    });
  });
```

`shiftOpen`, `and`, `eq` are already imported in this file (used by submit).

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=UTC pnpm --filter @ms/api test -- --run daily-close-flow daily-close-reconcile`
Expected: all pass — the new shift-scoped test, the existing no-shift preview test (still 7500 via fallback), and the reconcile suite.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @ms/api exec tsc --noEmit`
```bash
git add apps/api/src/routes/daily-close.ts apps/api/test/integration/daily-close-flow.test.ts
git commit -m "fix(api): daily-close preview is shift-scoped, matching submit"
```

---

## Self-Review

- **Spec coverage (Workstream E):** preview is the only whole-day leak in the shift-end chain (audit above); all other surfaces already shift-scoped. The one fix closes it. ✅
- **Placeholder scan:** full handler + test code present. ✅
- **Type consistency:** reuses existing `expectedCashForShift`/`cashSalesForShift` signatures; open-shift query mirrors submit's. ✅
- **No regression:** no-shift preview keeps the day fallback, preserving the existing test's 7500. ✅
