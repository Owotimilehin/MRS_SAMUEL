# Variance Reconciliation, Loss Tracking & Monthly Report — Design

**Date:** 2026-06-29
**Status:** Approved (design), pending implementation plan

## Problem

Stock variance is currently recorded but inconsistently reconciled, and real
losses vanish silently:

1. **Transfers** — at receive, the branch is credited with the *actual*
   `quantity_received` and the factory was debited `quantity_sent` at dispatch.
   The difference (`sent − received`) simply disappears from total inventory.
   It is treated as an unconditional loss even when the bottles were never
   really lost (mis-pick at the factory, or a branch miscount).
2. **Shift open/close counts** — the physical count is stored as
   `system` vs `counted` vs `variance` (+ a required reason) and pushed to
   Telegram, but the counted quantity is **never written back to on-hand**.
   The system value always wins; the physical count is a discrepancy log only.
3. **No loss record** — there is no durable, queryable record of *what* was
   lost, *how much* (bottles + money), and *why*, and no monthly view.

The owner wants stock to **always reconcile with physical reality**, with the
owner deciding where a transfer variance settles, genuine losses tracked as
first-class records (bottles + ₦ at retail price), and a monthly report.

## Goals

- Transfer variance is settled by the **owner** to Factory, Branch, or Loss —
  per flavour/variant, so one transfer can correct in both directions.
- Shift open/close counts **reconcile on-hand to the physical count**;
  shortfalls become tracked losses.
- Every loss is a durable record: source, branch, product/variant, size,
  quantity, **₦ value at retail price**, reason, date, actor.
- A **monthly variance/loss report**, available both as an owner admin page and
  a month-end Telegram summary.
- Shift-end reporting is strictly **per actual shift**, never the whole day.

## Non-goals

- Cost-basis valuation. There is no cost field on variants; losses are valued
  at the variant's current retail price. (Revisit if cost tracking is added.)
- Customer-facing changes. This is entirely admin/operations.
- Reworking the existing transfer dispatch/receive stock math — those already
  apply the actual sent/received deltas and are left intact.

---

## Workstream A — Transfer variance settlement (owner-only)

**Where:** the owner's transfer-approval action for a transfer in status
`received_with_variance`. Today `PATCH /v1/transfers/:id/approve`
(`transfers.adjust`) just flips status to `completed`. It is replaced/augmented
by a settlement step.

**Model.** For each varianced line the gap is `gap = sent − received`
(`variance = received − sent`). The branch already holds `+received` from the
receive step; the factory already holds `−sent` from dispatch. The owner
chooses where the gap settles, per line:

| Choice  | Stock effect (per line)            | Meaning                                            |
|---------|------------------------------------|----------------------------------------------------|
| Factory | factory on-hand `+= gap`           | Bottles never really left the factory.             |
| Branch  | branch on-hand `+= gap`            | Shipment was fine; branch miscounted on receive.   |
| Loss    | no stock correction; write a loss  | Bottles genuinely lost/broken.                     |

Both Factory and Branch conserve total inventory (the gap is relocated, not
destroyed); only Loss writes it off. The magnitude is identical — the owner is
choosing *where the units physically are*.

**Prompt (UI).** On the approval screen, varianced lines are listed
(flavour, size, sent, received, gap). Owner picks:

- **Adopt → Factory** — one click, every line settles Factory.
- **Ignore** — one click, every line settles Loss (today's behaviour).
- **Check per flavour** — expand and choose Factory / Branch / Loss per line.

**API.** `PATCH /v1/transfers/:id/approve` accepts a body:

```jsonc
{
  "settlements": [
    { "item_id": "<uuid>", "settle": "factory" | "branch" | "loss" }
  ]
}
```

- Validates the transfer is `received_with_variance` and every varianced line
  has a settlement (non-varianced lines need none).
- In one transaction: for each `factory`/`branch` line insert a `stock_ledger`
  adjustment (`delta = gap`, `locationType` = chosen side, `locationId` =
  `factoryId` or `branchId`, `sourceType = "transfer_variance_settlement"`,
  `sourceId = transfer.id`, note referencing transfer number + variance reason);
  for each `loss` line insert a `variance_loss` row (Workstream C). Then flip
  the transfer to `completed`. Write an audit entry.
- **Owner-only**: gated by a new capability `variance.settle` granted only to
  the owner role, *not* the broader `transfers.adjust` managers may hold.

**Backward-compat:** a request with no `settlements` body (or all `loss`) keeps
today's "write it off" behaviour, so nothing breaks if the UI is stale.

---

## Workstream B — Shift open/close count reconciliation

At shift open (`shift-open.ts`) and close (`daily-close.ts`), after the count
rows are written, reconcile branch on-hand to the **counted** quantity for each
varianced `(product, variant)`:

- `recon = counted − expected` (= the stored `variance`).
- Insert a `stock_ledger` adjustment: `delta = recon`, `locationType = "branch"`,
  `locationId = branchId`, `sourceType = "shift_count_reconcile"`,
  `sourceId = <shift_open or daily_close id>`, note carrying the variance reason.
- After reconciliation, on-hand equals the physical count.

**Loss capture:** every **negative** reconcile (`recon < 0`, i.e. counted short)
writes a `variance_loss` row (qty = `−recon`, source `shift_close`/`shift_open`,
with the staff reason). Positive reconciles (found stock) adjust up and are
recorded as variances but **not** losses.

No new approval gate — the staff physically counted, and `variance_reason` is
already mandatory on a moved line. The owner reviews via the monthly report.

---

## Workstream C — Loss tracking (`variance_loss` table)

New table, written from A (Loss choice) and B (shift shortfall):

```
variance_loss
  id              uuid pk
  source          text   -- 'transfer' | 'shift_close' | 'shift_open'
  source_id       uuid   -- transfer id / daily_close id / shift_open id
  branch_id       uuid   fk
  product_id      uuid   fk
  variant_id      uuid   fk null
  size_ml         int    null
  quantity        int    -- bottles lost (positive)
  unit_price_ngn  int    -- variant retail price snapshot at time of loss
  value_ngn       int    -- quantity * unit_price_ngn
  reason          text   null
  recorded_by     uuid   fk
  occurred_at     timestamptz
```

`value_ngn` is snapshotted at record time (retail price then), so later price
changes don't rewrite history. Indexed on `(occurred_at)` and `(branch_id,
occurred_at)` for monthly queries.

---

## Workstream D — Monthly report (admin page + Telegram)

**Endpoint:** `GET /v1/reports/variance?month=YYYY-MM` (owner-only,
`reports.view` + owner). Returns, for the month:
- Per flavour/variant: quantity and ₦ for losses, plus net variance and how
  variances settled (factory / branch / loss counts).
- Totals: ₦ lost by source (transfer vs shift), total bottles lost, net stock
  variance.

**Admin page:** `/owner/variance` (sits with Reports/Analytics). Month picker →
summary cards (₦ lost, bottles lost, by source) + a per-flavour breakdown table.
Reuses the existing admin data-state / error patterns.

**Telegram:** a worker cron (month-end) posts a summary — total ₦ lost, top few
losses by value, split by source — with a link to the admin page. Follows the
existing outbox/notification pattern.

---

## Workstream E — Per-shift reporting integrity

Shift money is already shift-scoped (`expectedCashForShift(openedAt → now)` in
`daily-close.ts`). This workstream audits the rest of the shift-end chain — the
Telegram shift-end notification, owner close-detail, and the closes list — and
fixes any figure that reports whole-day sales instead of the open shift's
window, so a shift-end is strictly that shift's record. (`expectedStockForDay`
is reviewed: stock expectation is a point-in-time on-hand and is fine, but its
naming/scope is confirmed against the shift model.)

---

## Data / plumbing summary

- **Migration:** create `variance_loss`; extend `stock_ledger.source_type`
  (or its check/enum) with `transfer_variance_settlement` and
  `shift_count_reconcile`.
- **Capability:** add `variance.settle` to the capability list
  (`packages/shared` permissions) and grant it to the owner role only.
- **API:** modify `transfers.ts` approve; modify `daily-close.ts` and
  `shift-open.ts` to reconcile + record losses; new `reports/variance` endpoint;
  new worker cron for the monthly Telegram.
- **Admin:** transfer-approval settlement UI; new `/owner/variance` report page.

## Testing

- **Settlement math** (unit): Factory/Branch/Loss produce correct per-line
  deltas; mixed-direction lines in one transfer settle independently; total
  inventory conserved for Factory/Branch, reduced only for Loss.
- **Shift reconcile** (integration): on-hand equals counted after close/open;
  negative reconcile writes a `variance_loss`; positive does not.
- **Loss record** (integration): `value_ngn = quantity * retail price` snapshot;
  source + ids correct.
- **Monthly aggregation** (unit/integration): correct grouping, totals, month
  boundaries (Lagos TZ), by-source split.
- **Per-shift scoping** (integration): shift-end figures cover only the open
  shift window, proven across two shifts in one day.
- **Authorization**: settlement endpoint rejects non-owner (manager with
  `transfers.adjust` is denied).

## Open questions / assumptions

- Losses valued at **retail price** (confirmed). No cost basis exists.
- Shift-count reconciliation is **automatic** (no owner gate); only transfer
  settlement is owner-gated, since transfers involve two locations and judgement
  about where the units are.
