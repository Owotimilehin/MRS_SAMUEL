# Admin Editorial Redesign — Implementation Plan (Sub-project 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Mrs. Samuel admin an "editorial & refined" feel (Linear/Vercel-grade polish on the existing green/cream brand) by redesigning the shared Shell + CSS kit, then composing the Owner-core pages bespoke on top.

**Architecture:** Evolve the existing custom-CSS-class system in `apps/admin/src/index.css` (Tailwind v3 + hand-rolled `.app-*`/`.card`/`.table`/`.stat-card`/`.pill` classes). Redesign those classes + add new editorial ones, swap emoji nav icons for `lucide-react` in `Shell.tsx`, then refine each Owner-core page's markup. Changes cascade because every page reuses these classes/components.

**Tech Stack:** React 18 + TanStack Router, Tailwind v3, custom CSS classes, `lucide-react` (new), TypeScript. No framer-motion (CSS-only motion).

**Spec:** `docs/superpowers/specs/2026-06-11-admin-editorial-redesign-design.md`

**Verification note:** Dev server is not run locally (docker-only per user). Each task is verified by `tsc --noEmit`, `eslint`, and `vite build` from `apps/admin`. Commands assume CWD `mrs-samuel/apps/admin`.

---

## Task 0: Add lucide-react dependency

**Files:**
- Modify: `apps/admin/package.json` (dependencies)

- [ ] **Step 1: Install lucide-react**

Run (from `mrs-samuel/apps/admin`):
```bash
pnpm add lucide-react
```
Expected: `package.json` gains `"lucide-react"` under dependencies; lockfile updates; no peer-dep errors.

- [ ] **Step 2: Verify it resolves**

Run:
```bash
node -e "require.resolve('lucide-react'); console.log('lucide-react OK')"
```
Expected: prints `lucide-react OK`.

- [ ] **Step 3: Commit**

```bash
git add package.json ../../pnpm-lock.yaml
git commit -m "build(admin): add lucide-react for editorial icons"
```

---

## Task 1: Editorial CSS kit — tokens, page header, KPI tile, cards

**Files:**
- Modify: `apps/admin/src/index.css`

This task ONLY edits CSS. No page should visually break because we keep every
existing class name and only refine its rules + add new ones.

- [ ] **Step 1: Add editorial motion + page-header + refined stat-card rules**

In `apps/admin/src/index.css`, immediately AFTER the `.t-sub { … }` rule (end of
the Typography block, ~line 124), insert:

```css
/* ─────────────────────────── Editorial primitives ─────────────────────────── */
@keyframes ed-rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.ed-rise { animation: ed-rise 360ms cubic-bezier(0.22, 1, 0.36, 1) both; }

/* Page header — eyebrow + serif title + subtitle + actions */
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}
.page-head__titles { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.page-head__eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.page-head__title {
  font-family: "Fraunces", "Cormorant Garamond", Georgia, serif;
  font-weight: 600;
  font-size: clamp(26px, 2.6vw, 34px);
  line-height: 1.08;
  letter-spacing: -0.025em;
  color: var(--brand);
  margin: 0;
}
.page-head__sub { font-size: 14px; color: var(--ink-soft); margin: 0; max-width: 60ch; }
.page-head__actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
```

- [ ] **Step 2: Refine the existing `.stat-card` block into an editorial KPI tile**

In `index.css`, REPLACE the existing `.stat-card`, `.stat-card__label`,
`.stat-card__value`, `.stat-card__hint` rules (the block currently at
~lines 190-215) with:

```css
.stat-card {
  position: relative;
  background: var(--shell);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
}
.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card);
  border-color: transparent;
}
.stat-card__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.stat-card__value {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
}
.stat-card__hint { font-size: 12.5px; color: var(--ink-soft); }
.stat-card__delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
}
.stat-card__delta--up { color: #047857; }
.stat-card__delta--down { color: var(--danger); }
```

- [ ] **Step 3: Refine `.card` for soft elevation + hover**

In `index.css`, REPLACE the existing `.card` and `.card--hoverable` rules
(~lines 171-188) with:

```css
.card {
  background: var(--shell);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 22px;
}
.card--soft { background: var(--surface-soft); border-color: transparent; }
.card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.card--hoverable { transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease; }
.card--hoverable:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card);
  border-color: transparent;
}
```

- [ ] **Step 4: Verify build is green**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: typecheck passes; `vite build` ends with `✓ built`. (CSS-only change — no TS impact.)

- [ ] **Step 5: Commit**

```bash
git add src/index.css
git commit -m "style(admin): editorial CSS primitives — page header, KPI tile, soft cards"
```

---

## Task 2: Editorial CSS kit — tables, filter toolbar, buttons, pills, empty states

**Files:**
- Modify: `apps/admin/src/index.css`

- [ ] **Step 1: Refine table rules for roomier editorial density**

In `index.css`, REPLACE the existing `.table-wrap`, `.table`, `.table thead th`,
`.table tbody td`, `.table tbody tr:last-child td`, `.table tbody tr:hover`,
`.table__num` rules (the Tables block, ~lines 289-319) with:

```css
.table-wrap {
  background: var(--shell);
  border: 1px solid var(--line);
  border-radius: 20px;
  overflow: hidden;
}
.table { width: 100%; border-collapse: collapse; font-size: 14px; }
.table thead th {
  position: sticky;
  top: 0;
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  padding: 13px 18px;
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
  z-index: 1;
}
.table tbody td { padding: 15px 18px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr { transition: background 120ms ease; }
.table tbody tr:hover { background: var(--surface-sunken); }
.table tbody tr.is-clickable { cursor: pointer; }
.table__num { text-align: right; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 2: Add filter-toolbar rules**

In `index.css`, immediately AFTER the `.table__num` rule, insert:

```css
/* Filter toolbar — search + selects + actions in one rounded bar */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--shell);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 10px 12px;
  margin-bottom: 16px;
}
.toolbar__search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 220px;
  min-width: 180px;
}
.toolbar__search svg {
  position: absolute;
  left: 12px;
  width: 16px;
  height: 16px;
  color: var(--ink-soft);
  pointer-events: none;
}
.toolbar__search .input { padding-left: 36px; }
.toolbar__spacer { flex: 1 1 auto; }
.toolbar .select { width: auto; min-width: 140px; }
```

- [ ] **Step 3: Refine buttons + add icon-button**

In `index.css`, REPLACE the existing `.btn--primary` and
`.btn--primary:hover:not(:disabled)` rules (~lines 144-149) with:

```css
.btn--primary {
  background: var(--grad);
  color: #fff;
  box-shadow: var(--shadow-cta);
}
.btn--primary:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); }
.btn--primary:active:not(:disabled) { transform: translateY(0); }
```

Then, immediately AFTER the `.btn--block` rule (~line 168), insert:

```css
.btn--icon {
  width: 38px;
  padding: 0;
  border-radius: 11px;
  background: var(--surface-soft);
  color: var(--ink);
}
.btn--icon:hover:not(:disabled) { background: #ECEEF1; }
.btn svg { width: 16px; height: 16px; }
```

- [ ] **Step 4: Refine empty-state for editorial tone**

In `index.css`, REPLACE the existing `.empty` and `.empty__title` rules
(~lines 461-469) with:

```css
.empty {
  padding: 48px 28px;
  text-align: center;
  color: var(--ink-soft);
  background: var(--shell);
  border: 1.5px dashed var(--line);
  border-radius: 20px;
}
.empty__icon {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  border-radius: 13px;
  background: var(--surface-soft);
  color: var(--accent);
}
.empty__icon svg { width: 22px; height: 22px; }
.empty__title { color: var(--ink); font-weight: 700; font-size: 16px; margin-bottom: 4px; }
```

- [ ] **Step 5: Verify build is green**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: typecheck passes; `✓ built`.

- [ ] **Step 6: Commit**

```bash
git add src/index.css
git commit -m "style(admin): editorial tables, filter toolbar, buttons, empty states"
```

---

## Task 3: Editorial CSS kit — Shell chrome (sidebar + top bar)

**Files:**
- Modify: `apps/admin/src/index.css`

- [ ] **Step 1: Refine sidebar nav active state with a left accent bar**

In `index.css`, REPLACE the existing `.app-nav__link`,
`.app-nav__link:hover`, `.app-nav__link.is-active`, `.app-nav__icon` rules
(~lines 397-414) with:

```css
.app-nav__link {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 12px 9px 14px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink-soft);
  transition: background 140ms ease, color 140ms ease;
}
.app-nav__link:hover { background: var(--surface-soft); color: var(--ink); }
.app-nav__link.is-active {
  background: rgba(27, 87, 51, 0.10);
  color: var(--accent);
  font-weight: 700;
}
.app-nav__link.is-active::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 3px;
  background: var(--accent);
}
.app-nav__icon { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; }
.app-nav__icon svg { width: 18px; height: 18px; }
```

- [ ] **Step 2: Restyle the top bar into an editorial header with breadcrumb support**

In `index.css`, REPLACE the existing `.app-head` and `.app-head__title` rules
(~lines 442-457) with:

```css
.app-head {
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--shell);
  border-bottom: 1px solid var(--line);
  padding: 14px 28px;
  position: sticky;
  top: 0;
  z-index: 5;
}
.app-head__titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.app-head__crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.app-head__title {
  font-family: "Fraunces", "Cormorant Garamond", Georgia, serif;
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.02em;
  color: var(--brand);
  line-height: 1.1;
}
.app-head__search {
  position: relative;
  display: flex;
  align-items: center;
  width: 240px;
  max-width: 38vw;
}
.app-head__search svg {
  position: absolute;
  left: 12px;
  width: 16px;
  height: 16px;
  color: var(--ink-soft);
  pointer-events: none;
}
.app-head__search .input { height: 38px; padding-left: 36px; border-radius: 11px; }
.app-head__user {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 12px 5px 6px;
  border-radius: 999px;
  background: var(--surface-soft);
}
.app-head__avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--grad);
  color: #fff;
  font-size: 12px;
  font-weight: 800;
}
.app-head__usermeta { display: flex; flex-direction: column; line-height: 1.1; }
.app-head__username { font-size: 12.5px; font-weight: 700; color: var(--ink); }
.app-head__userrole { font-size: 10.5px; color: var(--ink-soft); text-transform: capitalize; }
```

- [ ] **Step 3: Verify build is green**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: `✓ built`.

- [ ] **Step 4: Commit**

```bash
git add src/index.css
git commit -m "style(admin): editorial shell chrome — accent-bar nav, header with breadcrumb/search/user"
```

---

## Task 4: Rebuild Shell.tsx — lucide icons + editorial top bar

**Files:**
- Modify: `apps/admin/src/components/Shell.tsx`

- [ ] **Step 1: Replace Shell.tsx with the lucide + editorial-header version**

Replace the ENTIRE contents of `apps/admin/src/components/Shell.tsx` with:

```tsx
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Bell,
  ReceiptText,
  CupSoda,
  Store,
  Factory,
  Boxes,
  IdCard,
  Wallet,
  Tags,
  Milk,
  Map as MapIcon,
  User,
  ClipboardList,
  Undo2,
  Truck,
  Users,
  ScrollText,
  Smartphone,
  Settings,
  PenLine,
  ShoppingCart,
  Search,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { useAuthUser } from "../lib/auth.js";
import type { Capability } from "@ms/shared";

interface NavLink {
  to: string;
  label: string;
  Icon: LucideIcon;
  cap: Capability;
}

const NAV_OWNER: NavLink[] = [
  { to: "/owner/dashboard", label: "Dashboard", Icon: LayoutDashboard, cap: "reports.view" },
  { to: "/owner/review", label: "Needs review", Icon: Bell, cap: "orders.manage" },
  { to: "/owner/orders", label: "Orders", Icon: ReceiptText, cap: "orders.view" },
  { to: "/owner/products", label: "Products", Icon: CupSoda, cap: "products.manage" },
  { to: "/owner/branches", label: "Branches", Icon: Store, cap: "branches.manage" },
  { to: "/owner/factories", label: "Factories", Icon: Factory, cap: "branches.manage" },
  { to: "/owner/inventory", label: "Inventory", Icon: Boxes, cap: "reports.view" },
  { to: "/owner/adjustments", label: "Adjustments", Icon: IdCard, cap: "stock.read" },
  { to: "/owner/bookkeeping", label: "Bookkeeping", Icon: Wallet, cap: "expenses.view" },
  { to: "/owner/vendors", label: "Vendors", Icon: Tags, cap: "expenses.view" },
  { to: "/owner/packaging", label: "Packaging", Icon: Milk, cap: "packaging.view" },
  { to: "/owner/zones", label: "Delivery zones", Icon: MapIcon, cap: "zones.manage" },
  { to: "/owner/customers", label: "Customers", Icon: User, cap: "customers.view" },
  { to: "/owner/closes", label: "Daily closes", Icon: ClipboardList, cap: "close.approve" },
  { to: "/owner/returns", label: "Returns", Icon: Undo2, cap: "returns.approve" },
];
const NAV_OPS: NavLink[] = [
  { to: "/factory/production-runs", label: "Production runs", Icon: Factory, cap: "production.manage" },
  { to: "/factory/inventory", label: "Factory inventory", Icon: Boxes, cap: "stock.read" },
  { to: "/owner/transfers", label: "Transfers", Icon: Truck, cap: "transfers.create" },
];
const NAV_ADMIN: NavLink[] = [
  { to: "/owner/users", label: "Admin users", Icon: Users, cap: "users.manage" },
  { to: "/owner/audit-log", label: "Audit log", Icon: ScrollText, cap: "audit.view" },
  { to: "/owner/devices", label: "Devices", Icon: Smartphone, cap: "devices.view" },
  { to: "/owner/settings", label: "Settings", Icon: Settings, cap: "settings.manage" },
  { to: "/owner/blog", label: "Blog", Icon: PenLine, cap: "blog.manage" },
];

interface ShellProps {
  children: ReactNode;
  title: string;
  /** Optional breadcrumb area label shown above the title (e.g. "Owner"). */
  crumb?: string;
  actions?: ReactNode;
}

export function Shell({ children, title, crumb, actions }: ShellProps): JSX.Element {
  const user = useAuthUser();
  const can = (cap: Capability): boolean => user.capabilities.includes(cap);
  const initial = (user.email?.[0] ?? "?").toUpperCase();

  const renderSection = (heading: string, items: NavLink[]): JSX.Element | null => {
    const visible = items.filter((i) => can(i.cap));
    if (visible.length === 0) return null;
    return (
      <>
        <div className="app-nav__section">{heading}</div>
        {visible.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="app-nav__link"
            activeProps={{ className: "app-nav__link is-active" }}
          >
            <span className="app-nav__icon">
              <item.Icon strokeWidth={1.9} />
            </span>
            <span>{item.label}</span>
          </Link>
        ))}
      </>
    );
  };

  return (
    <div className="app-shell">
      <aside className="app-side">
        <div className="app-brand">
          <div className="app-brand__mark">
            <img src="/brand-logo.png" alt="Mrs. Samuel" />
          </div>
          <div>
            <div className="app-brand__name">Mrs. Samuel</div>
            <div className="app-brand__role">{user.role}</div>
          </div>
        </div>

        <nav className="app-nav">
          {renderSection("Owner", NAV_OWNER)}
          {renderSection("Operations", NAV_OPS)}
          {renderSection("Admin", NAV_ADMIN)}
          {can("pos.sell") ? (
            <>
              <div className="app-nav__section">Branch tools</div>
              <Link
                to="/branch/sell"
                className="app-nav__link"
                activeProps={{ className: "app-nav__link is-active" }}
              >
                <span className="app-nav__icon">
                  <ShoppingCart strokeWidth={1.9} />
                </span>
                <span>Branch POS</span>
              </Link>
            </>
          ) : null}
        </nav>

        <div className="app-foot">
          <div className="app-foot__email" title={user.email}>
            {user.email}
          </div>
          <button
            type="button"
            className="app-foot__signout"
            onClick={async () => {
              await fetch("/v1/auth/logout", { method: "POST", credentials: "include" });
              window.location.href = "/login";
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="app-main">
        <header className="app-head">
          <div className="app-head__titles">
            {crumb ? (
              <div className="app-head__crumb">
                <span>{crumb}</span>
                <ChevronRight size={12} strokeWidth={2.4} />
                <span>{title}</span>
              </div>
            ) : null}
            <div className="app-head__title">{title}</div>
          </div>
          <div style={{ flex: 1 }} />
          <label className="app-head__search">
            <Search />
            <input className="input" type="search" placeholder="Search…" aria-label="Search" />
          </label>
          {actions}
          <div className="app-head__user">
            <span className="app-head__avatar">{initial}</span>
            <span className="app-head__usermeta">
              <span className="app-head__username">{user.email?.split("@")[0]}</span>
              <span className="app-head__userrole">{user.role}</span>
            </span>
          </div>
        </header>
        <div className="app-body">{children}</div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck — confirm every lucide icon name resolves**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: passes. If an icon name errors (not exported by the installed
lucide-react), substitute the closest exported name (e.g. `Map` is imported
`as MapIcon`; if `Milk`/`CupSoda`/`IdCard` are missing in this version use
`GlassWater`/`Coffee`/`CreditCard` respectively) and re-run.

- [ ] **Step 3: Build**

Run:
```bash
pnpm exec vite build
```
Expected: `✓ built`.

- [ ] **Step 4: Commit**

```bash
git add src/components/Shell.tsx
git commit -m "feat(admin): editorial Shell — lucide icons, breadcrumb, search, user chip"
```

---

## Task 5: Stat component — delta + sparkline slot

**Files:**
- Modify: `apps/admin/src/components/Stat.tsx`

- [ ] **Step 1: Extend Stat with optional delta and children slot**

Replace the ENTIRE contents of `apps/admin/src/components/Stat.tsx` with:

```tsx
import type { ReactNode } from "react";

interface StatProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad" | "accent";
  /** Optional delta badge, e.g. "+12%". Positive renders green, negative red. */
  delta?: string;
  /** Optional slot below the value (e.g. a sparkline). */
  children?: ReactNode;
}

export function Stat({ label, value, hint, tone = "default", delta, children }: StatProps): JSX.Element {
  const labelColor =
    tone === "good"
      ? "var(--success)"
      : tone === "warn"
        ? "var(--warning)"
        : tone === "bad"
          ? "var(--danger)"
          : tone === "accent"
            ? "var(--accent)"
            : "var(--ink-soft)";
  const deltaDown = delta?.trim().startsWith("-");
  return (
    <div className="stat-card">
      <div className="stat-card__label" style={{ color: labelColor }}>
        {label}
      </div>
      <div className="stat-card__value">{value}</div>
      {delta && (
        <div className={`stat-card__delta ${deltaDown ? "stat-card__delta--down" : "stat-card__delta--up"}`}>
          {deltaDown ? "▼" : "▲"} {delta.replace(/^[-+]/, "")}
        </div>
      )}
      {children}
      {hint && <div className="stat-card__hint">{hint}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: passes; `✓ built`. (Props are additive — existing call sites still compile.)

- [ ] **Step 3: Commit**

```bash
git add src/components/Stat.tsx
git commit -m "feat(admin): Stat supports delta badge + sparkline slot"
```

---

## Task 6: Dashboard page — editorial header + KPI row + cards

**Files:**
- Modify: `apps/admin/src/routes/owner/dashboard.tsx`

- [ ] **Step 1: Add a page header and pass `crumb` to Shell**

In `dashboard.tsx`, change the `<Shell title="Dashboard" actions={…}>` opening tag
to add the crumb prop: `<Shell title="Dashboard" crumb="Owner" actions={…}>`.

Then, immediately inside the Shell (before the `{error && …}` block at ~line 143),
insert a page header:

```tsx
<div className="page-head ed-rise">
  <div className="page-head__titles">
    <div className="page-head__eyebrow">Overview</div>
    <h1 className="page-head__title">Store performance</h1>
    <p className="page-head__sub">
      Revenue, orders and items that need your attention across every branch.
    </p>
  </div>
</div>
```

- [ ] **Step 2: Use the KPI grid utility class instead of inline grid**

In `dashboard.tsx`, REPLACE the inline-styled KPI grid wrapper (the
`<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 24 }}>`
at ~lines 152-159) with:

```tsx
<div
  style={{
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 16,
    marginBottom: 26,
  }}
  className="ed-rise"
>
```

Leave the four `<Stat …/>` children exactly as they are.

- [ ] **Step 3: Convert the two section cards to use `.card__head`**

In `dashboard.tsx`, find the Branch-performance `<header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>`
and replace that opening tag with `<header className="card__head">` (remove the
inline style; keep its children). Do the same conversion conceptually for the Top
products heading: replace
`<h2 className="t-h2" style={{ marginBottom: 12 }}>Top products</h2>` with:

```tsx
<div className="card__head"><h2 className="t-h2">Top products</h2></div>
```

- [ ] **Step 4: Typecheck + build**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: passes; `✓ built`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/owner/dashboard.tsx
git commit -m "style(admin): editorial dashboard — page header, KPI grid, card heads"
```

---

## Task 7: Orders list page — editorial header + filter toolbar

**Files:**
- Modify: `apps/admin/src/routes/owner/orders.tsx`

- [ ] **Step 1: Read the page's current return block**

Run:
```bash
grep -n "return (" src/routes/owner/orders.tsx | head -1
```
Note the line; read from there to the closing `</Shell>` so you edit against the
real markup (filters + table live there).

- [ ] **Step 2: Add Search icon import**

At the top of `orders.tsx`, after the existing imports, add:
```tsx
import { Search } from "lucide-react";
```

- [ ] **Step 3: Add `crumb="Owner"` to the Shell and a page header**

Change the page's `<Shell title="Orders" …>` opening tag to include
`crumb="Owner"`. Immediately inside Shell, before the existing content, insert:

```tsx
<div className="page-head ed-rise">
  <div className="page-head__titles">
    <div className="page-head__eyebrow">Sales</div>
    <h1 className="page-head__title">Orders</h1>
    <p className="page-head__sub">Every order across branches and channels.</p>
  </div>
</div>
```

- [ ] **Step 4: Wrap the existing filter controls in a `.toolbar`**

Locate the filter controls (the branch/status/channel `<select>`s and the search
`<input value={q} …>`). Wrap them in a toolbar and move search into
`.toolbar__search`. Replace the existing filter container with:

```tsx
<div className="toolbar ed-rise">
  <span className="toolbar__search">
    <Search />
    <input
      className="input"
      type="search"
      placeholder="Search order #…"
      value={q}
      onChange={(e) => setQ(e.target.value)}
    />
  </span>
  <span className="toolbar__spacer" />
  <select className="select" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
    <option value="all">All branches</option>
    {branches.map((b) => (
      <option key={b.id} value={b.id}>{b.name}</option>
    ))}
  </select>
  <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
    <option value="all">All statuses</option>
    <option value="paid">Paid</option>
    <option value="confirmed">Pending pay</option>
    <option value="handed_over">Handed over</option>
    <option value="delivered">Delivered</option>
    <option value="cancelled">Cancelled</option>
    <option value="failed">Failed</option>
  </select>
  <select className="select" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
    <option value="all">All channels</option>
    <option value="pos">POS</option>
    <option value="online">Online</option>
  </select>
</div>
```

NOTE: keep whatever channel/status option values the existing code already used —
if they differ from the above, preserve the originals (do not invent new filter
values). Only the wrapping/class structure changes.

- [ ] **Step 5: Make table rows clickable-styled**

If the table renders rows that link to `order-detail`, add `className="is-clickable"`
to each `<tr>` (keep the existing onClick/Link behavior unchanged).

- [ ] **Step 6: Typecheck + build**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: passes; `✓ built`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/owner/orders.tsx
git commit -m "style(admin): editorial orders list — header + filter toolbar"
```

---

## Task 8: Order detail page — editorial detail layout

**Files:**
- Modify: `apps/admin/src/routes/owner/order-detail.tsx`

- [ ] **Step 1: Read the current page**

Run:
```bash
sed -n '1,40p' src/routes/owner/order-detail.tsx
grep -n "<Shell" src/routes/owner/order-detail.tsx
```
Read the full return block so edits match real markup.

- [ ] **Step 2: Add crumb + back link + page header**

Add `crumb="Owner"` to the `<Shell>` opening tag. Immediately inside Shell, insert
a back link + header (adapt the dynamic order number variable name to whatever the
file already uses — e.g. `sale.orderNumber`):

```tsx
<div className="page-head ed-rise">
  <div className="page-head__titles">
    <Link to="/owner/orders" className="page-head__eyebrow" style={{ color: "var(--accent)" }}>
      ← Back to orders
    </Link>
    <h1 className="page-head__title">Order details</h1>
  </div>
</div>
```

If `Link` is not already imported from `@tanstack/react-router` in this file, add
it to the existing import.

- [ ] **Step 3: Wrap primary + meta content in a 2-column editorial grid**

Wrap the existing detail content so the primary panel and side meta sit in two
columns. Replace the outermost content container of the detail body with:

```tsx
<div
  className="ed-rise"
  style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18, alignItems: "start" }}
>
  {/* left: primary panels (existing line items / payment etc.) */}
  {/* right: existing meta/status/actions, each in a .card */}
</div>
```
Place the existing primary panels (line items, totals) in the left column and the
existing status/meta/action panels in the right column, each as a `.card`. Keep
all existing data bindings and handlers unchanged.

- [ ] **Step 4: Typecheck + build**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: passes; `✓ built`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/owner/order-detail.tsx
git commit -m "style(admin): editorial order detail — back link, header, 2-col layout"
```

---

## Task 9: Products list + detail

**Files:**
- Modify: `apps/admin/src/routes/owner/products.tsx`
- Modify: `apps/admin/src/routes/owner/product-detail.tsx`

- [ ] **Step 1: Read both files' return blocks**

Run:
```bash
grep -n "<Shell" src/routes/owner/products.tsx src/routes/owner/product-detail.tsx
```
Read each return block before editing.

- [ ] **Step 2: Products list — header + toolbar**

Add `crumb="Owner"` to `<Shell>`. Insert a page header inside Shell:

```tsx
<div className="page-head ed-rise">
  <div className="page-head__titles">
    <div className="page-head__eyebrow">Catalogue</div>
    <h1 className="page-head__title">Products</h1>
    <p className="page-head__sub">Flavours, sizes and pricing.</p>
  </div>
  <div className="page-head__actions">{/* move any existing "New product" button here */}</div>
</div>
```
If the page has a search input, wrap it in a `.toolbar` + `.toolbar__search` like
Task 7 Step 4 (import `Search` from lucide-react). If it has no filters, skip the
toolbar.

- [ ] **Step 3: Product detail/editor — back link + header + sectioned form**

Add `crumb="Owner"` to `<Shell>`. Insert a back link + header (Task 8 Step 2 shape,
pointing to `/owner/products`, title "Product"). Group the existing form controls
under `.card` sections; do not change any field names, state, or submit handlers.
If the page has a save button, leave its handler intact.

- [ ] **Step 4: Typecheck + build**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: passes; `✓ built`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/owner/products.tsx src/routes/owner/product-detail.tsx
git commit -m "style(admin): editorial products list + detail"
```

---

## Task 10: Inventory list

**Files:**
- Modify: `apps/admin/src/routes/owner/inventory.tsx`

- [ ] **Step 1: Read the return block**

Run:
```bash
grep -n "<Shell" src/routes/owner/inventory.tsx
```
Read from there to `</Shell>`.

- [ ] **Step 2: Add crumb + header; wrap filters in toolbar**

Add `crumb="Owner"` to `<Shell>`. Insert page header:

```tsx
<div className="page-head ed-rise">
  <div className="page-head__titles">
    <div className="page-head__eyebrow">Stock</div>
    <h1 className="page-head__title">Inventory</h1>
    <p className="page-head__sub">On-hand stock across branches and the factory.</p>
  </div>
</div>
```
If the page has branch/search filters, wrap them in `.toolbar` (Task 7 Step 4
pattern). Keep the existing table; ensure it sits in a `.table-wrap`.

- [ ] **Step 3: Typecheck + build**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: passes; `✓ built`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/owner/inventory.tsx
git commit -m "style(admin): editorial inventory list"
```

---

## Task 11: Customers list + detail

**Files:**
- Modify: `apps/admin/src/routes/owner/customers.tsx`
- Modify: `apps/admin/src/routes/owner/customer-detail.tsx`

- [ ] **Step 1: Read both files' return blocks**

Run:
```bash
grep -n "<Shell" src/routes/owner/customers.tsx src/routes/owner/customer-detail.tsx
```
Read each return block before editing.

- [ ] **Step 2: Customers list — header + toolbar**

Add `crumb="Owner"` to `<Shell>`. Insert page header:

```tsx
<div className="page-head ed-rise">
  <div className="page-head__titles">
    <div className="page-head__eyebrow">People</div>
    <h1 className="page-head__title">Customers</h1>
    <p className="page-head__sub">Everyone who has ordered from Mrs. Samuel.</p>
  </div>
</div>
```
Wrap any existing search/filter controls in a `.toolbar` (import `Search`). Add
`is-clickable` to customer rows if they navigate to detail.

- [ ] **Step 3: Customer detail — profile header + 2-col**

Add `crumb="Owner"` to `<Shell>`. Insert a back link + header (Task 8 Step 2 shape,
pointing to `/owner/customers`, title from the customer's name variable if present
else "Customer"). Lay the existing profile/contact panel and order-history panel in
a 2-col grid (Task 8 Step 3 pattern), each as a `.card`. Keep all data/handlers.

- [ ] **Step 4: Typecheck + build**

Run:
```bash
pnpm exec tsc --noEmit && pnpm exec vite build
```
Expected: passes; `✓ built`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/owner/customers.tsx src/routes/owner/customer-detail.tsx
git commit -m "style(admin): editorial customers list + detail"
```

---

## Task 12: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + lint + build**

Run (from `mrs-samuel/apps/admin`):
```bash
pnpm exec tsc --noEmit && pnpm exec eslint src && pnpm exec vite build
```
Expected: typecheck clean, eslint clean, `✓ built`.

- [ ] **Step 2: Confirm no emoji remain in Shell and no off-brand colors were added**

Run:
```bash
grep -nE "📊|🔔|🧾|🥤|🏪|🏭|📦|🪪|💰|🏷|🧴|🗺|👤|📋|↩|🚚|👥|📜|📱|⚙|✍|🛒" src/components/Shell.tsx || echo "no emoji in Shell — OK"
grep -rniE "purple|indigo|violet|#6366|#2563eb|bg-blue-[56]00" src/routes/owner src/components || echo "no off-brand colors — OK"
```
Expected: both print their OK fallback.

- [ ] **Step 3: Commit any final touch-ups (if eslint auto-fixed formatting)**

```bash
git add -A
git commit -m "chore(admin): editorial redesign verification pass" --allow-empty
```

---

## Notes for the implementer

- **Preserve behavior.** This is visual/structural only. Never change API calls,
  state names, filter option *values*, or submit handlers. If real markup differs
  from a snippet here, adapt the wrapper/classes around the existing logic rather
  than rewriting the logic.
- **Package manager is pnpm** (workspace). Run commands from `mrs-samuel/apps/admin`.
- **Reduced motion** is already globally handled by the `@media (prefers-reduced-motion)`
  block at the end of `index.css` — the `.ed-rise` animation and hover transforms
  are covered by it.
- **No dev server** — verify via tsc/eslint/vite build only (docker-only per user).
- After this sub-project, areas 2–4 (Branch POS, Owner admin/config, Factory) reuse
  this same kit in their own plans.
```
