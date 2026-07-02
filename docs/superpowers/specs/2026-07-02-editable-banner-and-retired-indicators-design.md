# Editable homepage banner + retired indicators on the Products page

Date: 2026-07-02

## Problem

1. The homepage top-bar banner (`apps/customer/src/components/StockBanner.tsx`) is
   **auto-generated from live stock** and cannot be edited anywhere. The owner wants
   to post a custom message — e.g. "330ml is for bulk preorder only, 650ml still
   available for same-day delivery" — without a code change.
2. The owner Products page (`apps/admin/src/routes/owner/products.tsx`) gives no
   visual cue for **retired sizes** (`variant.is_active === false`). A retired size
   still appears in the admin list (the list filters only `deleted_at IS NULL`), so
   the owner cannot tell which sizes are hidden from the storefront.

There is currently **no settings-persistence layer**: the Settings page only edits
branches and stores the receipt style in the browser. No key/value table, no public
settings endpoint.

## Scope

- Homepage banner only (matches where the banner renders today). Not site-wide.
- Retired indicators are **admin Products page only**. The public catalog already
  hides retired sizes / soft-deleted products, so no customer-facing change.

## Part 1 — Owner-editable banner

Behaviour: **custom overrides, else auto.** When the owner enables the banner and
types a message, the site shows that message. When disabled or blank, the site falls
back to the existing auto `StockBanner`.

### Storage

New generic key/value table via a new migration (next number in sequence):

```
app_settings
  key         text  primary key
  value       jsonb not null
  updated_at  timestamptz not null default now()
  updated_by  uuid  null   (admin_user.id, nullable)
```

Generic so future editable site content (brand/contact rows currently read-only on
the Settings page) can reuse it. The banner is stored under key `site_banner`:

```json
{ "enabled": true, "message": "330ml is bulk preorder only…" }
```

Schema file: `packages/db/src/schema/app-setting.ts`, exported from the schema index.

### API

- `GET /v1/public/settings/banner` — public, unauthenticated. Returns
  `{ enabled: boolean, message: string }`. Defaults to `{ enabled: false, message: "" }`
  when the row is absent. Same public/cacheable treatment as the catalog reads.
- `PATCH /v1/settings/banner` — owner-only, gated by an existing owner-level
  capability (confirm the exact capability during planning — reuse whatever the
  owner-only settings actions use; do not invent a new one unless none fits).
  Body: `{ enabled: boolean, message: string }` (message trimmed, length-capped,
  e.g. ≤ 280 chars). Upserts the `site_banner` row, sets `updated_by`, and writes an
  audit-log entry consistent with other settings mutations.

New route file: `apps/api/src/routes/settings.ts` (or fold the public GET into the
existing public-catalog router if that is the established pattern — follow existing
conventions). Register in the app router.

### Admin UI

New card on the Settings page (`apps/admin/src/routes/owner/settings.tsx`),
"Homepage banner":

- "Show banner" checkbox (bound to `enabled`).
- Multi-line textarea for `message`, with a char counter / cap matching the API.
- Save button (dirty-tracked like the branch cards).
- Small live preview rendering the message in the brand-coloured bar so the owner
  sees the result before saving.
- Loads current config on mount via `GET`-equivalent admin read (or the public GET),
  saves via the `PATCH`.

### Customer wiring

- Add `fetchBanner` server-fn in `apps/customer/src/lib/api/server-fns.ts` calling
  `GET /v1/public/settings/banner`. Must fail soft — on error, return
  `{ enabled: false, message: "" }` so the homepage still renders (falls back to
  auto banner).
- Homepage loader (`apps/customer/src/routes/index.tsx`) fetches banner config
  alongside products/posts/plans.
- A thin decision wrapper for the `topBar`: if `enabled && message.trim()` render the
  custom message in the existing bar styling (dismissible, same brand bar as
  `StockBanner`); otherwise render the current `<StockBanner summary=… />`.
  Keep `StockBanner` unchanged; factor the shared bar markup if it reduces
  duplication, but do not regress the auto behaviour.

## Part 2 — Retired indicators on the admin Products page

In `apps/admin/src/routes/owner/products.tsx`, the card already renders
`p.variants` with `v.is_active`. Changes (admin-only, no API change):

- For each size where `is_active === false`: show a muted **"Retired"** pill next to
  the price and dim/de-emphasise that size row.
- When **every** variant of a flavour is retired (all `is_active === false`), show a
  card-level tag such as **"Not selling"** so it is obvious at a glance that the
  flavour is fully hidden from the storefront.
- Whole soft-deleted flavours (`deleted_at` set) never appear in the list, so no
  indicator is needed for them.

## Testing

- API: unit/integration test for `PATCH /v1/settings/banner` (auth gate, validation,
  upsert, audit) and `GET /v1/public/settings/banner` (default when absent, returns
  saved value).
- Customer: `StockBanner`/wrapper test — custom message shown when enabled+non-empty;
  auto banner shown when disabled or blank; fail-soft on fetch error.
- Admin/product-list logic: a small pure helper (or existing test style) covering the
  "all sizes retired" derivation if extracted; otherwise verify by the existing
  build/type checks (admin has no render tests).

## Out of scope

- Site-wide banner (only homepage for now).
- Making the read-only brand/contact/notification rows editable (the `app_settings`
  table just makes that easy later).
- Any change to the public catalog's existing retired/soft-delete filtering.
