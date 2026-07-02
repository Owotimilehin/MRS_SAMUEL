# Editable Homepage Banner + Retired Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner post a custom homepage banner from Settings (falling back to the auto stock banner when blank), and show "Retired" indicators for retired sizes on the admin Products page.

**Architecture:** A new generic `app_settings` key/value table stores the banner under key `site_banner`. A public API returns it for the storefront; an owner/admin-gated API writes it. The customer homepage picks the custom message when enabled+non-empty, else renders the existing auto `StockBanner`. The admin Products page reads the already-present `variant.is_active` to render badges — no API change.

**Tech Stack:** Drizzle ORM + Postgres (packages/db), Hono API (apps/api), TanStack Start React (apps/customer), React admin SPA (apps/admin), Zod validation, Vitest/node test.

## Global Constraints

- Migrations are sequential; next number is **0065**. Add BOTH the `.sql` file and a `meta/_journal.json` entry, or Drizzle silently skips it. New journal entry: `{ "idx": 64, "version": "7", "when": 1783310000000, "tag": "0065_app_settings", "breakpoints": true }` (idx and `when` strictly increase from the last entry `0064` / `1783280000000`).
- API routes are registered in `apps/api/src/test-app.ts` (the single app builder — production reuses it). Mount new routers there.
- Money/text copy: banner message is trimmed and capped at **280 chars**.
- Capability for writes: reuse the existing **`settings.manage`** capability (owner + admin hold it). Do NOT invent a new capability.
- Audit every write with `writeAudit(db, c, { action, entityType, entityId, before, after })` from `apps/api/src/middleware/audit.js`.
- Admin app has no render tests; verify admin UI tasks with `pnpm --filter @ms/admin exec tsc --noEmit` + build.
- Customer tests run under node (no jsdom) — keep testable logic in pure functions.

---

### Task 1: `app_settings` table, schema, migration

**Files:**
- Create: `packages/db/src/schema/app-setting.ts`
- Modify: `packages/db/src/schema/index.ts` (add re-export)
- Create: `packages/db/migrations/0065_app_settings.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append entry)

**Interfaces:**
- Produces: `appSetting` Drizzle table with columns `key` (text PK), `value` (jsonb), `updatedAt` (timestamptz), `updatedBy` (uuid, nullable). Banner row uses key `"site_banner"` with value shape `{ enabled: boolean; message: string }`.

- [ ] **Step 1: Create the schema file**

```ts
// packages/db/src/schema/app-setting.ts
import { pgTable, text, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";

/**
 * Generic key/value store for owner-editable site settings (starting with the
 * homepage banner). One row per setting `key`; `value` is the setting's JSON.
 */
export const appSetting = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => adminUser.id),
});

/** JSON shape stored under the `site_banner` key. */
export interface SiteBannerValue {
  enabled: boolean;
  message: string;
}

export const SITE_BANNER_KEY = "site_banner";
```

- [ ] **Step 2: Re-export from the schema index**

Add to `packages/db/src/schema/index.ts` after the last line (`export * from "./variance-loss.js";`):

```ts
export * from "./app-setting.js";
```

- [ ] **Step 3: Write the migration SQL**

```sql
-- packages/db/migrations/0065_app_settings.sql
CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid
);
```

- [ ] **Step 4: Append the journal entry**

In `packages/db/migrations/meta/_journal.json`, add after the `0064` entry (inside the `entries` array):

```json
    ,{ "idx": 64, "version": "7", "when": 1783310000000, "tag": "0065_app_settings", "breakpoints": true }
```

- [ ] **Step 5: Build the db package to verify it compiles**

Run: `pnpm --filter @ms/db build`
Expected: builds with no TypeScript errors (regenerates dist so downstream `@ms/db` imports see `appSetting`).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/app-setting.ts packages/db/src/schema/index.ts packages/db/migrations/0065_app_settings.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): app_settings key/value table + site_banner (0065)"
```

---

### Task 2: Settings API — public read + owner write

**Files:**
- Create: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/test-app.ts` (import + mount two routes)
- Create: `apps/api/test/integration/settings-banner.test.ts`

**Interfaces:**
- Consumes: `appSetting`, `SITE_BANNER_KEY`, `SiteBannerValue` from `@ms/db`; `requireAuth`, `requireCapability` from `../middleware/auth.js`; `writeAudit` from `../middleware/audit.js`.
- Produces:
  - `GET /v1/public/settings/banner` → `{ enabled: boolean, message: string }` (defaults `{ enabled: false, message: "" }` when the row is absent).
  - `GET /v1/settings/banner` (auth) → same shape (for the admin editor to load current value).
  - `PATCH /v1/settings/banner` (`settings.manage`) body `{ enabled: boolean, message: string }` → `{ enabled, message }`. Message trimmed, capped 280 chars.
  - Exported factory functions `settingsRoutes(db)` and `publicSettingsRoutes(db)`.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/settings-banner.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { authHeaderFor } from "../helpers/auth.js";

describe("settings banner", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    app = await createTestApp();
  });

  it("returns a disabled default when unset", async () => {
    const res = await app.request("/v1/public/settings/banner");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, message: "" });
  });

  it("owner can set the banner and the public route returns it", async () => {
    const owner = await authHeaderFor(app, "owner");
    const patch = await app.request("/v1/settings/banner", {
      method: "PATCH",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, message: "  330ml is bulk preorder only  " }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ enabled: true, message: "330ml is bulk preorder only" });

    const pub = await app.request("/v1/public/settings/banner");
    expect(await pub.json()).toEqual({ enabled: true, message: "330ml is bulk preorder only" });
  });

  it("rejects an unauthenticated write", async () => {
    const res = await app.request("/v1/settings/banner", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, message: "x" }),
    });
    expect(res.status).toBe(401);
  });
});
```

> NOTE: match the exact test-helper names/paths already used by other files in `apps/api/test/integration/` (e.g. how `capabilities.test.ts` builds the app and forges an owner token). If the helpers differ, adapt these two lines only — the assertions stay.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @ms/api exec vitest run test/integration/settings-banner.test.ts`
Expected: FAIL (routes 404 — not mounted yet).

- [ ] **Step 3: Implement the routes**

```ts
// apps/api/src/routes/settings.ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appSetting, SITE_BANNER_KEY, type DbClient, type SiteBannerValue } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";

const BannerBody = z.object({
  enabled: z.boolean(),
  message: z.string().max(280),
});

const DEFAULT_BANNER: SiteBannerValue = { enabled: false, message: "" };

async function readBanner(db: DbClient): Promise<SiteBannerValue> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, SITE_BANNER_KEY));
  if (!row) return DEFAULT_BANNER;
  const v = row.value as Partial<SiteBannerValue>;
  return { enabled: Boolean(v.enabled), message: typeof v.message === "string" ? v.message : "" };
}

/** Owner/admin: read + write the banner. Mounted at /v1/settings. */
export function settingsRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/banner", async (c) => c.json(await readBanner(db)));

  r.patch("/banner", requireCapability("settings.manage"), async (c) => {
    const body = BannerBody.parse(await c.req.json());
    const value: SiteBannerValue = { enabled: body.enabled, message: body.message.trim() };
    const auth = c.get("auth");

    const before = await readBanner(db);
    await db
      .insert(appSetting)
      .values({ key: SITE_BANNER_KEY, value, updatedBy: auth.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSetting.key,
        set: { value, updatedBy: auth.userId, updatedAt: new Date() },
      });

    await writeAudit(db, c, {
      action: "settings.banner.update",
      entityType: "app_setting",
      entityId: SITE_BANNER_KEY,
      before,
      after: value,
    });
    return c.json(value);
  });

  return r;
}

/** Public: read-only banner for the storefront. Mounted at /v1/public/settings. */
export function publicSettingsRoutes(db: DbClient) {
  const r = new Hono();
  r.get("/banner", async (c) => c.json(await readBanner(db)));
  return r;
}
```

- [ ] **Step 4: Mount both routers**

In `apps/api/src/test-app.ts`, add the import near the other route imports:

```ts
import { settingsRoutes, publicSettingsRoutes } from "./routes/settings.js";
```

Add the authenticated mount next to the other `/v1/...` admin routes (e.g. after the `app.route("/v1/branches", branchRoutes(db));` line):

```ts
  app.route("/v1/settings", settingsRoutes(db));
```

Add the public mount next to the other `/v1/public/...` routes (e.g. after `app.route("/v1/public/subscriptions", publicSubscriptionRoutes(db));`):

```ts
  app.route("/v1/public/settings", publicSettingsRoutes(db));
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @ms/api exec vitest run test/integration/settings-banner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck the API**

Run: `pnpm --filter @ms/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/test-app.ts apps/api/test/integration/settings-banner.test.ts
git commit -m "feat(api): settings banner read/write endpoints (settings.manage)"
```

---

### Task 3: Customer — fetch banner + pick custom-vs-auto on the homepage

**Files:**
- Modify: `apps/customer/src/lib/api/server-fns.ts` (add `fetchBanner`)
- Create: `apps/customer/src/lib/banner.ts` (pure pick helper + type)
- Create: `apps/customer/src/lib/banner.test.ts`
- Create: `apps/customer/src/components/TopBanner.tsx` (custom-message bar, reusing StockBanner styling)
- Modify: `apps/customer/src/routes/index.tsx` (fetch + render decision)

**Interfaces:**
- Consumes: `apiFetch` from `./client`; `StockBanner` + `deriveStockSummary` from existing components; `StockSummary` type.
- Produces:
  - `interface BannerConfig { enabled: boolean; message: string }`
  - `pickCustomBannerMessage(config: BannerConfig): string | null` — returns the trimmed message when `enabled` and non-empty, else `null`.
  - `fetchBanner()` server-fn → `BannerConfig` (fails soft to `{ enabled: false, message: "" }`).
  - `<TopBanner message={string} />` — the dismissible custom bar.

- [ ] **Step 1: Write the failing pure-helper test**

```ts
// apps/customer/src/lib/banner.test.ts
import { describe, it, expect } from "vitest";
import { pickCustomBannerMessage } from "./banner";

describe("pickCustomBannerMessage", () => {
  it("returns the trimmed message when enabled and non-empty", () => {
    expect(pickCustomBannerMessage({ enabled: true, message: "  hi  " })).toBe("hi");
  });
  it("returns null when disabled", () => {
    expect(pickCustomBannerMessage({ enabled: false, message: "hi" })).toBeNull();
  });
  it("returns null when message is blank", () => {
    expect(pickCustomBannerMessage({ enabled: true, message: "   " })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @ms/customer exec vitest run src/lib/banner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the pure helper**

```ts
// apps/customer/src/lib/banner.ts
export interface BannerConfig {
  enabled: boolean;
  message: string;
}

/** Custom banner wins when enabled and non-blank; otherwise null → fall back to auto. */
export function pickCustomBannerMessage(config: BannerConfig): string | null {
  if (!config.enabled) return null;
  const trimmed = config.message.trim();
  return trimmed.length > 0 ? trimmed : null;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @ms/customer exec vitest run src/lib/banner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the fail-soft server-fn**

In `apps/customer/src/lib/api/server-fns.ts`, add the import at the top:

```ts
import type { BannerConfig } from "@/lib/banner";
```

Add near the other catalog server-fns:

```ts
export const fetchBanner = createServerFn({ method: "GET" }).handler(async (): Promise<BannerConfig> => {
  try {
    const cfg = await apiFetch<BannerConfig>("/v1/public/settings/banner");
    return { enabled: Boolean(cfg.enabled), message: typeof cfg.message === "string" ? cfg.message : "" };
  } catch {
    // Banner is decorative — never block the homepage on it.
    return { enabled: false, message: "" };
  }
});
```

- [ ] **Step 6: Create the custom-message bar**

```tsx
// apps/customer/src/components/TopBanner.tsx
import { useState } from "react";

/**
 * The owner's custom homepage banner. Same brand bar as StockBanner, but the
 * text is owner-authored. Supports simple multi-line messages.
 */
export function TopBanner({ message }: { message: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      className="relative z-20 bg-[color:var(--brand)] text-white text-[13px] font-medium text-center px-10 py-2.5 leading-snug whitespace-pre-line"
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss banner"
        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100 transition-opacity"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Wire the homepage to fetch + decide**

In `apps/customer/src/routes/index.tsx`:

Add imports:

```ts
import { fetchProducts, fetchBlogPosts, fetchSubscriptionPlans, fetchBanner } from "@/lib/api/server-fns";
import { TopBanner } from "@/components/TopBanner";
import { pickCustomBannerMessage } from "@/lib/banner";
```

Replace the loader body so it also fetches the banner:

```ts
  loader: async () => {
    const [products, posts, plans, banner] = await Promise.all([
      fetchProducts(),
      fetchBlogPosts(),
      fetchSubscriptionPlans(),
      fetchBanner(),
    ]);
    return { products, posts, plans, banner };
  },
```

In `Page()`, read `banner` and choose the bar:

```ts
  const { products, posts, plans, banner } = Route.useLoaderData();
```

...and compute the top bar just before the return:

```ts
  const customMessage = pickCustomBannerMessage(banner);
  const topBar = customMessage
    ? <TopBanner message={customMessage} />
    : <StockBanner summary={stockSummary} />;
```

Then change the `SiteShell` opening tag to use it:

```tsx
    <SiteShell topBar={topBar}>
```

- [ ] **Step 8: Typecheck + build the customer app**

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/customer/src/lib/banner.ts apps/customer/src/lib/banner.test.ts apps/customer/src/lib/api/server-fns.ts apps/customer/src/components/TopBanner.tsx apps/customer/src/routes/index.tsx
git commit -m "feat(customer): owner-editable homepage banner overrides auto stock banner"
```

---

### Task 4: Admin Settings page — "Homepage banner" card

**Files:**
- Modify: `apps/admin/src/routes/owner/settings.tsx` (add a `BannerCard` component + render it)

**Interfaces:**
- Consumes: `api` + `humanizeError` from `../../lib/api.js`; `GET /v1/settings/banner`; `PATCH /v1/settings/banner`.
- Produces: a `BannerCard` section rendered alongside the other Settings cards.

- [ ] **Step 1: Add the BannerCard component**

Add this component in `apps/admin/src/routes/owner/settings.tsx` (near `ReceiptStyleCard`):

```tsx
function BannerCard(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await api<{ enabled: boolean; message: string }>("/settings/banner");
        if (alive) {
          setEnabled(Boolean(cfg.enabled));
          setMessage(cfg.message ?? "");
        }
      } catch {
        /* leave defaults */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setMsg(null);
    try {
      await api("/settings/banner", {
        method: "PATCH",
        body: JSON.stringify({ enabled, message }),
      });
      setMsg({ ok: true, text: "Saved." });
      window.setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setMsg({ ok: false, text: humanizeError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="t-h2" style={{ marginBottom: 4 }}>
        Homepage banner
      </h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 14 }}>
        A message across the top of the homepage. When off (or empty), the site shows the
        automatic in-stock / preorder banner instead.
      </p>
      {loading ? (
        <InlineLoader />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            Show banner
          </label>
          <label className="field">
            <span className="field__label">Message</span>
            <textarea
              className="input"
              rows={3}
              maxLength={280}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="330ml is for bulk preorder only. 650ml still available for same-day delivery."
            />
            <span style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>
              {message.length}/280
            </span>
          </label>
          {enabled && message.trim() && (
            <div>
              <div style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 }}>Preview</div>
              <div
                style={{
                  background: "var(--brand, #0b3d2e)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 500,
                  textAlign: "center",
                  padding: "10px 14px",
                  borderRadius: 8,
                  whiteSpace: "pre-line",
                }}
              >
                {message}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={saving}
              onClick={() => void save()}
              style={{ alignSelf: "flex-start" }}
            >
              {saving ? "Saving…" : "Save banner"}
            </button>
            {msg && (
              <span
                role="status"
                style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--danger)" }}
              >
                {msg.text}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Render the card**

In the settings page JSX, add `<BannerCard />` immediately after `<ReceiptStyleCard />`:

```tsx
          <ReceiptStyleCard />
          <BannerCard />
```

- [ ] **Step 3: Typecheck the admin app**

Run: `pnpm --filter @ms/admin exec tsc --noEmit`
Expected: no errors (`useEffect`, `useState`, `InlineLoader`, `api`, `humanizeError` are all already imported in this file).

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/owner/settings.tsx
git commit -m "feat(admin): edit the homepage banner from Settings"
```

---

### Task 5: Retired-size indicators on the admin Products page

**Files:**
- Modify: `apps/admin/src/routes/owner/products.tsx` (badge retired sizes + card-level "Not selling")

**Interfaces:**
- Consumes: existing `ProductRow.variants[].is_active` (already loaded via `GET /products/:id`).
- Produces: visual-only changes; no new exports.

- [ ] **Step 1: Badge each retired size + dim its row**

In `apps/admin/src/routes/owner/products.tsx`, replace the size-row block (the `p.variants.map((v) => (...))` inside `flav-card__sizes`) with a version that reflects `v.is_active`:

```tsx
                  {p.variants && p.variants.length > 0 ? (
                    <div className="flav-card__sizes">
                      {p.variants.map((v) => (
                        <div
                          key={v.id}
                          className="flav-size"
                          style={v.is_active ? undefined : { opacity: 0.55 }}
                        >
                          <span className="flav-size__ml">{v.size_ml} ml</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {!v.is_active && (
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.04em",
                                  color: "var(--ink-soft)",
                                  background: "var(--line)",
                                  borderRadius: 999,
                                  padding: "2px 7px",
                                }}
                              >
                                Retired
                              </span>
                            )}
                            {v.current_price_ngn != null ? (
                              <span className="flav-size__pr">{ngn(v.current_price_ngn)}</span>
                            ) : (
                              <span className="flav-size__pr--none">no price — set it</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flav-card__sizes">
                      <span className="flav-size__pr--none">No cans yet</span>
                    </div>
                  )}
```

- [ ] **Step 2: Add the card-level "Not selling" tag when every size is retired**

In the same `rows.map((p) => { ... })` block, compute the flag right after `const accent = ...`:

```tsx
            const accent = getFlavourVisual({ slug: p.slug }).accent;
            const allRetired =
              !!p.variants && p.variants.length > 0 && p.variants.every((v) => !v.is_active);
```

Then, next to the category tag (`<span className="flav-tag flav-card__cat" ...>{p.category}</span>`), add a sibling shown only when `allRetired`:

```tsx
                {allRetired && (
                  <span
                    className="flav-tag flav-card__cat"
                    style={{
                      ["--fl-accent" as string]: "var(--ink-soft)",
                      right: "auto",
                      left: 12,
                    } as CSSProperties}
                  >
                    Not selling
                  </span>
                )}
```

> NOTE: `flav-card__cat` is absolutely positioned (top-right) via CSS. The `left`/`right` overrides place the "Not selling" tag on the opposite corner so the two tags don't overlap. If the existing CSS already pins `right`, keep the `right: "auto"` override. Verify visually; adjust the corner if they collide.

- [ ] **Step 3: Typecheck the admin app**

Run: `pnpm --filter @ms/admin exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/owner/products.tsx
git commit -m "feat(admin): mark retired sizes and fully-retired flavours on Products"
```

---

## Final verification

- [ ] Run the full API integration test file added here plus a broad build:
  - `pnpm --filter @ms/api exec vitest run test/integration/settings-banner.test.ts`
  - `pnpm --filter @ms/customer exec vitest run src/lib/banner.test.ts`
  - `pnpm --filter @ms/db build && pnpm --filter @ms/api exec tsc --noEmit && pnpm --filter @ms/admin exec tsc --noEmit && pnpm --filter @ms/customer exec tsc --noEmit`
- [ ] Manual smoke (post-deploy / local): Settings → toggle banner on, enter "330ml is for bulk preorder only. 650ml still available." → Save → homepage shows the message; clear it / toggle off → auto stock banner returns. Products page shows "Retired" on any retired size.

## Notes / gotchas

- Migration journal timestamp must exceed the previous entry, or Drizzle silently skips the migration (a known incident in this repo). Double-check `when: 1783310000000 > 1783280000000`.
- After editing `packages/db` schema, rebuild `@ms/db` (`pnpm --filter @ms/db build`) before typechecking API/admin — stale dist causes phantom `appSetting`-not-found tsc errors.
- The public catalog already filters `is_active` / `deleted_at`, so retired sizes are hidden from customers with no change here. This feature only makes retirement visible to the owner.
