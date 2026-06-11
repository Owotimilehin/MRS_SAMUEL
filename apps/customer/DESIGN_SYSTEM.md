# Mrs. Samuel Fruit Juice — Design System

> The visual + voice language behind every page, bottle and conversation. Keep this file in sync with `src/styles.css` and the component library.

---

## 1. Brand essence

**Promise.** Real fruit. Real good. Cold-pressed in Lagos.

**Personality.** Warm, direct, Nigerian-rooted. Premium without being precious. Editorial calm, not wellness-soft.

**Voice rules.**
- Speak in plain English. No "elixir," no "wellness journey."
- Specifics over claims ("36 hours from tree to cap" > "always fresh").
- Mrs. Samuel and Mr. Samuel are real people. Use their voice in quotes.
- Always name the place: Lagos, Benue, a market, a cooperative.

---

## 2. Color tokens

Defined in `src/styles.css` under `:root`.

| Token | Value | Use |
|---|---|---|
| `--cream` | `#fff8ed` | Default page background |
| `--brand` | `#0e3f1f` | Primary text, footer, dark CTAs |
| `--brand-orange` | `#e85d1c` | Accent text, primary CTA hover, highlights |

### Product surface palette (per flavour)

Defined in `src/data/products.ts` as `SURFACES`. Each entry is `{ surface, accent, text }`. Surface = card background; accent = chips, prices, ingredient leaf badges; text = legible body on surface.

`orange · yellow · golden · cream · green · mint · avocado · watermelon · ruby · pink · blush · coral · beet`

**Rule.** A product's surface and accent always match its bottle's liquid colour. Never assign at random.

---

## 3. Typography

Loaded from Google Fonts in `src/routes/index.tsx` (and inherited app-wide).

| Role | Family | Weight | Tracking |
|---|---|---|---|
| Display (h1–h3) | **Fraunces** | 500–600 | `-0.025em` to `-0.035em` on large sizes |
| Body | **Plus Jakarta Sans** | 400–600 | normal |
| Eyebrows / labels | Plus Jakarta Sans | 700 uppercase | `0.22em` |

**Heading scale.**
- Page H1: `clamp(2.5rem, 6vw, 4.5rem)` — Fraunces 600
- Section H2: `text-3xl` → `text-5xl` — Fraunces 600
- Card H3: `text-lg` to `text-xl` — Fraunces 600

**Body.** `text-[15px]` to `text-[17px]`, leading `1.6–1.75`, color `text-[color:var(--brand)]/70–85`.

---

## 4. Spacing & rhythm

- Outer page padding: `px-5 sm:px-10`, max width `max-w-7xl mx-auto`.
- Section vertical padding: `py-16 sm:py-24`.
- Card grid gap: `gap-5 sm:gap-6`.
- Section header pattern: eyebrow chip → 12px → H2 → 16px → optional subtitle.

---

## 5. Radii & shadows

- Cards: `rounded-[1.25rem]` (small) / `rounded-2xl` (medium) / `rounded-[2rem]` (hero panels).
- Pills & buttons: `rounded-full`.
- Resting card shadow: `shadow-[0_2px_12px_rgba(20,20,10,0.06)] ring-1 ring-black/5`.
- Hover lift: `hover:shadow-[0_18px_45px_-10px_rgba(20,20,10,0.18)]`.
- Bottle drop shadow: `drop-shadow-[0_25px_30px_rgba(80,40,10,0.22)]`.

---

## 6. Motion principles

Powered by `framer-motion`.

- **Fade-up on scroll** for sections: `initial={{ opacity: 0, y: 16 }}` / `whileInView`.
- **Bottle float**: `y: [0, -8, 0]`, duration 6–7s, infinite, easeInOut.
- **Splash pulse**: `animate-splash` (defined in `styles.css`) — subtle scale + opacity loop.
- **Hover**: scale 1.02 max on cards; never use bouncy springs on commercial elements.
- Stagger via `delay: (i % cols) * 0.05–0.06`.

---

## 7. Component patterns

| Component | Purpose | Location |
|---|---|---|
| `Nav` | Top bar with type-safe `<Link>` routing, cart count, mobile menu | `src/components/Nav.tsx` |
| `SiteShell` | Wraps every route with bg, nav, newsletter, footer, cart drawer | `src/components/SiteShell.tsx` |
| `PageHero` | Reusable hero block with eyebrow + display title + decoration | `src/components/PageHero.tsx` |
| `Hero` | Home-only hero with 3-bottle composition + splash + clusters | `src/components/Hero.tsx` |
| `ProductCard` | Catalog tile — surface plate, bottle, price, add-to-cart | `src/components/ProductCard.tsx` |
| `ProductDetail` | Modal-style detail with size picker + add to cart | `src/components/ProductDetail.tsx` |

**Buttons.**
- Primary: `bg-[color:var(--brand)] text-white rounded-full` → hover `bg-[color:var(--brand-orange)]`.
- Accent: `bg-[color:var(--brand-orange)] text-white`.
- Ghost: `ring-1 ring-[color:var(--brand)]/25 text-[color:var(--brand)]`.
- Always pair with a trailing icon chip (`grid h-7 w-7 ... bg-white/15`) on primary CTAs.

---

## 8. Decoration rules (photoreal assets)

Located at `src/assets/decor/`.

- `splash-{orange,red,green}.png` — juice splashes behind bottles
- `cluster-{citrus,berry,tropical,green,root,watermelon}.png` — fruit clusters by family
- `leaf-mint.png` — accent leaf

**Layering law.** Bottles stay sharp and centred. Decorations sit behind or to the side at 75–95% opacity. Use `mix-blend-multiply` on splashes over light surfaces. Never overlap a cluster on top of a label.

Each product carries a `cluster: Cluster` field — use `CLUSTERS[product.cluster]` to render the right decoration on detail pages, related cards, and blog covers.

---

## 9. Iconography

`lucide-react`, stroke 1.5–2, rounded. Always inside a circular badge for primary contexts. Never mix icon libraries.

---

## 10. Page-level head metadata

Every route's `head()` must define a unique `title`, `description`, `og:title`, `og:description`. Format: `"{Page} — Mrs. Samuel Fruit Juice"`.

---

## 11. Accessibility

- All bottle/decoration images use `alt=""` + `aria-hidden` unless they convey product info.
- Buttons without text have `aria-label`.
- Focus rings via Tailwind `focus:ring-2 focus:ring-[color:var(--brand-orange)]/40`.
- Color contrast: all body text on cream ≥ 4.5:1.

---

## 12. Voice samples

✅ "Pressed at sunrise, in your fridge by lunchtime."
✅ "Beetroot tastes like the ground it grew in. That's the point."
✅ "We say no to plastic. Permanently."

❌ "Unlock your wellness journey with our premium elixir."
❌ "Discover the magic of nature in every sip."

---

_Last updated: this build._
