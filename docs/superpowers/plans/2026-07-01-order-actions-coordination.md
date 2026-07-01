# Order Actions Coordination + Delivery Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc per-card buttons on the online-order detail pages with one state-driven action model (single primary CTA, gated secondary actions, separated danger zone), and make delivery robust so an order can never silently strand (failed rides surface a Re-book, a poller reconciles status when webhooks go silent).

**Architecture:** A pure resolver `deriveOrderActions(order)` becomes the single brain both the owner and branch detail pages consume — no capability logic inside it (the pages filter by `can()`), so it stays unit-testable. On the backend, the webhook's status-application logic is extracted into a shared `applyDeliveryStatus` used by both the webhook and an extended delivery-watchdog poller; a new `getStatus` provider method lets the poller fetch live status when webhooks don't fire.

**Tech Stack:** TypeScript, React (TanStack Router), Hono, Drizzle ORM, Vitest, pino. Monorepo: `apps/admin`, `apps/api`, `apps/worker`, `packages/domain`.

## Global Constraints

- Node ESM: all local imports use the `.js` extension even from `.ts` sources.
- The resolver `deriveOrderActions` MUST contain **no** capability/`can()` logic — pages gate rendering.
- `applyDeliveryStatus` MUST be idempotent and never move backwards through the state machine (re-applying a terminal status is a no-op).
- Order status is NEVER auto-reverted on a failed/cancelled ride — the failure is surfaced as a Re-book action instead.
- Cancel-and-refund is available only pre-dispatch (`confirmed` / `reconcile_needed` / `paid`).
- Tests run with `TZ=UTC` (matches existing suite convention).
- Frequent commits: one per task minimum.

---

## Phase 1 — Frontend action coordination

### Task 1: `deriveOrderActions` resolver + tests

**Files:**
- Create: `apps/admin/src/lib/order-actions.ts`
- Test: `apps/admin/src/lib/order-actions.test.ts`
- Reference (do not yet modify): `apps/admin/src/lib/order-fulfil-action.ts`, `apps/admin/src/lib/order-journey.ts`

**Interfaces:**
- Consumes: `isDeliveryOrder(o)` and `OrderJourneyInput` from `./order-journey.js`.
- Produces:
  ```ts
  export type OrderActionId =
    | "recheck_payment" | "accept_paid" | "produce" | "book_rider"
    | "advance" | "rebook_rider" | "force_delivered"
    | "mark_refunded" | "cancel_refund";
  export interface OrderActionButton { id: OrderActionId; label: string }
  export interface OrderActions {
    primary: OrderActionButton | null;
    secondary: OrderActionButton[];
    danger: OrderActionButton[];
  }
  export interface OrderActionsInput extends OrderJourneyInput {
    producedAt?: string | null;
    refundOwedNgn?: number | null;
  }
  export function deriveOrderActions(o: OrderActionsInput): OrderActions;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/lib/order-actions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveOrderActions } from "./order-actions.js";

const del = { channel: "online", deliveryState: "Lagos", deliveryFeeNgn: 1500 };
const pickup = { channel: "online", deliveryFeeNgn: 0 };

describe("deriveOrderActions — primary CTA priority", () => {
  it("confirmed (unsettled) → primary Re-check, accept as secondary, cancel in danger", () => {
    const a = deriveOrderActions({ ...del, status: "confirmed" });
    expect(a.primary).toEqual({ id: "recheck_payment", label: "↻ Re-check payment" });
    expect(a.secondary).toContainEqual({ id: "accept_paid", label: "Accept as paid" });
    expect(a.danger).toContainEqual({ id: "cancel_refund", label: "Cancel & mark refund owed" });
  });

  it("reconcile_needed → primary Re-check", () => {
    expect(deriveOrderActions({ ...del, status: "reconcile_needed" }).primary?.id).toBe("recheck_payment");
  });

  it("failed ride outranks fulfilment → primary Re-book", () => {
    const a = deriveOrderActions({ ...del, status: "paid", delivery: { status: "failed" } });
    expect(a.primary).toEqual({ id: "rebook_rider", label: "↻ Re-book rider" });
  });

  it("cancelled ride (order not delivered) → primary Re-book", () => {
    expect(deriveOrderActions({ ...del, status: "out_for_delivery", delivery: { status: "cancelled" } }).primary?.id)
      .toBe("rebook_rider");
  });

  it("unproduced preorder at paid → primary Produce", () => {
    expect(deriveOrderActions({ ...del, status: "paid", isPreorder: true, producedAt: null }).primary)
      .toEqual({ id: "produce", label: "Fulfil & produce" });
  });

  it("paid delivery order, no ride → primary Book rider, manual advance as secondary", () => {
    const a = deriveOrderActions({ ...del, status: "paid" });
    expect(a.primary).toEqual({ id: "book_rider", label: "Book rider" });
    expect(a.secondary).toContainEqual({ id: "advance", label: "Mark out for delivery" });
  });

  it("paid pickup order → primary Mark ready for pickup", () => {
    expect(deriveOrderActions({ ...pickup, status: "paid" }).primary)
      .toEqual({ id: "advance", label: "Mark ready for pickup" });
  });

  it("out_for_delivery, no live ride → primary Mark delivered, force in secondary", () => {
    const a = deriveOrderActions({ ...del, status: "out_for_delivery" });
    expect(a.primary).toEqual({ id: "advance", label: "Mark delivered" });
    expect(a.secondary).toContainEqual({ id: "force_delivered", label: "Force delivered (fallback)" });
  });

  it("handed_over → primary Mark collected", () => {
    expect(deriveOrderActions({ ...pickup, status: "handed_over" }).primary)
      .toEqual({ id: "advance", label: "Mark collected" });
  });

  it("live ride suppresses manual advance (webhook-driven) but keeps force fallback", () => {
    const a = deriveOrderActions({ ...del, status: "out_for_delivery", delivery: { status: "in_transit" } });
    expect(a.primary).toBeNull();
    expect(a.secondary).toContainEqual({ id: "force_delivered", label: "Force delivered (fallback)" });
  });

  it("delivered → terminal, no actions", () => {
    const a = deriveOrderActions({ ...del, status: "delivered" });
    expect(a.primary).toBeNull();
    expect(a.secondary).toEqual([]);
    expect(a.danger).toEqual([]);
  });

  it("cancelled → terminal, no actions", () => {
    const a = deriveOrderActions({ ...del, status: "cancelled" });
    expect(a.primary).toBeNull();
    expect(a.danger).toEqual([]);
  });
});

describe("deriveOrderActions — payment/refund gating", () => {
  it("settled paid order shows NO recheck/accept", () => {
    const a = deriveOrderActions({ ...del, status: "paid" });
    const ids = [a.primary, ...a.secondary].filter(Boolean).map((b) => b!.id);
    expect(ids).not.toContain("recheck_payment");
    expect(ids).not.toContain("accept_paid");
  });

  it("refund owed surfaces Mark refunded regardless of status", () => {
    expect(deriveOrderActions({ ...del, status: "delivered", refundOwedNgn: 4500 }).secondary)
      .toContainEqual({ id: "mark_refunded", label: "Mark refunded" });
  });

  it("cancel & refund NOT available after dispatch", () => {
    expect(deriveOrderActions({ ...del, status: "out_for_delivery" }).danger)
      .not.toContainEqual({ id: "cancel_refund", label: "Cancel & mark refund owed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/admin && npx vitest run src/lib/order-actions.test.ts`
Expected: FAIL — "Cannot find module './order-actions.js'".

- [ ] **Step 3: Write the resolver**

Create `apps/admin/src/lib/order-actions.ts`:

```ts
import { isDeliveryOrder, type OrderJourneyInput } from "./order-journey.js";

export type OrderActionId =
  | "recheck_payment"
  | "accept_paid"
  | "produce"
  | "book_rider"
  | "advance"
  | "rebook_rider"
  | "force_delivered"
  | "mark_refunded"
  | "cancel_refund";

export interface OrderActionButton {
  id: OrderActionId;
  label: string;
}

export interface OrderActions {
  primary: OrderActionButton | null;
  secondary: OrderActionButton[];
  danger: OrderActionButton[];
}

export interface OrderActionsInput extends OrderJourneyInput {
  producedAt?: string | null;
  refundOwedNgn?: number | null;
}

const LIVE_RIDE = new Set(["searching_rider", "assigned", "picked_up", "in_transit"]);
const FAILED_RIDE = new Set(["failed", "cancelled"]);
const SETTLED = new Set(["paid", "out_for_delivery", "handed_over", "delivered"]);

/**
 * The single source of truth for what an admin can do on an online order,
 * shared by the owner + branch detail pages so they never drift. Returns
 * every *applicable* action for the order's current state; the pages filter
 * by capability (`orders.manage` / `orders.accept_payment` / `pos.sell`).
 * Deliberately capability-free so it stays a pure, exhaustively-tested unit.
 */
export function deriveOrderActions(o: OrderActionsInput): OrderActions {
  const secondary: OrderActionButton[] = [];
  const danger: OrderActionButton[] = [];
  let primary: OrderActionButton | null = null;

  const status = o.status;
  const terminal = status === "delivered" || status === "cancelled";
  const delivery = isDeliveryOrder(o);
  const rideStatus = o.delivery?.status ?? null;
  const rideLive = rideStatus != null && LIVE_RIDE.has(rideStatus);
  const rideFailed = rideStatus != null && FAILED_RIDE.has(rideStatus);
  const unsettled = status === "confirmed" || status === "reconcile_needed";

  // Refund owed is orthogonal to status.
  if ((o.refundOwedNgn ?? 0) > 0) {
    secondary.push({ id: "mark_refunded", label: "Mark refunded" });
  }

  if (terminal) {
    return { primary, secondary, danger };
  }

  // Cancel & refund — pre-dispatch only.
  if (unsettled || status === "paid") {
    danger.push({ id: "cancel_refund", label: "Cancel & mark refund owed" });
  }

  // ── Primary CTA priority (first match wins) ──
  if (unsettled) {
    primary = { id: "recheck_payment", label: "↻ Re-check payment" };
    secondary.push({ id: "accept_paid", label: "Accept as paid" });
    return { primary, secondary, danger };
  }

  if (rideFailed) {
    primary = { id: "rebook_rider", label: "↻ Re-book rider" };
    return { primary, secondary, danger };
  }

  if (o.isPreorder && !o.producedAt && status === "paid") {
    primary = { id: "produce", label: "Fulfil & produce" };
    return { primary, secondary, danger };
  }

  if (status === "paid") {
    if (!delivery) {
      primary = { id: "advance", label: "Mark ready for pickup" };
    } else if (rideLive) {
      primary = null; // webhook/poller drives the transition
    } else {
      primary = { id: "book_rider", label: "Book rider" };
      secondary.push({ id: "advance", label: "Mark out for delivery" });
    }
    return { primary, secondary, danger };
  }

  if (status === "out_for_delivery") {
    if (!rideLive) primary = { id: "advance", label: "Mark delivered" };
    secondary.push({ id: "force_delivered", label: "Force delivered (fallback)" });
    return { primary, secondary, danger };
  }

  if (status === "handed_over") {
    primary = { id: "advance", label: "Mark collected" };
    return { primary, secondary, danger };
  }

  return { primary, secondary, danger };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/admin && npx vitest run src/lib/order-actions.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/order-actions.ts apps/admin/src/lib/order-actions.test.ts
git commit -m "feat(admin): deriveOrderActions state resolver for order detail"
```

---

### Task 2: Owner order-detail consumes the resolver

**Files:**
- Modify: `apps/admin/src/routes/owner/order-detail.tsx`

**Interfaces:**
- Consumes: `deriveOrderActions`, `OrderActionButton`, `OrderActionId` from `../../lib/order-actions.js`.
- The existing handlers stay: `recheckPayment`, `acceptAsPaid` (via modal), `produce`, `advance`, `bookRide`, `markRefunded` (via modal), `cancelAndRefund` (via modal).

**Constant to add** (stale-delivery threshold), at top of file after imports:

```ts
const STALE_DELIVERY_HOURS = 2;
```

- [ ] **Step 1: Replace the fulfil-action import**

In `order-detail.tsx`, replace:

```ts
import { nextFulfilAction } from "../../lib/order-fulfil-action.js";
```

with:

```ts
import { deriveOrderActions, type OrderActionId } from "../../lib/order-actions.js";
```

- [ ] **Step 2: Add an action dispatcher**

Inside `OrderDetailPage`, after the `advance` function (around line 136), add a single click-router so the page maps action ids to the existing handlers:

```ts
function runAction(id: OrderActionId): void {
  switch (id) {
    case "recheck_payment": void recheckPayment(); break;
    case "accept_paid": setShowAcceptModal(true); break;
    case "produce": void produce(); break;
    case "advance": void advance(); break;
    case "force_delivered": void advance(); break;
    case "book_rider": bookRide(); break;
    case "rebook_rider": bookRide(); break;
    case "mark_refunded": setShowMarkRefundedModal(true); break;
    case "cancel_refund": setCancelReason(""); setShowCancelModal(true); break;
  }
}

/** Which capability gates each action. */
function actionAllowed(id: OrderActionId): boolean {
  if (id === "accept_paid" || id === "mark_refunded") return can("orders.accept_payment");
  return can("orders.manage");
}
```

- [ ] **Step 3: Compute actions + stale flag alongside `journey`**

Replace the line `const journey = data ? deriveOrderJourney(data) : null;` (around line 382) with:

```ts
const journey = data ? deriveOrderJourney(data) : null;
const actions = data ? deriveOrderActions(data) : null;
const lastRiderUpdate = data?.delivery
  ? [data.delivery.pickedUpAt, data.delivery.assignedAt].find(Boolean) ?? null
  : null;
const deliveryStalled =
  data?.status === "out_for_delivery" &&
  !!lastRiderUpdate &&
  Date.now() - new Date(lastRiderUpdate).getTime() > STALE_DELIVERY_HOURS * 3600_000;
```

Note: `pickedUpAt` / `assignedAt` are already present on the branch page's `DeliveryRow`; add the same optional fields to this file's `Sale.delivery` type (add `assignedAt?: string | null; pickedUpAt?: string | null; failedAt?: string | null; failReason?: string | null;`).

- [ ] **Step 4: Replace the Status-card fulfilment block with the primary CTA**

Replace the IIFE at lines ~590-642 (the `liveDeliveryStatuses` / `showAdvanceButtons` / `nextFulfilAction` block, through the `DeliveryStatusPanel`) with:

```tsx
<div style={{ marginTop: 14 }}>
  {deliveryStalled && (
    <p style={{ fontSize: 13, color: "var(--warning)", marginBottom: 10 }}>
      ⚠ Delivery may be stalled — no rider update in over {STALE_DELIVERY_HOURS}h. Track, re-book, or force delivered.
    </p>
  )}

  {actions?.primary && actionAllowed(actions.primary.id) && (
    <button
      type="button"
      className="btn btn--primary btn--sm"
      disabled={advanceBusy || recheckBusy}
      onClick={() => runAction(actions.primary!.id)}
      style={{ width: "100%", justifyContent: "center" }}
    >
      {advanceBusy || recheckBusy ? "Saving…" : actions.primary.label}
    </button>
  )}

  {/* Secondary fulfilment/override actions (produce/advance/force). Payment
      + refund secondaries render inside the Payment card instead. */}
  {actions?.secondary
    .filter((b) => (b.id === "advance" || b.id === "force_delivered") && actionAllowed(b.id))
    .map((b) => (
      <button
        key={b.id}
        type="button"
        className="btn btn--subtle btn--sm"
        disabled={advanceBusy}
        onClick={() => runAction(b.id)}
        style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 8 }}
      >
        {advanceBusy ? "Saving…" : b.label}
      </button>
    ))}

  {deliveryError && !editingAddress && (
    <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{deliveryError}</p>
  )}

  <DeliveryStatusPanel delivery={data.delivery ?? null} onRebook={bookRide} />
</div>
```

- [ ] **Step 5: Gate the Payment card on settlement**

Replace the "Action buttons" block (lines ~701-744) so payment actions only appear when unsettled or a refund is owed:

```tsx
{/* Action buttons — only when payment is unsettled or a refund is owed.
    A settled (paid+) order shows no recheck/accept. */}
<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
  {actions?.secondary
    .filter((b) => b.id === "accept_paid" && actionAllowed(b.id))
    .map((b) => (
      <button
        key={b.id}
        type="button"
        className="btn btn--subtle btn--sm"
        onClick={() => runAction(b.id)}
        style={{ justifyContent: "center" }}
      >
        ✓ {b.label}
      </button>
    ))}
  {actions?.secondary
    .filter((b) => b.id === "mark_refunded" && actionAllowed(b.id))
    .map((b) => (
      <button
        key={b.id}
        type="button"
        className="btn btn--subtle btn--sm"
        onClick={() => runAction(b.id)}
        style={{ justifyContent: "center" }}
      >
        ✓ {b.label}
      </button>
    ))}
</div>
```

Also make the whole `data.channel === "online"` payment-actions wrapper only render its buttons when `actions` has payment/refund secondaries — but keep the refund-owed badge + amount-mismatch rows always (they're informational). The Re-check button that used to live here is now the Status-card primary CTA when unsettled, so **remove** the standalone `↻ Re-check payment` button from the Payment card.

- [ ] **Step 6: Move Cancel into a separated danger zone**

Remove the inline `✕ Cancel & mark refund owed` button from the Payment card. After the Delivery card `</section>` (end of the aside, ~line 926), add a danger zone:

```tsx
{actions && actions.danger.some((b) => actionAllowed(b.id)) && (
  <section className="card" style={{ borderColor: "var(--danger)" }}>
    <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: "var(--danger)" }}>
      Danger zone
    </h3>
    {actions.danger
      .filter((b) => actionAllowed(b.id))
      .map((b) => (
        <button
          key={b.id}
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => runAction(b.id)}
          style={{ justifyContent: "center", color: "var(--danger)", width: "100%" }}
        >
          ✕ {b.label}
        </button>
      ))}
  </section>
)}
```

- [ ] **Step 7: Remove the duplicate WhatsApp from the Delivery card**

In the "Booked delivery" block (~lines 877-882), delete the `WhatsApp customer` anchor (the Customer card is now the single canonical place). Leave Track + Cancel ride.

- [ ] **Step 8: Typecheck + build**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: no errors. (If `nextFulfilAction` is now unused anywhere, that's fine — Task 4 removes the file.)

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/routes/owner/order-detail.tsx
git commit -m "feat(admin): owner order-detail state-driven actions + danger zone"
```

---

### Task 3: Branch order-detail consumes the resolver

**Files:**
- Modify: `apps/admin/src/routes/branch/online-order-detail.tsx`

**Interfaces:**
- Consumes: `deriveOrderActions`, `OrderActionId` from `../../lib/order-actions.js`.
- Branch staff gate everything on `pos.sell` (no payment actions on this page — payment is owner-only). So `actionAllowed` here returns `can("pos.sell")` for fulfilment/delivery actions and `false` for `accept_paid` / `mark_refunded` / `cancel_refund` (those never render for branch staff).

- [ ] **Step 1: Swap the import**

Replace `import { nextFulfilAction } from "../../lib/order-fulfil-action.js";` with `import { deriveOrderActions, type OrderActionId } from "../../lib/order-actions.js";`.

- [ ] **Step 2: Add dispatcher + gate + actions**

After the `advance` function, add:

```ts
function runAction(id: OrderActionId): void {
  switch (id) {
    case "produce": void produce(); break;
    case "advance":
    case "force_delivered": void advance(); break;
    case "book_rider":
    case "rebook_rider": bookRide(); break;
    default: break; // payment/refund/cancel: owner-only, not shown here
  }
}
function actionAllowed(id: OrderActionId): boolean {
  if (id === "accept_paid" || id === "mark_refunded" || id === "cancel_refund") return false;
  return can("pos.sell");
}
```

Replace `const journey = data ? deriveOrderJourney(data) : null;` (line 297) by also computing:

```ts
const actions = data ? deriveOrderActions(data) : null;
const lastRiderUpdate = data?.delivery
  ? [data.delivery.pickedUpAt, data.delivery.assignedAt].find(Boolean) ?? null
  : null;
const deliveryStalled =
  data?.status === "out_for_delivery" &&
  !!lastRiderUpdate &&
  Date.now() - new Date(lastRiderUpdate).getTime() > 2 * 3600_000;
```

- [ ] **Step 3: Replace the Status-card action block**

Replace the block at lines ~507-551 (`deliveryIsLive` message + `canAct && nextFulfilAction` IIFE + force-delivered + error + `DeliveryStatusPanel`) with:

```tsx
<div style={{ marginTop: 14 }}>
  {deliveryStalled && (
    <p style={{ fontSize: 13, color: "var(--warning)", marginBottom: 10 }}>
      ⚠ Delivery may be stalled — no rider update in over 2h.
    </p>
  )}
  {actions?.primary && actionAllowed(actions.primary.id) && (
    <button
      type="button"
      className="btn btn--primary btn--sm"
      disabled={advanceBusy}
      onClick={() => runAction(actions.primary!.id)}
      style={{ width: "100%", justifyContent: "center" }}
    >
      {advanceBusy ? "Saving…" : actions.primary.label}
    </button>
  )}
  {actions?.secondary
    .filter((b) => (b.id === "advance" || b.id === "force_delivered") && actionAllowed(b.id))
    .map((b) => (
      <button
        key={b.id}
        type="button"
        className="btn btn--subtle btn--sm"
        disabled={advanceBusy}
        onClick={() => runAction(b.id)}
        style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 8 }}
      >
        {advanceBusy ? "Saving…" : b.label}
      </button>
    ))}
  {deliveryError && !editingAddress && (
    <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{deliveryError}</p>
  )}
  <DeliveryStatusPanel delivery={data.delivery ?? null} onRebook={bookRide} />
</div>
```

The old `deliveryIsLive` / `canAct` locals (lines 307-310) are now unused — delete them.

- [ ] **Step 4: Remove duplicate WhatsApp from Delivery card**

In the booked-delivery block (~lines 693-702) delete the `WhatsApp customer` anchor. Customer card keeps it.

- [ ] **Step 5: Typecheck**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/branch/online-order-detail.tsx
git commit -m "feat(admin): branch order-detail state-driven actions"
```

---

### Task 4: Retire `order-fulfil-action` + migrate its tests

**Files:**
- Delete: `apps/admin/src/lib/order-fulfil-action.ts`, `apps/admin/src/lib/order-fulfil-action.test.ts`
- Verify: no remaining imports of `order-fulfil-action`.

- [ ] **Step 1: Confirm no references remain**

Run: `cd apps/admin && grep -rn "order-fulfil-action" src/ || echo "clean"`
Expected: `clean` (Tasks 2 + 3 replaced both importers). If any remain, fix them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm apps/admin/src/lib/order-fulfil-action.ts apps/admin/src/lib/order-fulfil-action.test.ts
```

- [ ] **Step 3: Full admin unit run + typecheck**

Run: `cd apps/admin && npx tsc --noEmit && npx vitest run src/lib/order-actions.test.ts src/lib/order-journey.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(admin): retire nextFulfilAction, superseded by deriveOrderActions"
```

---

## Phase 2 — Backend delivery robustness

### Task 5: Add `getStatus` to the delivery provider interface + implementations

**Files:**
- Modify: `apps/api/src/delivery/provider.ts` (add method to interface)
- Modify: `apps/api/src/delivery/bolt-mock.ts`, `apps/api/src/delivery/bolt-live.ts`, `apps/api/src/delivery/shipbubble-live.ts`
- Modify: `packages/domain/src/shipbubble.ts` (add `getShipmentStatus` client method)
- Test: `apps/api/src/delivery/get-status.test.ts`

**Interfaces:**
- Produces on `DeliveryProvider`:
  ```ts
  /** Poll the provider for the current status of a dispatched delivery.
   *  Returns a NormalizedWebhook-shaped snapshot, or null when the provider
   *  cannot report status (e.g. manual) or the ref is unknown. */
  getStatus(externalRef: string): Promise<import("./provider.js").NormalizedWebhook | null>;
  ```

- [ ] **Step 1: Write the failing test (mock provider reports a status)**

Create `apps/api/src/delivery/get-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BoltMockProvider } from "./bolt-mock.js";

describe("BoltMockProvider.getStatus", () => {
  it("returns a normalized snapshot for a known ref, null for unknown", async () => {
    const p = new BoltMockProvider({ webhookUrl: "http://127.0.0.1:9/none", fastMode: true });
    // Mock has no persistence, so getStatus reports a deterministic 'delivered'
    // snapshot for any ref it is asked about (the poller integration test relies
    // on this to simulate a webhook that never fired).
    const snap = await p.getStatus("mock_d_probe");
    expect(snap).not.toBeNull();
    expect(snap?.externalRef).toBe("mock_d_probe");
    expect(snap?.status).toBe("delivered");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/delivery/get-status.test.ts`
Expected: FAIL — `p.getStatus is not a function`.

- [ ] **Step 3: Add the interface method**

In `apps/api/src/delivery/provider.ts`, add to the `DeliveryProvider` interface (after `parseWebhook`):

```ts
  /**
   * Poll the provider for the current status of a dispatched delivery, used by
   * the worker to reconcile when a webhook never arrived. Returns a
   * NormalizedWebhook-shaped snapshot, or null when the provider cannot report
   * status (manual) or the ref is unknown.
   */
  getStatus(externalRef: string): Promise<NormalizedWebhook | null>;
```

- [ ] **Step 4: Implement on each provider**

`bolt-mock.ts` — add method (deterministic, drives the poller integration test):

```ts
  async getStatus(externalRef: string): Promise<NormalizedWebhook | null> {
    // The mock does not persist a timeline; report a terminal 'delivered'
    // snapshot so a reconcile poll can simulate a dropped final webhook.
    return { externalRef, status: "delivered", raw: { external_ref: externalRef, status: "delivered" } };
  }
```

`bolt-live.ts` — add a no-op-safe implementation that returns `null` (Bolt is legacy/unused in prod; do not invent an endpoint):

```ts
  async getStatus(_externalRef: string): Promise<NormalizedWebhook | null> {
    // Bolt live polling is not implemented — prod runs Shipbubble/mock. Return
    // null so the reconciler skips Bolt-backed rows rather than guessing.
    return null;
  }
```

`shipbubble-live.ts` — implement via a new client method, mapping through the existing `mapShipbubbleStatus`:

```ts
  async getStatus(externalRef: string): Promise<NormalizedWebhook | null> {
    const snap = await this.client.getShipmentStatus(externalRef);
    if (!snap) return null;
    const status = mapShipbubbleStatus(snap.status);
    if (!status) return null;
    return {
      externalRef,
      status,
      ...(snap.rider ? { rider: snap.rider } : {}),
      raw: snap.raw,
    };
  }
```

Add `mapShipbubbleStatus` to the existing `@ms/domain` import in `shipbubble-live.ts`.

- [ ] **Step 5: Add `getShipmentStatus` to `ShipbubbleClient`**

In `packages/domain/src/shipbubble.ts`, add a method on `ShipbubbleClient`. **Verify the exact tracking endpoint against Shipbubble's live API docs** (use context7 `resolve-library-id` → `query-docs` for "shipbubble tracking status endpoint", or the Shipbubble API reference). The shape below assumes `GET /shipping/status/{order_id}`; adjust the path + field extraction to match the verified contract:

```ts
  /** Poll a shipment's current status for reconcile-on-silent-webhook.
   *  Returns null if the order is unknown. VERIFY the path against Shipbubble docs. */
  async getShipmentStatus(orderId: string): Promise<{ status: string; rider?: { name?: string; phone?: string }; raw: unknown } | null> {
    try {
      const data = await this.req<{ status?: string; courier?: { rider_name?: string; rider_phone?: string } }>(
        `/shipping/status/${encodeURIComponent(orderId)}`,
        { method: "GET" },
      );
      if (!data?.status) return null;
      const rider =
        data.courier?.rider_name || data.courier?.rider_phone
          ? { name: data.courier?.rider_name, phone: data.courier?.rider_phone }
          : undefined;
      return { status: data.status, ...(rider ? { rider } : {}), raw: data };
    } catch {
      return null; // treat any fetch/parse error as "no update available"
    }
  }
```

(Use the existing private request helper — the one used by `cancelLabel` / `createLabel`, referenced as `this.req(...)` around line 325; match its actual name.)

- [ ] **Step 6: Run the test + typecheck**

Run: `cd apps/api && npx vitest run src/delivery/get-status.test.ts && npx tsc --noEmit`
Then rebuild domain: `cd packages/domain && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/delivery/provider.ts apps/api/src/delivery/bolt-mock.ts apps/api/src/delivery/bolt-live.ts apps/api/src/delivery/shipbubble-live.ts packages/domain/src/shipbubble.ts apps/api/src/delivery/get-status.test.ts
git commit -m "feat(api): getStatus on delivery provider for reconcile polling"
```

---

### Task 6: Extract `applyDeliveryStatus` shared function + refactor webhook

**Files:**
- Create: `apps/api/src/delivery/apply-status.ts`
- Test: `apps/api/src/delivery/apply-status.test.ts`
- Modify: `apps/api/src/routes/webhooks-bolt.ts` (call the shared function)

**Interfaces:**
- Produces:
  ```ts
  import type { NormalizedWebhook } from "./provider.js";
  /** Apply a normalized delivery snapshot to the delivery_order + sale_order rows
   *  inside an existing transaction. Idempotent + terminal-safe. Returns whether
   *  any row changed. Emits delivery.completed / delivery.failed outbox events. */
  export async function applyDeliveryStatus(
    tx: any, // the drizzle tx handle
    parsed: NormalizedWebhook,
  ): Promise<{ changed: boolean }>;
  ```
  (Type `tx` to match the codebase's existing tx type — look at how `db.transaction(async (tx) => …)` is typed elsewhere; if there's no exported alias, use `Parameters<Parameters<DbClient["transaction"]>[0]>[0]`.)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/delivery/apply-status.test.ts`. Use the project's existing integration-test DB harness (copy the setup pattern from a sibling test such as `apps/api/src/routes/*delivery*` or any `*.int.test.ts` that seeds `saleOrder` + `deliveryOrder`). The test must cover:

```ts
// Pseudocode structure — fill in with the real harness helpers:
// 1. Seed a paid delivery sale_order + a delivery_order at 'in_transit'.
// 2. applyDeliveryStatus(tx, { externalRef, status: "delivered", raw: {} })
//    → sale_order.status === "delivered", delivery_order.status === "delivered",
//      exactly one delivery.completed outbox row.
// 3. Re-apply the SAME delivered snapshot → { changed: false }, still one outbox row (idempotent).
// 4. Seed another paid order + searching delivery; apply { status: "failed", failReason: "no rider" }
//    → delivery_order.status === "failed", sale_order.status UNCHANGED ("paid"),
//      one delivery.failed outbox row.
```

Assert those four properties with the harness's query helpers.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/delivery/apply-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract the logic**

Create `apps/api/src/delivery/apply-status.ts` by lifting the transaction body from `webhooks-bolt.ts` lines 62-158 (the delivery lookup → patch → sale-order mirror → outbox emit), unchanged in behavior:

```ts
import { eq, desc } from "drizzle-orm";
import { deliveryOrder, saleOrder, outboxEvent } from "@ms/db";
import type { NormalizedWebhook } from "./provider.js";
import { logger } from "../logger.js";

function terminalStatus(s: string): boolean {
  return s === "delivered" || s === "cancelled" || s === "failed";
}

export async function applyDeliveryStatus(
  tx: any,
  parsed: NormalizedWebhook,
): Promise<{ changed: boolean }> {
  const [delivery] = await tx
    .select().from(deliveryOrder)
    .where(eq(deliveryOrder.externalRef, parsed.externalRef))
    .orderBy(desc(deliveryOrder.requestedAt))
    .limit(1);

  if (!delivery) {
    logger.warn({ externalRef: parsed.externalRef, status: parsed.status }, "delivery status: unknown externalRef");
    return { changed: false };
  }
  if (terminalStatus(delivery.status) && delivery.status === parsed.status) {
    return { changed: false };
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: parsed.status, rawWebhookJson: parsed.raw, updatedAt: now };
  if (parsed.rider?.name) patch["riderName"] = parsed.rider.name;
  if (parsed.rider?.phone) patch["riderPhone"] = parsed.rider.phone;
  if (parsed.rider?.vehicle) patch["riderVehicle"] = parsed.rider.vehicle;
  if (parsed.etaMinutes !== undefined) patch["etaMinutes"] = parsed.etaMinutes;
  if (parsed.actualFeeNgn !== undefined) patch["actualFeeNgn"] = parsed.actualFeeNgn;
  if (parsed.failReason) patch["failReason"] = parsed.failReason;
  if (parsed.status === "assigned" && !delivery.assignedAt) patch["assignedAt"] = now;
  if (parsed.status === "picked_up" && !delivery.pickedUpAt) patch["pickedUpAt"] = now;
  if (parsed.status === "delivered" && !delivery.deliveredAt) patch["deliveredAt"] = now;
  if (parsed.status === "failed" && !delivery.failedAt) patch["failedAt"] = now;
  if (parsed.status === "cancelled" && !delivery.cancelledAt) patch["cancelledAt"] = now;

  await tx.update(deliveryOrder).set(patch).where(eq(deliveryOrder.id, delivery.id));

  const [order] = await tx.select().from(saleOrder).where(eq(saleOrder.id, delivery.saleOrderId));
  if (!order) return { changed: true };

  let saleStatusPatch: Record<string, unknown> | null = null;
  if (parsed.status === "picked_up" || parsed.status === "in_transit") {
    if (order.status === "paid") saleStatusPatch = { status: "out_for_delivery", outForDeliveryAt: now, updatedAt: now };
  } else if (parsed.status === "delivered") {
    if (order.status === "paid" || order.status === "out_for_delivery") saleStatusPatch = { status: "delivered", updatedAt: now };
  }
  if (saleStatusPatch) await tx.update(saleOrder).set(saleStatusPatch).where(eq(saleOrder.id, order.id));

  if (parsed.status === "delivered") {
    await tx.insert(outboxEvent).values({
      eventType: "delivery.completed",
      payload: { sale_order_id: order.id, order_number: order.orderNumber, delivery_id: delivery.id },
    });
  } else if (parsed.status === "failed" || parsed.status === "cancelled") {
    await tx.insert(outboxEvent).values({
      eventType: "delivery.failed",
      payload: { sale_order_id: order.id, order_number: order.orderNumber, delivery_id: delivery.id, branch_id: order.branchId, reason: parsed.failReason ?? parsed.status },
    });
  }
  return { changed: true };
}
```

- [ ] **Step 4: Refactor the webhook to call it**

In `webhooks-bolt.ts`, replace the entire `await db.transaction(async (tx) => { … })` body (lines 61-159) with:

```ts
await db.transaction(async (tx) => {
  await applyDeliveryStatus(tx, parsed);
});
```

Add the import: `import { applyDeliveryStatus } from "../delivery/apply-status.js";`. Delete the now-unused local `terminalStatus` at the bottom of the file if nothing else uses it.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && npx vitest run src/delivery/apply-status.test.ts`
Then the webhook's existing test (find it): `npx vitest run $(grep -rl "webhook" src/**/*.test.ts | tr '\n' ' ')`
Expected: PASS — webhook behavior unchanged, apply-status green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/delivery/apply-status.ts apps/api/src/delivery/apply-status.test.ts apps/api/src/routes/webhooks-bolt.ts
git commit -m "refactor(api): extract applyDeliveryStatus shared by webhook + poller"
```

---

### Task 7: Extend the delivery watchdog with a status-reconcile pass

**Files:**
- Modify: `apps/worker/src/jobs/delivery-watchdog.ts`
- Test: `apps/worker/src/jobs/delivery-watchdog.test.ts` (add a reconcile case; create the file if it doesn't exist)

**Interfaces:**
- Consumes: `applyDeliveryStatus` from `@ms/api`? No — the worker imports from its own compiled path. Check how the worker already reaches api code (it doesn't). Instead, **move `applyDeliveryStatus` import to a shared location the worker can import**: the worker already imports `getDeliveryProvider` via `apps/worker/src/delivery-provider.ts`. Mirror that: add a thin re-export or import the provider through the worker's existing `delivery-provider.ts` shim, and import `applyDeliveryStatus` from the api package the same way sibling worker jobs import shared api logic (e.g. how `payaza-reconcile.ts` imports `sweepStuckPayazaOrders`/reconcile helpers). Match that existing pattern exactly.

- [ ] **Step 1: Confirm how the worker imports api/delivery code**

Run: `cd apps/worker && grep -rn "from \"@ms\|delivery-provider\|reconcile" src/jobs/payaza-reconcile.ts src/delivery-provider.ts`
Use whatever import mechanism `payaza-reconcile.ts` uses for shared api logic; `applyDeliveryStatus` and `getDeliveryProvider` must be reachable the same way. If `applyDeliveryStatus` isn't exported from the package the worker consumes, add it to that package's public exports.

- [ ] **Step 2: Write the failing reconcile test**

Add to `apps/worker/src/jobs/delivery-watchdog.test.ts` a case using the worker's DB harness + the mock provider (whose `getStatus` returns `delivered`):

```ts
// Seed a sale_order status='out_for_delivery' with a delivery_order status='in_transit'
// whose updatedAt is older than the STALE_RECONCILE threshold.
// Run runDeliveryWatchdog(db).
// Assert: sale_order.status === 'delivered', delivery_order.status === 'delivered',
//         exactly one delivery.completed outbox row.
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/worker && npx vitest run src/jobs/delivery-watchdog.test.ts`
Expected: FAIL — order still `out_for_delivery`.

- [ ] **Step 4: Add the reconcile pass**

In `delivery-watchdog.ts`, add constants and a third pass appended to `runDeliveryWatchdog`, after the escalation loop and before `return actions;`:

```ts
const RECONCILE_STALE_MIN = 30; // no webhook update in 30 min → poll the provider

// Reconcile pass: active deliveries whose last update is stale get polled via
// the provider's getStatus; any change is applied through the SAME path the
// webhook uses, so no order strands if a webhook is dropped.
const staleCutoff = new Date(Date.now() - RECONCILE_STALE_MIN * 60_000);
const ACTIVE = ["assigned", "picked_up", "in_transit"] as const;
const toReconcile = await db
  .select()
  .from(deliveryOrder)
  .where(and(inArray(deliveryOrder.status, ACTIVE as unknown as string[]), lt(deliveryOrder.updatedAt, staleCutoff)))
  .limit(20);

const provider = getDeliveryProvider();
for (const d of toReconcile) {
  if (!d.externalRef) continue;
  const snap = await provider.getStatus(d.externalRef);
  if (!snap) continue; // provider can't report (manual/unknown) — leave for escalation
  const res = await db.transaction((tx) => applyDeliveryStatus(tx, snap));
  if (res.changed) {
    logger.info({ deliveryId: d.id, status: snap.status }, "delivery reconciled via poll");
    actions++;
  }
}
```

Add imports at the top: `inArray` to the `drizzle-orm` import; `getDeliveryProvider` and `applyDeliveryStatus` per Step 1's discovered mechanism.

- [ ] **Step 5: Run the test**

Run: `cd apps/worker && npx vitest run src/jobs/delivery-watchdog.test.ts`
Expected: PASS (reconcile + existing searching_rider cases).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/jobs/delivery-watchdog.ts apps/worker/src/jobs/delivery-watchdog.test.ts
git commit -m "feat(worker): delivery watchdog reconciles stale rides via provider poll"
```

---

### Task 8: Full-suite verification

- [ ] **Step 1: Typecheck all touched packages**

Run:
```bash
cd apps/admin && npx tsc --noEmit
cd ../api && npx tsc --noEmit
cd ../worker && npx tsc --noEmit
cd ../../packages/domain && npx tsc -b
```
Expected: no errors.

- [ ] **Step 2: Run the affected unit + integration suites**

Run (TZ=UTC to match convention):
```bash
cd apps/admin && TZ=UTC npx vitest run src/lib/order-actions.test.ts src/lib/order-journey.test.ts
cd ../api && TZ=UTC npx vitest run src/delivery/
cd ../worker && TZ=UTC npx vitest run src/jobs/delivery-watchdog.test.ts
```
Expected: PASS. Record any pre-existing failures unrelated to these files (do not fix out of scope; note them).

- [ ] **Step 3: Final commit if any lint/format fixups**

```bash
git add -A && git commit -m "chore: verification fixups for order actions + delivery robustness" || echo "nothing to commit"
```

---

## Notes for the executor

- **Prod runs the mock delivery provider** (Shipbubble live needs keys + `SHIPBUBBLE_PROVIDER=live`). So Task 5's mock `getStatus` and Task 7's reconcile are the paths that actually execute in prod today; the Shipbubble live `getShipmentStatus` endpoint (Task 5 Step 5) is the one place needing doc-verification and is only exercised once live keys are set.
- **Do not eyeball-claim done.** After merge this needs a real online order walked through the till + a hard PWA refresh, per the project's standing caveat.
- If `apply-status.test.ts` / watchdog reconcile test cannot reach a DB harness quickly, keep the pure-logic assertions in a unit test and mark the DB-backed assertions with the existing integration-test tag the repo uses — do not skip coverage silently.
