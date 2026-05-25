# @ms/customer

Public-facing customer site for Mrs. Samuel Fruit Juice. Renders the brand landing page, full menu, and (in progress) cart / checkout / order tracking.

## Why this app matters beyond shipping a landing page

The landing page (`src/routes/menu.tsx`) is the **major UI reference for every other screen in the Mrs. Samuel platform** — customer secondary screens, admin owner / factory / branch surfaces. The design tokens, shared components, animation rules, and visual patterns established here govern the entire product.

Whenever you build a new screen anywhere in the monorepo:

1. **Open the live styleguide first** → http://localhost:3002/styleguide  (source: `src/routes/styleguide.tsx`)
2. **Find the components you need** — colors, typography, buttons, cards, toggles, status pills, motion patterns
3. **Import from `src/components/ui/`** — `<Button>`, `<Eyebrow>`, `<SectionHeader>`, `<SizeToggle>`, `<StatusPill>`
4. **If a primitive is missing**: add it to `src/components/ui/` **AND** document it in `styleguide.tsx`. Never ship one-offs that other screens will copy.

Full reference: [`docs/2026-05-18-design-system.md`](../../../docs/2026-05-18-design-system.md). Intent layer: [`UI_SPEC.md`](../../../UI_SPEC.md) (Parts 1–2).

## Where things live

| Concern | Location |
| --- | --- |
| **Live design reference (runnable)** | `/styleguide` (open while building anything) |
| **Styleguide source** | `src/routes/styleguide.tsx` |
| **Design tokens & component CSS** | `src/index.css` |
| **Shared React UI primitives** | `src/components/ui/` |
| **Menu data + pricing helpers** | `src/data/menu.ts` |
| **Cart store (zustand)** | `src/store/cart.ts` |
| **API client / NGN formatter** | `src/lib/api.ts` |
| **Routes** | `src/routes/{menu,cart,checkout,track,styleguide}.tsx` |
| **Brand assets** | `public/assets/` (bottles, fruits, logo, hero composites) |

## Dev

```
pnpm dev      # vite at http://localhost:3002 (proxies /v1/* to API on :3001)
pnpm build    # production bundle
pnpm test     # vitest
```

The customer app proxies `/v1/*` to the API server (`apps/api` on port 3001). The API is **not** required to run for the landing page — calls (Instagram feed) soft-fail to placeholders.

## Locked design rules (in agent memory)

- **`.btn--primary` always uses `var(--grad)`** — the sunrise gradient. Never a solid `var(--accent)` fill. Hover uses `filter: brightness(1.05)`, not a darker color.
- **All animations respect `prefers-reduced-motion: reduce`** — disabled entirely for users who opt out.
- **Photographic imagery only** — bottles and fruit cutouts are real product photography generated via Nano Banana, never illustration / 3D render / cartoon. See UI_SPEC §1.7 for the Nano Banana realism rule.
