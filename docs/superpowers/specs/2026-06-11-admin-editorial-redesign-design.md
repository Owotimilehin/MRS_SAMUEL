# Admin Editorial Redesign — Design Spec

**Date:** 2026-06-11
**Status:** Approved (design); pending implementation plan
**Scope of this spec:** Sub-project 1 — Foundation (Shell + editorial kit) + Owner-core pages

---

## 1. Goal & context

The admin app (`apps/admin`, ~14k LOC, 44 routes) is already on the customer
green/cream design tokens, but its **structure and mood are generic SaaS**: a
fixed 248px sidebar with **emoji** nav icons, a sticky top bar, and data-dense
CRUD pages built from custom CSS classes (`.app-*`, `.card`, `.table`,
`.stat-card`, `.pill`). It does not carry the **editorial, premium feel** of the
storefront.

The user wants every page redesigned ("page-by-page, all 44 bespoke") with a new
**Editorial & Refined** feel — Linear/Vercel-grade polish that reads like an
extension of the storefront. Because 44 bespoke pages is multi-session work, the
effort is **decomposed into sub-projects**, each its own spec → plan →
implementation cycle, all sharing one editorial design language so "bespoke"
never drifts into "inconsistent."

### Decomposition (whole effort)
1. **Foundation + Owner core** ← *this spec*
2. Branch POS & ops (sell, sales, stock, closes, returns, queue, device)
3. Owner admin & config (settings, users, audit-log, devices, blog, zones, vendors, packaging, bookkeeping)
4. Factory & transfers (production-runs, run-detail, factory inventory, transfers)

---

## 2. Chosen direction & approach

- **Feel:** Editorial & refined. Stay on green/cream brand tokens. Add an *airy*
  rhythm (whitespace, hairline borders, soft elevation), **Fraunces serif page
  titles**, uppercase tracked eyebrows, tabular numerics, and quiet CSS-only
  micro-motion.
- **Technical approach (chosen): evolve the existing CSS-class system.** Redesign
  the shared classes in `apps/admin/src/index.css` to the editorial spec and add
  new ones; swap emoji→lucide in `Shell`; refine each Owner-core page's markup
  bespoke on top. Respects the current Tailwind-v3 + custom-class architecture,
  cascades to all pages, lowest risk. (Rejected: full Tailwind-utility rewrite —
  14k-LOC churn; shadcn component library — big upfront cost.)

### Decisions on open questions
- **Icons:** add `lucide-react`; replace all emoji nav/section icons.
- **Motion:** CSS-only (no framer-motion) — hover lifts, card fade-in, 140–180ms
  transitions; honor existing `prefers-reduced-motion` block.
- **Global search:** top-bar search **field** now (entry point; client-side
  filter where applicable). ⌘K command palette deferred to a later cycle.
- **Sidebar:** full sidebar with a **left active-accent bar**; responsive
  icon-rail collapse **deferred** (note for a later cycle).

---

## 3. Design language

| Aspect | Spec |
|---|---|
| Color | Existing tokens: `--brand` green primary, `--brand-orange`/`--accent-2` secondary, cream surfaces. No new hues. |
| Page titles | Fraunces serif (`.font-display`), tight tracking. |
| Labels/eyebrows | Uppercase, 0.14em tracking, `--ink-soft`. |
| Numerics | Tabular (`font-variant-numeric: tabular-nums`). |
| Elevation | Soft, layered: `--shadow-card` resting, deeper on hover; hairline `--line` borders. |
| Radius | Cards 18–22px, inputs 12px, pills 999px. |
| Motion | CSS-only: hover translateY(-2px) + shadow, card fade-in on mount, 140–180ms. Disabled under reduced-motion. |

---

## 4. Shell redesign (`components/Shell.tsx` + `index.css` `.app-*`)

- **Sidebar:** lucide icons replace emoji; active item gets a left accent bar +
  green tint + serif-ish weight; refined section labels; keep capability-gated
  sections (Owner / Operations / Admin / Branch tools). Brand mark + role chip
  retained.
- **Top bar (`.app-head`):** editorial bar with **breadcrumb** (Area › Page),
  **Fraunces page title**, a **search field**, the existing page-actions slot,
  and a compact **user chip** (avatar initial + role). Sign-out remains reachable
  (sidebar foot and/or user chip menu).
- Shell API stays `{ children, title, actions }`; add optional
  `breadcrumb`/`eyebrow` props as needed without breaking call sites.

---

## 5. Editorial kit (redesigned/new classes in `index.css`, minimal components)

- **Page header** — eyebrow + serif title + subtitle + actions row.
- **KPI tile** (`.stat-card`) — uppercase label · large tabular value · up/down
  delta hint (success/danger color) · optional sparkline slot.
- **Card** (`.card`) — softer surface, hover-lift, titled-section support.
- **Table** (`.table`/`.table-wrap`) — roomier padding, sticky hairline header,
  hover-highlight rows, right-aligned numerics, pill statuses, row→detail click.
- **Filter toolbar** — search + selects + CSV in one rounded container.
- **Buttons** (`.btn`) — keep green-gradient `--primary`; refine `--ghost`/
  `--subtle`; add an icon-button variant.
- **Pills/badges** (`.pill`) — refined success/warning/danger/ink/accent.
- **Empty / loading** — editorial empty card; reuse existing fruit loader for
  page loads.

Each unit is independently usable and documented by example on the redesigned
pages. Consumers compose markup; internals (the CSS) can change without breaking
call sites.

---

## 6. Owner-core pages (bespoke on the kit)

| Page | Archetype | Composition |
|---|---|---|
| `owner/dashboard` | Dashboard | Page header + date-range; KPI row (Revenue, Orders, Variance, Needs-review); 2-col: revenue-by-branch card + top-products card. |
| `owner/orders` (+ `order-detail`) | List + Detail | List: header + filter toolbar + table card; row→detail. Detail: back-breadcrumb + title + status + 2-col (primary panel + side meta + actions). |
| `owner/products` (+ `product-detail`) | List + Detail/Form | List as above; detail/editor: sectioned fieldsets + sticky save bar. |
| `owner/inventory` | List | Header + toolbar + table card; stock pills. |
| `owner/customers` (+ `customer-detail`) | List + Detail | List as above; detail: profile header + order history panel + meta. |

---

## 7. Dependencies, quality, accessibility

- **Add:** `lucide-react` to `apps/admin`.
- **Do not add:** framer-motion (CSS motion only).
- **Quality gates per page:** `tsc --noEmit` clean, `eslint` clean, `vite build`
  green. No off-brand colors introduced.
- **Accessibility:** visible focus rings; keyboard-reachable nav and actions;
  `prefers-reduced-motion` disables transforms/animations; icons paired with
  text labels in nav.
- **Verification constraint:** dev server is **not** run locally (docker-only per
  user); verification is static (typecheck/lint/build) unless the user runs the
  admin in docker for visual review.

---

## 8. Out of scope (this sub-project)

- Branch POS, Owner admin/config, and Factory areas (their own later cycles).
- ⌘K command palette; responsive icon-rail sidebar; any API/data-model changes.
- Functional/behavioral changes — this is a visual/structural redesign only.
