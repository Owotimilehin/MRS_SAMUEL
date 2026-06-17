# Receipts Phase 1 (Browser Printing) — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Print branded 80mm receipts from the admin app via the browser, with a POS success modal and reprint buttons on sale/order/preorder/return.

**Architecture:** A pure `ReceiptData` model + builder functions feed a single `<Receipt>` React component (3 style variants). A `printReceipt()` helper mounts the component into a hidden print root and calls `window.print()` against an 80mm `@page` stylesheet. POS replaces its green flash banner with a `SaleSuccessModal`. QR is a static bundled PNG (always → mrssamuel.com).

**Tech Stack:** React + TypeScript (apps/admin), Vitest, existing `Modal`, `ngn()` from `lib/format.ts`.

## Global Constraints
- Money: integers NGN, formatted with `ngn()` from `apps/admin/src/lib/format.ts`.
- QR target is the LANDING PAGE only: `https://mrssamuel.com` (static asset).
- 3 styles: `classic` (default), `branded`, `marketing`. Owner-switchable.
- Thermal is B/W; print layout is 80mm (`@page { size: 80mm auto; margin: 0 }`).
- Sizes via existing `sizeLabel(ml)`; channels/payments mapped to friendly labels.
- No new API endpoint required for v1 (data is already on the client).

---

### Task 1: Static assets (QR + receipt logo)
**Files:** Create `apps/admin/public/receipt-qr.png`, `apps/admin/public/receipt-logo.png`
- [ ] Generate QR PNG for `https://mrssamuel.com` (≥360px) → `receipt-qr.png`.
- [ ] Copy `apps/customer/src/assets/logo-dark.png` → `receipt-logo.png`.
- [ ] Verify both load at `/receipt-qr.png` and `/receipt-logo.png` in dev.

### Task 2: `ReceiptData` model + builders (pure, tested)
**Files:** Create `apps/admin/src/lib/receipt-data.ts`, Test `apps/admin/src/lib/receipt-data.test.ts`
**Produces:**
```ts
export interface ReceiptLine { name: string; sizeMl: number; qty: number; unitNgn: number; lineNgn: number; }
export interface ReceiptData {
  style: "classic" | "branded" | "marketing";
  receiptNo: string;            // SO-… or LOCAL-…
  dateLabel: string;            // "16 Jun 2026 · 21:18" (Africa/Lagos)
  branchName: string; branchAddress: string; branchPhone: string;
  servedBy: string;             // staff name | role
  channelLabel: string; paymentLabel: string;
  lines: ReceiptLine[];
  subtotalNgn: number; totalNgn: number;
  cashNgn?: number; changeNgn?: number;   // cash only
  isPreorder?: boolean; fulfilLabel?: string;
}
export function channelLabel(c: string): string;   // walkup→"Walk-in", whatsapp→"WhatsApp", online→"Online", phone→"Phone"
export function paymentLabel(p: string): string;    // cash→"Cash", card→"Card", transfer→"Transfer"
export function lagosDateLabel(iso: string): string;
```
- [ ] Write failing tests: `channelLabel("walkup")==="Walk-in"`; `paymentLabel("transfer")==="Transfer"`; `lagosDateLabel` formats a known ISO to Lagos; a `buildLines` total equals sum of `qty*unit`.
- [ ] Run → fail.
- [ ] Implement mappers + helpers (use `Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',…})`).
- [ ] Run → pass. Commit.

### Task 3: `<Receipt>` component (3 styles) + print CSS
**Files:** Create `apps/admin/src/components/Receipt.tsx`, `apps/admin/src/components/receipt.css`
**Consumes:** `ReceiptData`. **Produces:** `export function Receipt({ data }: { data: ReceiptData }): JSX.Element`
- [ ] `receipt.css`: `.receipt{width:80mm}` base; `@media print{@page{size:80mm auto;margin:0} body *{visibility:hidden} .receipt-print-root,.receipt-print-root *{visibility:visible} .receipt-print-root{position:absolute;inset:0}}`. Port the mock styles from `docs/receipt-mocks/receipts.html` (header/logo, dashed rules, items table, total, socials, QR box) into the 3 style variants keyed off `data.style`.
- [ ] Render `/receipt-logo.png` (header), `/receipt-qr.png` (footer), socials (@Mrs_samuelfruitjuice · 0901 951 2246 · mrssamuel.com).
- [ ] Manual: render all 3 in a scratch route; compare to mocks.

### Task 4: `printReceipt()` helper
**Files:** Create `apps/admin/src/lib/print-receipt.ts`
**Produces:** `export function printReceipt(data: ReceiptData): void`
- [ ] Mount `<Receipt data>` into a `.receipt-print-root` portal/container, call `window.print()`, unmount after `afterprint`.
- [ ] Manual: triggers the browser print dialog with only the receipt visible.

### Task 5: POS success modal + cash/change
**Files:** Create `apps/admin/src/components/SaleSuccessModal.tsx`; Modify `apps/admin/src/routes/branch/sell.tsx`
**Consumes:** `Modal`, `printReceipt`, `buildReceiptFromCart`.
- [ ] Add `buildReceiptFromCart(...)` to `receipt-data.ts` (maps `cart`+`products`+`sizeLabel`+branch+staff+cash → `ReceiptData`).
- [ ] Add a "Cash received" input to the pay panel; compute change when `paymentMethod==="cash"`.
- [ ] Replace the green `flash` banner success path: on sale success, open `SaleSuccessModal` (✓ summary, change due, **Print receipt** autofocused, **New sale**). Keep the existing toast for errors.
- [ ] Manual: complete a cash sale → modal → Print → dialog shows correct receipt.

### Task 6: Reprint buttons (sale / order / preorder / return)
**Files:** Modify `apps/admin/src/routes/branch/sale-detail.tsx`, `apps/admin/src/routes/owner/order-detail.tsx`, `apps/admin/src/routes/owner/preorders.tsx`, `apps/admin/src/routes/{branch,owner}/return-detail.tsx`
**Consumes:** `printReceipt`, `buildReceiptFromOrder(order, items, products, branch)`.
- [ ] Add `buildReceiptFromOrder(...)` + `buildReturnSlip(...)` to `receipt-data.ts` (map fetched order/return + products list → `ReceiptData`; return slip shows refund total + reason).
- [ ] Add a "Print receipt" button to each detail view wired to `printReceipt(...)`.
- [ ] Manual: open one of each, print, verify numbers match the on-screen record.

### Task 7: Owner receipt-style setting
**Files:** Modify `apps/admin/src/routes/owner/settings.tsx`; Create `apps/admin/src/lib/receipt-settings.ts`
- [ ] `receipt-settings.ts`: read/write active style (`classic|branded|marketing`) — persist via the existing settings mechanism in `settings.tsx` if present, else `localStorage("ms_receipt_style")` with default `classic`.
- [ ] Settings UI: a 3-option selector with live preview thumbnails.
- [ ] `printReceipt`/builders read the active style. Manual: switch style → next print uses it.

### Task 8: Staff display name (optional, role fallback)
**Files:** Create migration `packages/db/migrations/00NN_admin_user_name.sql` (+ `_journal.json`); Modify `packages/db/src/schema/admin-user.ts`; surface `name` on `/v1/auth/me` if cheap.
- [ ] Add nullable `name text` to `admin_user`; journal entry; rebuild `@ms/db`.
- [ ] `servedBy` uses `name ?? email-prefix ?? role`. (If skipped, builders fall back to role — no block.)

---

## Self-Review
- Spec coverage: receipt render (T3), print (T4), POS modal+cash (T5), reprints incl. return slip (T6), 3 styles+owner switch (T7), QR→landing (T1/T3), staff name (T8). ✓
- QR is static landing PNG → no runtime lib, offline-safe. ✓
- No new API endpoint needed; reprints use already-fetched data. ✓
- Phase 2 (Tauri raw ESC/POS + drawer) intentionally excluded.
