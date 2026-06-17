# Receipts + Thermal Printing — Design Spec

**Date:** 2026-06-17
**Status:** Approved (design direction); ready for implementation plan
**Printer:** Xprinter **XP-80T** — 80mm thermal, USB, ESC/POS, cash-drawer kick (24V)

## Goal

Generate and print branded receipts for every sale/order/preorder/return on an
80mm thermal printer, starting with **browser printing** (Phase 1) and adding
**Tauri native raw ESC/POS** later (Phase 2). Replace the POS green "flash"
banner with a conversational **success modal** that offers receipt printing. A
**QR code** on every receipt links to the **landing page (`mrssamuel.com`)** to
pull buyers back to the store.

## Decisions (locked with owner)

- **Default style:** Design 1 "Classic Till". All **3 styles** (Classic Till,
  Branded Clean, Marketing Magnet) ship; the **owner can switch** the active
  style in admin settings.
- **QR target:** the landing page `https://mrssamuel.com` **only** (marketing
  referral). Not a per-receipt page. Same QR on every receipt → can be a single
  cached asset.
- **Cash handling:** POS captures **cash tendered**, computes **change**; both
  print on cash receipts.
- **Print buttons:** POS success modal + reprint on Branch sale detail, Owner
  order detail, Preorder detail, and a **Return/refund slip** on returns.
- **Phase 1 transport:** `window.print()` against an 80mm print stylesheet
  (reliable through the Xprinter Windows driver; QR/logo print as images).
- **Phase 2 transport:** Tauri native printing / raw ESC/POS for silent print +
  cash-drawer kick. Same `Receipt` component; only transport changes.

## Real data findings (from production DB — drive the build)

- **Receipt number = `sale_order.order_number`**, format `SO-YYYY-NNNNN`
  (e.g. `SO-2026-00008`).
- **Sizes** are `330` / `650` (ml). **Prices** live in `product_price`
  (`price_ngn`), but line items snapshot **`sale_order_item.unit_price_ngn`** +
  `line_total_ngn` + `quantity` → **a reprint reads the immutable order snapshot**,
  joining `product` (name) and `product_variant` (size_ml).
- **Branch header** comes from `branch`: name, `address`, `phone`
  (Ajao Estate · 30 Asa Afariogun Street, Ajao Estate, Ikeja, Lagos · 0706 722 0914).
- **Channels** (`walkup`, `whatsapp`, `online`, `phone`) and **payment methods**
  (`cash`, `card`, `transfer`, …) are real enums — render friendly labels
  ("Walk-in", "Cash").
- ⚠️ **`admin_user` has NO name column** (email/phone/role only). "Served by"
  needs an optional **`name`** field on `admin_user` (migration); fall back to
  email-prefix → role.
- ⚠️ **Bags** (`packaging_material`: Small/Medium/Large Bag) store **no sale
  price** (only `unit_label`/cost). If bags are charged, a sale price source is
  required; otherwise omit bag pricing from the receipt total.
- **Socials/footer:** Instagram `@Mrs_samuelfruitjuice`, WhatsApp `0901 951 2246`
  (`wa.me/2349019512246`), website `mrssamuel.com`. Logo: `logo-dark.png`
  (solid black on transparent — ideal for thermal).

## Architecture

### 1. `Receipt` rendering (single source of truth)
A `Receipt` React component in admin that takes a normalized `ReceiptData`
(business header, branch, line items, totals, payment, cash/change, footer,
style id) and renders an **80mm** layout. Three style variants share the same
data, differing only in layout/CSS. QR rendered client-side from a small bundled
QR lib (e.g. `qrcode`) → no network at print time; data is the static landing URL.

### 2. `ReceiptData` assembly
- **POS (offline-first):** assemble from the **local sale** object that
  `createLocalSale` already returns (items, sizes, prices, totals) + branch +
  staff + cash/change captured in the modal. No server round-trip required to
  print. `order_number` may be pending pre-sync → show the local sequence and
  reconcile the printed number with the server number on sync (or print after
  the sync assigns it; decided in the plan).
- **Reprints:** fetch a sale's full data from the API (extend an existing
  sale/order detail endpoint to return line items joined to product/variant), map
  to `ReceiptData`.

### 3. Printing (Phase 1 — browser)
- A dedicated print container + `@media print` stylesheet at `@page { size: 80mm auto; margin: 0 }`.
- `window.print()`; document guidance for Chrome `--kiosk-printing` to make it
  silent later. Set Xprinter as default printer.

### 4. POS success modal
Replaces the `flash` banner in `apps/admin/src/routes/branch/sell.tsx`:
"✓ Sale complete · N items · ₦total · payment", change due (cash), and actions:
**Print receipt** (autofocused), **New sale**. Cash-received input added to the
till to compute change before completing.

### 5. Receipt settings (owner-editable)
A small settings surface (extend `apps/admin/src/routes/owner/settings.tsx`):
active **style id**, footer line, social handles, toggle the "10% off" perk
(Design 3). Persisted server-side (new lightweight `receipt_settings` row or
existing settings store). Branch address/phone continue to come from `branch`.

### 6. Schema changes
- `admin_user.name text` (nullable) — staff display name for "Served by".
- (Optional) `receipt_settings` (singleton) for style + footer + perk toggle, OR
  reuse an existing app-settings mechanism if present.
- Migration files + `_journal.json` entry; rebuild `@ms/db`.

## Scope boundaries (YAGNI)
- **No** per-receipt public web page / PDF-by-QR (QR is landing-only now). In-app
  reprint covers "view again".
- **No** WebUSB/ESC/POS in Phase 1 (Windows driver-claim fragility); deferred to
  Tauri Phase 2.
- Email/SMS receipt delivery is **out of scope** for v1 (modal may stub it).

## Testing
- Unit: `ReceiptData` assembly from a local sale + from an order snapshot
  (totals, change math, label mapping).
- Visual: print-preview the 3 styles at 80mm; verify QR scans to `mrssamuel.com`.
- Manual: print on the XP-80T (default Windows driver), confirm 80mm fit, logo
  + QR legibility, cash/change correctness.

## Phasing
1. **Phase 1 (browser):** `Receipt` component (3 styles) + data assembly + POS
   modal + reprint buttons + receipt settings + `admin_user.name`. Ship.
2. **Phase 2 (Tauri):** native raw ESC/POS transport + cash-drawer kick; printer
   selection in desktop settings.
