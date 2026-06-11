# Wire the Customer Site to the Live API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the customer storefront's hardcoded static data with the live API as the single source of truth, ship richer static content up into the DB/seed, and stand up the three missing backends (contact, subscription, bundles).

**Architecture:** The customer app is TanStack Start (SSR, node-server). All data access — reads *and* writes — goes through TanStack `createServerFn` wrappers that call the API server-side via a small typed `apiFetch` client. This keeps the API un-exposed to the browser, avoids cross-origin CORS, and is SEO-safe. The cart stays client-side React state (now carrying `variant_id` per line); checkout posts explicit `items[]` to the already-built `POST /v1/public/orders` pipeline (stock reservation → OPay redirect → tracking page). New backends follow existing Hono+Drizzle+zod patterns; leads also emit `outbox_event`s the worker already fans out to Telegram.

**Tech Stack:** TanStack Start/Router 1.16x, React 19, `@tanstack/react-start` `createServerFn`, Framer Motion, Tailwind v4; Hono + Drizzle ORM (Postgres); Vitest + testcontainers (API); OPay Cashier; Cloudflare Turnstile.

---

## Architecture decisions baked into this plan

1. **Everything via server functions.** `createServerFn` handlers run on the customer's Node server and call the API with `apiFetch`. Loaders call the read server-fns (SSR); client components call the write server-fns (cart-derived order placement, quote, contact, subscription lead). No `fetch` to the API from the browser, so **no CORS work and no public API URL leaked**.
2. **Cart stays client state.** `useCart` keeps its current shape but each `CartItem` gains `variantId` and a numeric `unitPrice` (resolved from the mapped product). This removes the dependency on `Product.prices[size]` lookups that the API-sourced product may format differently, and gives checkout the exact `variant_id` the order API wants. We do **not** wire `/v1/public/cart`; passing explicit `items[]` to `POST /v1/public/orders` is equally real and lower-risk. (Refines spec §D — same outcome, the order endpoint already accepts `items[]` and prefers it over the cookie cart.)
3. **Blog body is markdown.** The API serves `body_md`. The 6 static posts use structured `body[]` blocks; the seed converts each block to markdown (`h`→`## `, `quote`→`> `, `p`→plain, joined by blank lines). The frontend renders `body_md` with a minimal block-level parser (headings / blockquotes / paragraphs) that reproduces today's styling. No markdown dependency added.
4. **One product row per flavour; price lives on the variant.** Mappers collapse `variants[]` → `prices: {"330ml","650ml"}` AND expose `variantIds: {"330ml"?, "650ml"?}`. (Matches the `[[project_mrs_samuel_pricing_model]]` memory.)
5. **`category` mapping.** DB product `category` is `"regular" | "special" | "punch"`; the UI `Product.category` is `"Classic" | "Special"`. The mapper maps `regular`→`Classic`, everything else→`Special`.
6. **`cluster` is not stored on products.** The UI derives `cluster` + fruit images from a slug→cluster map that already lives in `products.ts` (`PRODUCT_FRUITS`, `CLUSTERS`). We keep these visual maps as a small static `lib/visuals.ts` module (images are bundled assets, not API data) and the mapper sets `product.cluster` from a slug→cluster lookup. Only the *marketing data* moves to the API; bundled image assets stay in the app.

---

## File structure

**New — customer API layer (`apps/customer/src/lib/api/`)**
- `config.ts` — `API_BASE` resolution.
- `client.ts` — `apiFetch<T>` + `ApiError`.
- `types.ts` — API response interfaces.
- `mappers.ts` — `toUiProduct`, `toUiPost`, `toUiBundle`, `toUiPlan`.
- `server-fns.ts` — all `createServerFn` read/write wrappers.

**New — customer visuals + routes**
- `apps/customer/src/lib/visuals.ts` — `CLUSTERS`, `PRODUCT_FRUITS`, `getFruitFor`, `clusterForSlug` (bundled image maps; extracted from `products.ts`).
- `apps/customer/src/lib/markdown.tsx` — minimal block renderer.
- `apps/customer/src/routes/order.$orderNumber.tsx` — order tracking page.

**New — API**
- `apps/api/src/routes/public-contact.ts`
- `apps/api/src/routes/public-subscriptions.ts`

**New — DB**
- `packages/db/src/schema/contact-message.ts`
- `packages/db/src/schema/subscription-plan.ts`
- `packages/db/src/schema/subscription-lead.ts`
- `packages/db/src/schema/bundle.ts`
- `packages/db/migrations/0039_blog_content_fields.sql`
- `packages/db/migrations/0040_storefront_marketing.sql`
- `packages/db/src/seed-data/storefront.json` — bundles + subscription plans seed data.

**New — tests**
- `apps/customer/src/lib/api/mappers.test.ts`
- `apps/customer/src/lib/api/client.test.ts`
- `apps/api/test/integration/public-contact.test.ts`
- `apps/api/test/integration/public-subscriptions.test.ts`
- `apps/api/test/integration/public-bundles.test.ts`
- `apps/api/test/integration/public-blog-fields.test.ts`

**Modified**
- Customer routes: `index.tsx`, `juices.index.tsx`, `juices.$id.tsx`, `shop.tsx`, `blog.index.tsx`, `blog.$slug.tsx`, `checkout.tsx`, `contact.tsx`, `subscription.tsx`.
- Customer: `lib/cart.tsx`, `components/Blog.tsx`, `components/Subscription.tsx` (home sections that import static data), `data/products.ts` → reduced/deleted, `data/blogPosts.ts` → deleted.
- API: `routes/public-blog.ts`, `routes/blog.ts`, `routes/public-catalog.ts`, `test-app.ts`.
- DB: `schema/index.ts`, `seed.ts`.
- Worker: `src/outbox.ts`.
- Admin: `routes/owner/blog.tsx`.
- Env/compose: customer env example files + deploy compose.

---

## Milestone 0 — API client foundation

### Task 0.1: API base config

**Files:**
- Create: `apps/customer/src/lib/api/config.ts`

- [ ] **Step 1: Write the config module**

```ts
// apps/customer/src/lib/api/config.ts
/**
 * Base URL for the Mrs. Samuel API. Used only inside server functions
 * (they run on the customer's Node server and proxy the API), so the value
 * never reaches the browser. Vite statically replaces import.meta.env at
 * build time for both the client and SSR bundles.
 */
export const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ??
  "http://localhost:8787";
```

- [ ] **Step 2: Commit**

```bash
git add apps/customer/src/lib/api/config.ts
git commit -m "feat(customer): API base config"
```

### Task 0.2: Typed API client

**Files:**
- Create: `apps/customer/src/lib/api/client.ts`
- Test: `apps/customer/src/lib/api/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/customer/src/lib/api/client.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { apiFetch, ApiError } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("apiFetch", () => {
  it("unwraps the { data } envelope on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { hello: "world" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const out = await apiFetch<{ hello: string }>("/v1/public/catalog/products");
    expect(out).toEqual({ hello: "world" });
  });

  it("throws ApiError carrying code + status on the { error } envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(apiFetch("/v1/public/blog/missing")).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      status: 404,
    });
  });

  it("throws ApiError on a non-JSON 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream boom", { status: 500 })),
    );
    await expect(apiFetch("/v1/public/catalog/products")).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ms/customer test -- src/lib/api/client.test.ts`
Expected: FAIL — cannot find module `./client`.

- [ ] **Step 3: Write the client**

```ts
// apps/customer/src/lib/api/client.ts
import { API_BASE } from "./config";

export class ApiError extends Error {
  readonly name = "ApiError";
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Fetch an API endpoint and return the unwrapped `data` payload. Throws an
 * ApiError for the `{ error }` envelope or any non-2xx / non-JSON response.
 * Called from server functions only.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError("network_error", err instanceof Error ? err.message : "network error", 0);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (res.ok) return undefined as T;
    throw new ApiError("upstream_error", `API ${res.status}`, res.status);
  }

  const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok || json.error) {
    const e = json.error ?? { code: "upstream_error", message: `API ${res.status}` };
    throw new ApiError(e.code, e.message, res.status);
  }
  return json.data as T;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ms/customer test -- src/lib/api/client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/customer/src/lib/api/client.ts apps/customer/src/lib/api/client.test.ts
git commit -m "feat(customer): typed apiFetch client with ApiError"
```

### Task 0.3: API response types

**Files:**
- Create: `apps/customer/src/lib/api/types.ts`

- [ ] **Step 1: Write the types**

```ts
// apps/customer/src/lib/api/types.ts
// Mirrors the JSON shapes returned by /v1/public/* endpoints.

export interface ApiVariant {
  id: string;
  size_ml: number;
  sku: string;
  price_ngn: number;
}

export interface ApiPalette {
  surface: string;
  accent: string;
  text: string;
}

export interface ApiIngredientDetail {
  name: string;
  benefit: string;
}

export interface ApiProduct {
  id: string;
  name: string;
  slug: string;
  category: "regular" | "special" | "punch";
  ingredients: string[];
  image_url: string | null;
  tagline: string | null;
  story: string | null;
  pairing: string | null;
  note: string | null;
  benefits: string[];
  best_for: string[];
  ingredient_details: ApiIngredientDetail[];
  palette: ApiPalette | null;
  bottle_url: string | null;
  cluster_url: string | null;
  fruit_url: string | null;
  price_ngn: number;
  variants: ApiVariant[];
}

export interface ApiBranch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
}

export interface ApiBlogSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  cover_url: string | null;
  published_at: string | null;
  author: string | null;
  read_mins: number | null;
  category: string | null;
  cluster: string | null;
}

export interface ApiBlogPost extends ApiBlogSummary {
  body_md: string;
}

export interface ApiBundle {
  id: string;
  slug: string;
  name: string;
  price_ngn: number;
  description: string | null;
  contents_label: string | null;
  badge: string | null;
  image_url: string | null;
}

export interface ApiSubscriptionPlan {
  id: string;
  slug: string;
  name: string;
  price_ngn: number;
  period: string;
  bottles_label: string | null;
  description: string | null;
  perks: string[];
  popular: boolean;
}

export interface ApiDeliveryOption {
  id: string;
  courier_name: string;
  fee_ngn: number;
  eta_minutes: number | null;
  on_demand: boolean;
}

export interface ApiQuote {
  provider: string;
  quote_token: string | null;
  address_valid: boolean;
  validated_address: { formatted: string; lat: number; lng: number } | null;
  options: ApiDeliveryOption[];
  notice?: string;
}

export interface ApiPlacedOrder {
  id: string;
  order_number: string;
  total_ngn: number;
  payment: { authorization_url: string; reference: string };
}

export interface ApiOrderTracking {
  order_number: string;
  status: string;
  payment_status: string;
  total_ngn: number;
  subtotal_ngn: number;
  delivery_fee_ngn: number;
  channel: string;
  created_at: string;
  delivery: {
    status: string;
    rider_name: string | null;
    rider_phone: string | null;
    eta_minutes: number | null;
    tracking_url: string | null;
  } | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/customer/src/lib/api/types.ts
git commit -m "feat(customer): API response type definitions"
```

### Task 0.4: Extract bundled visual maps to `lib/visuals.ts`

This moves the image-asset maps out of `data/products.ts` (which we delete later) into a standalone module so mappers and routes can derive cluster/fruit images without the static product array.

**Files:**
- Create: `apps/customer/src/lib/visuals.ts`

- [ ] **Step 1: Write the module** (copy the asset imports + maps verbatim from `data/products.ts` lines 1–67, then add `clusterForSlug`)

```tsx
// apps/customer/src/lib/visuals.ts
import bottleSunrise from "@/assets/bottle-sunrise.png";
import bottlePink from "@/assets/bottle-pink.png";
import bottleWatermelon from "@/assets/bottle-watermelon.png";
import bottleGreen from "@/assets/bottle-green.png";
import bottleYellow from "@/assets/bottle-yellow.png";
import bottleBeet from "@/assets/bottle-beet.png";
import bottleGolden from "@/assets/bottle-golden.png";
import bottleBanana from "@/assets/bottle-banana.png";
import bottleMint from "@/assets/bottle-mint.png";
import bottleAvocado from "@/assets/bottle-avocado.png";
import bottleRuby from "@/assets/bottle-ruby.png";
import bottleCreamPink from "@/assets/bottle-cream-pink.png";
import bottleCoral from "@/assets/bottle-coral.png";

import clusterCitrus from "@/assets/decor/cluster-citrus.png";
import clusterBerry from "@/assets/decor/cluster-berry.png";
import clusterTropical from "@/assets/decor/cluster-tropical.png";
import clusterGreen from "@/assets/decor/cluster-green.png";
import clusterRoot from "@/assets/decor/cluster-root.png";
import clusterWatermelon from "@/assets/decor/cluster-watermelon.png";

import fruitMango from "@/assets/decor/fruit-mango.png";
import fruitPineapple from "@/assets/decor/fruit-pineapple.png";
import fruitBerryMix from "@/assets/decor/fruit-berry-mix.png";
import fruitKiwi from "@/assets/decor/fruit-kiwi.png";
import fruitGinger from "@/assets/decor/fruit-ginger.png";
import fruitWatermelonSlice from "@/assets/decor/fruit-watermelon-slice.png";
import fruitCreamy from "@/assets/decor/fruit-creamy.png";
import fruitBeetRoot from "@/assets/decor/fruit-beet-root.png";
import fruitOrangeSlice from "@/assets/decor/fruit-orange-slice.png";

export type Size = "330ml" | "650ml";
export type Cluster = "citrus" | "berry" | "tropical" | "green" | "root" | "watermelon";

export const CLUSTERS: Record<Cluster, string> = {
  citrus: clusterCitrus,
  berry: clusterBerry,
  tropical: clusterTropical,
  green: clusterGreen,
  root: clusterRoot,
  watermelon: clusterWatermelon,
};

// Default bottle image used when the API has no media URL yet (dev fallback).
export const DEFAULT_BOTTLE = bottleSunrise;
// Keep the remaining bottle imports referenced so tree-shaking keeps the assets
// available for any future slug→bottle mapping; harmless no-op export.
export const BOTTLES = {
  bottleSunrise, bottlePink, bottleWatermelon, bottleGreen, bottleYellow,
  bottleBeet, bottleGolden, bottleBanana, bottleMint, bottleAvocado,
  bottleRuby, bottleCreamPink, bottleCoral,
};

export const PRODUCT_FRUITS: Record<string, string> = {
  sunrise: fruitOrangeSlice,
  "crimson-garden": fruitBeetRoot,
  "crimson-elixir": fruitWatermelonSlice,
  "crimson-cooler": fruitWatermelonSlice,
  "ginger-spark": fruitGinger,
  orange: fruitOrangeSlice,
  pineapple: fruitPineapple,
  pinecado: fruitCreamy,
  guyabano: fruitBerryMix,
  "vitamin-vibe": fruitGinger,
  "ginger-mint-splash": fruitKiwi,
  "zesty-sunrise": fruitOrangeSlice,
  "veggie-burst": fruitBeetRoot,
  "lemon-sip": fruitGinger,
  "sweet-pepper-splash": fruitWatermelonSlice,
  melongrape: fruitWatermelonSlice,
  "creamy-paradise": fruitCreamy,
  "nourish-blend": fruitMango,
  "tropical-mango": fruitMango,
  "pure-green": fruitKiwi,
};

// Slug → cluster, so the API (which doesn't store cluster) can still get the
// right decoration. Falls back to "tropical".
const SLUG_CLUSTER: Record<string, Cluster> = {
  sunrise: "citrus", orange: "citrus", "zesty-sunrise": "citrus", "lemon-sip": "citrus",
  "crimson-garden": "root", "veggie-burst": "root",
  "crimson-elixir": "watermelon", "crimson-cooler": "watermelon",
  "sweet-pepper-splash": "watermelon", melongrape: "watermelon",
  guyabano: "berry",
  pineapple: "tropical", pinecado: "tropical", "tropical-mango": "tropical",
  "nourish-blend": "tropical", "creamy-paradise": "tropical",
  "ginger-spark": "green", "vitamin-vibe": "green", "ginger-mint-splash": "green",
  "pure-green": "green",
};

export const clusterForSlug = (slug: string): Cluster => SLUG_CLUSTER[slug] ?? "tropical";
export const getFruitFor = (slug: string, cluster: Cluster): string =>
  PRODUCT_FRUITS[slug] ?? CLUSTERS[cluster];
```

- [ ] **Step 2: Commit**

```bash
git add apps/customer/src/lib/visuals.ts
git commit -m "feat(customer): extract bundled visual maps + slug→cluster lookup"
```

### Task 0.5: Mappers (API → UI types)

**Files:**
- Create: `apps/customer/src/lib/api/mappers.ts`
- Test: `apps/customer/src/lib/api/mappers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/customer/src/lib/api/mappers.test.ts
import { describe, it, expect } from "vitest";
import { toUiProduct } from "./mappers";
import type { ApiProduct } from "./types";

const api: ApiProduct = {
  id: "p1", name: "Sunrise Blend", slug: "sunrise", category: "regular",
  ingredients: ["carrot", "orange"], image_url: null,
  tagline: "Morning in a bottle", story: "story", pairing: "toast", note: null,
  benefits: ["energy"], best_for: ["mornings"],
  ingredient_details: [{ name: "carrot", benefit: "vitamin a" }],
  palette: { surface: "#fff", accent: "#f80", text: "#000" },
  bottle_url: "https://cdn/bottle.png", cluster_url: null, fruit_url: null,
  price_ngn: 2500,
  variants: [
    { id: "v330", size_ml: 330, sku: "S-330", price_ngn: 2500 },
    { id: "v650", size_ml: 650, sku: "S-650", price_ngn: 4200 },
  ],
};

describe("toUiProduct", () => {
  it("collapses variants into prices + variantIds keyed by size label", () => {
    const p = toUiProduct(api);
    expect(p.prices).toEqual({ "330ml": 2500, "650ml": 4200 });
    expect(p.variantIds).toEqual({ "330ml": "v330", "650ml": "v650" });
  });

  it("maps regular→Classic and image_url/bottle_url→image", () => {
    const p = toUiProduct(api);
    expect(p.category).toBe("Classic");
    expect(p.image).toBe("https://cdn/bottle.png");
  });

  it("maps non-regular category→Special", () => {
    expect(toUiProduct({ ...api, category: "special" }).category).toBe("Special");
    expect(toUiProduct({ ...api, category: "punch" }).category).toBe("Special");
  });

  it("derives cluster from slug when API omits it", () => {
    expect(toUiProduct(api).cluster).toBe("citrus");
  });

  it("falls back to a bundled bottle when no image url is present", () => {
    const p = toUiProduct({ ...api, image_url: null, bottle_url: null });
    expect(typeof p.image).toBe("string");
    expect(p.image.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ms/customer test -- src/lib/api/mappers.test.ts`
Expected: FAIL — cannot find module `./mappers`.

- [ ] **Step 3: Write the mappers + the UI types they produce**

```ts
// apps/customer/src/lib/api/mappers.ts
import type { ApiProduct, ApiBlogSummary, ApiBlogPost, ApiBundle, ApiSubscriptionPlan } from "./types";
import { clusterForSlug, DEFAULT_BOTTLE, type Cluster, type Size } from "@/lib/visuals";

export interface Ingredient {
  name: string;
  benefit: string;
}

/** UI product shape consumed across the storefront (API-sourced). */
export interface Product {
  id: string; // slug — used in /juices/$id route params
  productId: string; // DB uuid — used for cart/order
  name: string;
  tagline: string;
  ingredients: string[];
  ingredientDetails: Ingredient[];
  benefits: string[];
  story: string;
  pairing: string;
  bestFor: string[];
  category: "Classic" | "Special";
  cluster: Cluster;
  palette: { surface: string; accent: string; text: string };
  image: string;
  prices: { "330ml": number; "650ml": number };
  variantIds: Partial<Record<Size, string>>;
  note?: string;
}

const FALLBACK_PALETTE = { surface: "#fdf3e7", accent: "#f6a623", text: "#3a2a18" };

export function toUiProduct(api: ApiProduct): Product {
  const prices: Record<string, number> = {};
  const variantIds: Partial<Record<Size, string>> = {};
  for (const v of api.variants) {
    const label = `${v.size_ml}ml` as Size;
    prices[label] = v.price_ngn;
    variantIds[label] = v.id;
  }
  // Guarantee both keys exist so existing UI that reads prices["330ml"]/["650ml"]
  // never renders NaN. Fall back to the cheapest known price.
  const cheapest = api.price_ngn ?? api.variants[0]?.price_ngn ?? 0;
  return {
    id: api.slug,
    productId: api.id,
    name: api.name,
    tagline: api.tagline ?? "",
    ingredients: api.ingredients ?? [],
    ingredientDetails: api.ingredient_details ?? [],
    benefits: api.benefits ?? [],
    story: api.story ?? "",
    pairing: api.pairing ?? "",
    bestFor: api.best_for ?? [],
    category: api.category === "regular" ? "Classic" : "Special",
    cluster: clusterForSlug(api.slug),
    palette: api.palette ?? FALLBACK_PALETTE,
    image: api.image_url ?? api.bottle_url ?? DEFAULT_BOTTLE,
    prices: { "330ml": prices["330ml"] ?? cheapest, "650ml": prices["650ml"] ?? cheapest },
    variantIds,
    ...(api.note ? { note: api.note } : {}),
  };
}

export interface BlogPostSummary {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  date: string;
  readMins: number;
  category: string;
  cover: Cluster;
}

export interface BlogPost extends BlogPostSummary {
  bodyMd: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-NG", { year: "numeric", month: "long", day: "numeric" });
}

export function toUiPostSummary(api: ApiBlogSummary): BlogPostSummary {
  return {
    slug: api.slug,
    title: api.title,
    excerpt: api.excerpt ?? "",
    author: api.author ?? "Mrs. Samuel",
    date: formatDate(api.published_at),
    readMins: api.read_mins ?? 4,
    category: api.category ?? "Story",
    cover: (api.cluster as Cluster) ?? "tropical",
  };
}

export function toUiPost(api: ApiBlogPost): BlogPost {
  return { ...toUiPostSummary(api), bodyMd: api.body_md };
}

export interface Bundle {
  id: string;
  slug: string;
  name: string;
  price: number;
  desc: string;
  items: string;
  badge: string;
}

export function toUiBundle(api: ApiBundle): Bundle {
  return {
    id: api.id,
    slug: api.slug,
    name: api.name,
    price: api.price_ngn,
    desc: api.description ?? "",
    items: api.contents_label ?? "",
    badge: api.badge ?? "",
  };
}

export interface SubscriptionPlan {
  slug: string;
  name: string;
  price: number;
  period: string;
  bottles: string;
  desc: string;
  perks: string[];
  popular: boolean;
}

export function toUiPlan(api: ApiSubscriptionPlan): SubscriptionPlan {
  return {
    slug: api.slug,
    name: api.name,
    price: api.price_ngn,
    period: api.period,
    bottles: api.bottles_label ?? "",
    desc: api.description ?? "",
    perks: api.perks ?? [],
    popular: api.popular,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ms/customer test -- src/lib/api/mappers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/customer/src/lib/api/mappers.ts apps/customer/src/lib/api/mappers.test.ts
git commit -m "feat(customer): API→UI mappers for product/blog/bundle/plan"
```

### Task 0.6: Server-function wrappers (reads + writes)

**Files:**
- Create: `apps/customer/src/lib/api/server-fns.ts`

> Note: `createServerFn` validators receive the raw input; we keep them permissive (the API does the real validation). Reads throw `notFound()` where the route should 404.

- [ ] **Step 1: Write the server functions**

```ts
// apps/customer/src/lib/api/server-fns.ts
import { createServerFn } from "@tanstack/react-start";
import { notFound } from "@tanstack/react-router";
import { apiFetch, ApiError } from "./client";
import {
  toUiProduct, toUiPostSummary, toUiPost, toUiBundle, toUiPlan,
  type Product, type BlogPostSummary, type BlogPost, type Bundle, type SubscriptionPlan,
} from "./mappers";
import type {
  ApiProduct, ApiBranch, ApiBlogSummary, ApiBlogPost, ApiBundle, ApiSubscriptionPlan,
  ApiQuote, ApiPlacedOrder, ApiOrderTracking,
} from "./types";

// ---------- Catalog ----------
export const fetchProducts = createServerFn({ method: "GET" }).handler(async (): Promise<Product[]> => {
  const rows = await apiFetch<ApiProduct[]>("/v1/public/catalog/products");
  return rows.map(toUiProduct);
});

export const fetchProductBySlug = createServerFn({ method: "GET" })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<Product> => {
    try {
      const row = await apiFetch<ApiProduct>(`/v1/public/catalog/products/${encodeURIComponent(slug)}`);
      return toUiProduct(row);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound();
      throw err;
    }
  });

export const fetchBranches = createServerFn({ method: "GET" }).handler(async (): Promise<ApiBranch[]> => {
  return apiFetch<ApiBranch[]>("/v1/public/catalog/branches");
});

// ---------- Blog ----------
export const fetchBlogPosts = createServerFn({ method: "GET" }).handler(async (): Promise<BlogPostSummary[]> => {
  const rows = await apiFetch<ApiBlogSummary[]>("/v1/public/blog");
  return rows.map(toUiPostSummary);
});

export const fetchBlogPost = createServerFn({ method: "GET" })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<BlogPost> => {
    try {
      const row = await apiFetch<ApiBlogPost>(`/v1/public/blog/${encodeURIComponent(slug)}`);
      return toUiPost(row);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound();
      throw err;
    }
  });

// ---------- Bundles + subscription plans ----------
export const fetchBundles = createServerFn({ method: "GET" }).handler(async (): Promise<Bundle[]> => {
  const rows = await apiFetch<ApiBundle[]>("/v1/public/catalog/bundles");
  return rows.map(toUiBundle);
});

export const fetchSubscriptionPlans = createServerFn({ method: "GET" }).handler(async (): Promise<SubscriptionPlan[]> => {
  const rows = await apiFetch<ApiSubscriptionPlan[]>("/v1/public/catalog/subscription-plans");
  return rows.map(toUiPlan);
});

// ---------- Checkout writes ----------
export interface QuoteInput {
  branch_id: string;
  dropoff_address: string;
  delivery_state?: string;
}
export const requestQuote = createServerFn({ method: "POST" })
  .validator((d: QuoteInput) => d)
  .handler(async ({ data }): Promise<ApiQuote> => {
    return apiFetch<ApiQuote>("/v1/public/orders/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  });

export interface PlaceOrderInput {
  branch_id: string;
  delivery_fee_ngn: number;
  delivery_quote_id?: string;
  delivery_state?: string;
  customer: { name: string; phone: string; email?: string; address: string };
  items: Array<{ variant_id: string; quantity: number }>;
  notes?: string;
  turnstile_token?: string;
  idempotency_key: string;
}
export const placeOrder = createServerFn({ method: "POST" })
  .validator((d: PlaceOrderInput) => d)
  .handler(async ({ data }): Promise<ApiPlacedOrder> => {
    const { idempotency_key, ...body } = data;
    return apiFetch<ApiPlacedOrder>("/v1/public/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotency_key },
      body: JSON.stringify(body),
    });
  });

export const trackOrder = createServerFn({ method: "GET" })
  .validator((d: { orderNumber: string; phone: string }) => d)
  .handler(async ({ data }): Promise<ApiOrderTracking> => {
    try {
      return await apiFetch<ApiOrderTracking>(
        `/v1/public/orders/${encodeURIComponent(data.orderNumber)}?phone=${encodeURIComponent(data.phone)}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound();
      throw err;
    }
  });

// ---------- Contact + subscription leads ----------
export const sendContactMessage = createServerFn({ method: "POST" })
  .validator((d: { name: string; email: string; phone?: string; subject: string; message: string; turnstile_token?: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await apiFetch("/v1/public/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    return { ok: true };
  });

export const requestSubscription = createServerFn({ method: "POST" })
  .validator((d: { name: string; phone: string; plan_slug: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await apiFetch("/v1/public/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    return { ok: true };
  });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Expected: PASS (no type errors). If `createServerFn`'s `.validator`/`.handler` generic signatures differ in the installed `@tanstack/react-start` version, adjust per the local `node_modules/@tanstack/react-start` d.ts — the contract (input validator + async handler returning the typed payload) is the invariant.

- [ ] **Step 3: Commit**

```bash
git add apps/customer/src/lib/api/server-fns.ts
git commit -m "feat(customer): server-fn wrappers for catalog/blog/checkout/leads"
```

---

## Milestone 1 — Catalog wiring

### Task 1.1: Cart carries variant id + unit price

**Files:**
- Modify: `apps/customer/src/lib/cart.tsx`

- [ ] **Step 1: Rewrite `cart.tsx`** (keep the public API; add `variantId`/`unitPrice`, switch the `Product` import to the mapper type, add localStorage persistence so a refresh keeps the basket)

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";

export interface CartItem {
  id: string;
  product: Product;
  size: Size;
  variantId: string;
  unitPrice: number;
  qty: number;
}

interface CartCtx {
  items: CartItem[];
  add: (product: Product, size: Size) => void;
  remove: (id: string) => void;
  setQty: (id: string, qty: number) => void;
  clear: () => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  subtotal: number;
  count: number;
}

const Ctx = createContext<CartCtx | null>(null);
const STORAGE_KEY = "ms_cart_v2";

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [open, setOpen] = useState(false);

  // Hydrate from localStorage on mount (client-only; SSR starts empty).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setItems(JSON.parse(raw) as CartItem[]);
    } catch {
      /* ignore corrupt cart */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* ignore quota */
    }
  }, [items]);

  const add = (product: Product, size: Size) => {
    const variantId = product.variantIds[size];
    if (!variantId) return; // size not sellable
    const id = `${product.id}-${size}`;
    const unitPrice = product.prices[size];
    setItems((prev) => {
      const exist = prev.find((i) => i.id === id);
      if (exist) return prev.map((i) => (i.id === id ? { ...i, qty: i.qty + 1 } : i));
      return [...prev, { id, product, size, variantId, unitPrice, qty: 1 }];
    });
    setOpen(true);
  };

  const remove = (id: string) => setItems((p) => p.filter((i) => i.id !== id));
  const setQty = (id: string, qty: number) =>
    setItems((p) => (qty <= 0 ? p.filter((i) => i.id !== id) : p.map((i) => (i.id === id ? { ...i, qty } : i))));
  const clear = () => setItems([]);

  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const count = items.reduce((s, i) => s + i.qty, 0);

  return (
    <Ctx.Provider value={{ items, add, remove, setQty, clear, open, setOpen, subtotal, count }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error("CartProvider missing");
  return c;
}

export const formatNaira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
```

- [ ] **Step 2: Find every reader of `it.product.prices[it.size]`** and confirm they still resolve (they will, the field stays). Grep for stale `i.product.prices`:

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Expected: errors only in files still importing from `@/data/products` (fixed in later tasks). Note them; do not fix unrelated files yet.

- [ ] **Step 3: Commit**

```bash
git add apps/customer/src/lib/cart.tsx
git commit -m "feat(customer): cart items carry variantId + unitPrice, persist to localStorage"
```

### Task 1.2: Home page from API

**Files:**
- Modify: `apps/customer/src/routes/index.tsx`
- Modify: `apps/customer/src/components/Blog.tsx` (home blog teaser — see Task 2.7), `components/Subscription.tsx` (home subscription teaser — see Task 4.x)

> The home page currently filters `products` for `classics`. Add a loader and read loader data.

- [ ] **Step 1: Add a loader + switch the data source** — replace the static import and `const classics = products.filter(...)`:

Replace line 5 `import { products, type Product } from "@/data/products";` with:
```tsx
import type { Product } from "@/lib/api/mappers";
import { fetchProducts } from "@/lib/api/server-fns";
```

Add to the `createFileRoute("/")({ ... })` options (alongside `head`/`component`):
```tsx
  loader: async () => ({ products: await fetchProducts() }),
```

In `function Page()`, replace `const [selected, ...]` block's reliance on the static array. Replace:
```tsx
  const classics = products.filter((p) => p.category === "Classic").slice(0, 8);
```
with:
```tsx
  const { products } = Route.useLoaderData();
  const classics = products.filter((p) => p.category === "Classic").slice(0, 8);
```
(Keep `const [selected, setSelected] = useState<Product | null>(null);` — `Product` now comes from the mapper import.)

- [ ] **Step 2: Verify the home page components that take `products`/`Product` still typecheck.** Any home child component importing `from "@/data/products"` must switch to `@/lib/api/mappers` (type) / `@/lib/visuals` (images). Use the Grep tool (pattern `@/data/products`, path `apps/customer/src/components`) to find them, then run:

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Expected: remaining errors are confined to not-yet-migrated routes/components.

- [ ] **Step 3: Commit**

```bash
git add apps/customer/src/routes/index.tsx
git commit -m "feat(customer): home page loads products from API"
```

### Task 1.3: Juices list + detail from API

**Files:**
- Modify: `apps/customer/src/routes/juices.index.tsx`
- Modify: `apps/customer/src/routes/juices.$id.tsx`

- [ ] **Step 1: `juices.index.tsx`** — replace `import { products, getFruitFor } from "@/data/products";` with:
```tsx
import { getFruitFor } from "@/lib/visuals";
import { fetchProducts } from "@/lib/api/server-fns";
```
Add loader to the route:
```tsx
  loader: async () => ({ products: await fetchProducts() }),
```
At the top of `function Page()` add:
```tsx
  const { products } = Route.useLoaderData();
```
`getFruitFor(p.id, p.cluster)` still works — `p.id` is the slug, `p.cluster` is derived. No other change.

- [ ] **Step 2: `juices.$id.tsx`** — replace `import { getProduct, products, type Size, CLUSTERS } from "@/data/products";` with:
```tsx
import type { Size } from "@/lib/visuals";
import { CLUSTERS } from "@/lib/visuals";
import { fetchProductBySlug, fetchProducts } from "@/lib/api/server-fns";
import type { Product } from "@/lib/api/mappers";
```
Replace the loader:
```tsx
  loader: async ({ params }) => {
    const [product, all] = await Promise.all([
      fetchProductBySlug({ data: params.id }),
      fetchProducts(),
    ]);
    return { product, related: all.filter((x) => x.id !== product.id && x.cluster === product.cluster).slice(0, 3) };
  },
```
Update `head` to read `loaderData?.product`:
```tsx
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.product?.name ?? "Juice"} — Mrs. Samuel Fruit Juice` },
      { name: "description", content: loaderData?.product?.tagline ?? "Cold-pressed Nigerian juice." },
      { property: "og:title", content: `${loaderData?.product?.name} — Mrs. Samuel` },
      { property: "og:description", content: loaderData?.product?.tagline ?? "" },
      { property: "og:type", content: "product" },
    ],
  }),
```
In `function Page()` replace:
```tsx
  const p = Route.useLoaderData() as NonNullable<ReturnType<typeof getProduct>>;
```
with:
```tsx
  const { product: p, related } = Route.useLoaderData();
```
and delete the now-duplicate `const related = products.filter(...)` line. `add(p, size)` already passes a `Product`; the cart now resolves `variantId`. `clusterImg = CLUSTERS[p.cluster]` unchanged.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Expected: juices routes clean.

- [ ] **Step 4: Commit**

```bash
git add apps/customer/src/routes/juices.index.tsx apps/customer/src/routes/juices.$id.tsx
git commit -m "feat(customer): juices list + detail load from API"
```

### Task 1.4: Shop single-bottles grid from API

**Files:**
- Modify: `apps/customer/src/routes/shop.tsx`

- [ ] **Step 1:** Replace `import { products, getFruitFor } from "@/data/products";` with:
```tsx
import { getFruitFor } from "@/lib/visuals";
import { fetchProducts } from "@/lib/api/server-fns";
```
Add a loader (bundles wired in Task 4.8; for now load products):
```tsx
  loader: async () => ({ products: await fetchProducts() }),
```
At the top of `function Page()`:
```tsx
  const { products } = Route.useLoaderData();
```
`products.slice(0, 8)` and `getFruitFor(p.id, p.cluster)` work unchanged.

- [ ] **Step 2: Commit**

```bash
git add apps/customer/src/routes/shop.tsx
git commit -m "feat(customer): shop single-bottle grid loads from API"
```

### Task 1.5: Reduce `data/products.ts` to nothing (delete) once unreferenced

**Files:**
- Delete: `apps/customer/src/data/products.ts`

- [ ] **Step 1: Confirm no remaining imports**

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Then grep for stragglers:
Use Grep tool: pattern `@/data/products`, path `apps/customer/src`. Expected: no matches (every consumer migrated to `@/lib/visuals` for images/types and `@/lib/api/mappers` for the `Product` type). If any component (e.g. `Hero.tsx`, `ProductCard.tsx`, `ProductDetail.tsx`, `Categories.tsx`) still imports it, switch its type import to `@/lib/api/mappers` and image/`Size`/`CLUSTERS` imports to `@/lib/visuals`, then re-grep.

- [ ] **Step 2: Delete the file**

```bash
git rm apps/customer/src/data/products.ts
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm --filter @ms/customer exec tsc --noEmit` → PASS
```bash
git add -A
git commit -m "refactor(customer): remove static products data; API is the source"
```

---

## Milestone 2 — Blog: schema, API, admin, seed, frontend

### Task 2.1: Migration — blog content fields

**Files:**
- Create: `packages/db/migrations/0039_blog_content_fields.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Blog marketing fields the static frontend had but the DB lacked: a display
-- author name (distinct from author_user_id), reading time, a category label,
-- and the decoration cluster the hero uses. All nullable so existing rows and
-- the admin write path keep working.
ALTER TABLE "blog_post"
  ADD COLUMN "author"    text,
  ADD COLUMN "read_mins" integer,
  ADD COLUMN "category"  text,
  ADD COLUMN "cluster"   text;
```

- [ ] **Step 2: Apply locally** (assumes `DATABASE_URL` exported per `[[reference_local_run]]`)

Run: `pnpm --filter @ms/db migrate`
Expected: applies 0039 without error.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0039_blog_content_fields.sql
git commit -m "feat(db): blog_post author/read_mins/category/cluster columns"
```

### Task 2.2: Schema — blog-post columns

**Files:**
- Modify: `packages/db/src/schema/blog-post.ts`

- [ ] **Step 1:** Add the columns to the Drizzle table. Insert after the `bodyMd` line and before `coverUrl`:
```ts
    author: text("author"),
    readMins: integer("read_mins"),
    category: text("category"),
    cluster: text("cluster"),
```
Update the import on line 1 to include `integer`:
```ts
import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @ms/db exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/blog-post.ts
git commit -m "feat(db): blog_post schema gains author/read_mins/category/cluster"
```

### Task 2.3: Public blog API returns the new fields (TDD)

**Files:**
- Modify: `apps/api/src/routes/public-blog.ts`
- Test: `apps/api/test/integration/public-blog-fields.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors `public-cart.test.ts` harness; seeds a post directly via the db handle from `setupTestDb`)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner } from "./helpers.js";
import { blogPost } from "@ms/db";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public blog content fields", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;

    await db.insert(blogPost).values({
      slug: "field-test",
      title: "Field Test",
      excerpt: "x",
      bodyMd: "## Heading\n\nBody.",
      author: "Mrs. Samuel",
      readMins: 5,
      category: "Wellness",
      cluster: "root",
      publishedAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("list includes author/read_mins/category/cluster", async () => {
    const res = await fetch(`${baseUrl}/v1/public/blog`);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    const post = data.find((p) => p["slug"] === "field-test")!;
    expect(post["author"]).toBe("Mrs. Samuel");
    expect(post["read_mins"]).toBe(5);
    expect(post["category"]).toBe("Wellness");
    expect(post["cluster"]).toBe("root");
  });

  it("detail includes the same fields plus body_md", async () => {
    const res = await fetch(`${baseUrl}/v1/public/blog/field-test`);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data["author"]).toBe("Mrs. Samuel");
    expect(data["read_mins"]).toBe(5);
    expect(data["category"]).toBe("Wellness");
    expect(data["cluster"]).toBe("root");
    expect(data["body_md"]).toContain("Heading");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ms/api test -- test/integration/public-blog-fields.test.ts`
Expected: FAIL — `author`/`read_mins` undefined.

- [ ] **Step 3: Add the fields to both responses.** In `public-blog.ts`, expand the list `.select({...})` to add:
```ts
        author: blogPost.author,
        readMins: blogPost.readMins,
        category: blogPost.category,
        cluster: blogPost.cluster,
```
and map keys to snake_case in the list (the list currently returns the select object directly — change it to map explicitly):
```ts
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        excerpt: r.excerpt,
        cover_url: r.coverUrl,
        published_at: r.publishedAt,
        author: r.author,
        read_mins: r.readMins,
        category: r.category,
        cluster: r.cluster,
      })),
    });
```
(Adjust the `.select` keys to `coverUrl: blogPost.coverUrl, publishedAt: blogPost.publishedAt` as already present.)

In the `/:slug` detail response add to the returned `data` object:
```ts
        author: row.author,
        read_mins: row.readMins,
        category: row.category,
        cluster: row.cluster,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @ms/api test -- test/integration/public-blog-fields.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-blog.ts apps/api/test/integration/public-blog-fields.test.ts
git commit -m "feat(api): public blog returns author/read_mins/category/cluster"
```

### Task 2.4: Admin blog write path preserves new fields

**Files:**
- Modify: `apps/api/src/routes/blog.ts`
- Modify: `apps/admin/src/routes/owner/blog.tsx`

- [ ] **Step 1: API — extend zod + insert/patch.** In `blog.ts` add to `CreatePost`:
```ts
  author: z.string().max(120).nullable().optional(),
  read_mins: z.number().int().positive().max(120).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  cluster: z.string().max(40).nullable().optional(),
```
Add the same four (all `.optional()`) to `PatchPost`. In the POST `.values({...})` add:
```ts
        author: body.author ?? null,
        readMins: body.read_mins ?? null,
        category: body.category ?? null,
        cluster: body.cluster ?? null,
```
In the PATCH `patch` builder add:
```ts
    if (body.author !== undefined) patch["author"] = body.author;
    if (body.read_mins !== undefined) patch["readMins"] = body.read_mins;
    if (body.category !== undefined) patch["category"] = body.category;
    if (body.cluster !== undefined) patch["cluster"] = body.cluster;
```

- [ ] **Step 2: Admin editor — add the four inputs.** In `owner/blog.tsx`:
  - Extend the `Post` interface with `author: string | null; readMins: number | null; category: string | null; cluster: string | null;`.
  - In `PostForm`, add state: `const [author, setAuthor] = useState(post?.author ?? "");` and likewise `readMins` (string), `category`, `cluster`.
  - Add form fields after the Excerpt field (a text input for Author, a number input for Read minutes, a text input for Category, and a `<select>` for Cluster with options `citrus|berry|tropical|green|root|watermelon`).
  - Include them in both the create and edit `JSON.stringify` bodies:
```ts
            author: author || null,
            read_mins: readMins ? Number(readMins) : null,
            category: category || null,
            cluster: cluster || null,
```

- [ ] **Step 3: Typecheck both apps**

Run: `pnpm --filter @ms/api exec tsc --noEmit && pnpm --filter @ms/admin exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/blog.ts apps/admin/src/routes/owner/blog.tsx
git commit -m "feat(blog): admin create/edit manages author/read_mins/category/cluster"
```

### Task 2.5: Seed the 6 real posts (markdown-converted) with fields

**Files:**
- Modify: `packages/db/src/seed.ts`

> Replace the existing placeholder `BLOG_POSTS` array content with the 6 real posts from the (about-to-be-deleted) `blogPosts.ts`, converting each `body[]` to markdown and carrying the new fields.

- [ ] **Step 1: Replace the `BLOG_POSTS` constant** with the 6 real posts. Each entry shape:
```ts
const BLOG_POSTS: Array<{
  slug: string; title: string; excerpt: string;
  author: string; readMins: number; category: string; cluster: string;
  bodyMd: string; coverUrl: string | null;
}> = [
  {
    slug: "why-we-cold-press-at-sunrise",
    title: "Why we cold-press before the sun is fully up",
    excerpt:
      "There's a reason the first bottle of the day tastes different. We press while the city is still quiet — and the fruit is still cold.",
    author: "Mrs. Samuel", readMins: 4, category: "Story", cluster: "citrus",
    coverUrl: null,
    bodyMd: [
      "By 5:30am the kitchen is already humming. The market run finished an hour ago. Pineapples are being trimmed. Beetroots are being washed twice — once for the soil, once for peace of mind.",
      "## Heat is the enemy of nutrients",
      "Cold-pressing is slower. It costs more. But it keeps the enzymes alive — the same enzymes that make pineapple actually feel like it's helping your digestion, not just satisfying your taste buds.",
      "By 9am, the first crates are out for delivery. Bottles you receive that morning were fruit on a tree the day before.",
      "> If you wouldn't drink it cloudy by lunchtime, we won't bottle it at sunrise.",
      "It's a small promise. But it's why every bottle has a press date — not just an expiry.",
    ].join("\n\n"),
  },
  // ...repeat for the remaining 5 posts from blogPosts.ts, converting each
  // body block: type "h" -> "## " + text, type "quote" -> "> " + text,
  // type "p" -> text; join all blocks with "\n\n".
];
```
Convert the other five posts (`nigerian-fruit-waste-story`, `beetroot-the-misunderstood-hero`, `mrs-samuels-morning-ritual`, `why-glass-not-plastic`, `behind-one-bottle-sunrise-blend`) the same way, preserving `author`/`readMins`/`category`/`cover`→`cluster`.

- [ ] **Step 2: Update `seedBlogPosts()` insert** to write the new fields:
```ts
      await db.insert(blogPost).values({
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        bodyMd: post.bodyMd,
        coverUrl: post.coverUrl,
        author: post.author,
        readMins: post.readMins,
        category: post.category,
        cluster: post.cluster,
        authorUserId: authorId,
        publishedAt,
      });
```

- [ ] **Step 3: Re-seed locally and verify**

Run: `pnpm --filter @ms/db seed`
Then: `curl -s http://localhost:8787/v1/public/blog | jq '.data[0]'`
Expected: a real post with `author`, `read_mins`, `category`, `cluster` populated.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "feat(db): seed the 6 real blog posts as markdown with content fields"
```

### Task 2.6: Markdown block renderer

**Files:**
- Create: `apps/customer/src/lib/markdown.tsx`

- [ ] **Step 1: Write a minimal block renderer** matching today's styling (h2 / blockquote / paragraph). Sufficient for the seeded content (no inline markdown is used).

```tsx
// apps/customer/src/lib/markdown.tsx
import type { ReactNode } from "react";

/**
 * Render a markdown string limited to the blocks our content uses: ## headings,
 * > blockquotes, and paragraphs (separated by blank lines). Faithful to the
 * previous structured-body styling; intentionally NOT a full markdown parser.
 */
export function renderMarkdown(md: string): ReactNode[] {
  const blocks = md.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, i) => {
    if (block.startsWith("## ")) {
      return (
        <h2 key={i} className="font-display text-2xl sm:text-3xl text-[color:var(--brand)] mt-10">
          {block.slice(3).trim()}
        </h2>
      );
    }
    if (block.startsWith("> ")) {
      return (
        <blockquote
          key={i}
          className="my-8 border-l-4 border-[color:var(--brand-orange)] pl-5 font-display text-xl sm:text-2xl text-[color:var(--brand)] italic"
        >
          "{block.slice(2).trim()}"
        </blockquote>
      );
    }
    return <p key={i}>{block}</p>;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/customer/src/lib/markdown.tsx
git commit -m "feat(customer): minimal markdown block renderer for blog bodies"
```

### Task 2.7: Blog list + detail + home teaser from API

**Files:**
- Modify: `apps/customer/src/routes/blog.index.tsx`
- Modify: `apps/customer/src/routes/blog.$slug.tsx`
- Modify: `apps/customer/src/components/Blog.tsx`

- [ ] **Step 1: `blog.index.tsx`** — replace `import { posts } from "@/data/blogPosts";` and `import { CLUSTERS } from "@/data/products";` with:
```tsx
import { CLUSTERS } from "@/lib/visuals";
import { fetchBlogPosts } from "@/lib/api/server-fns";
```
Add a loader:
```tsx
  loader: async () => ({ posts: await fetchBlogPosts() }),
```
In `function Page()` add `const { posts } = Route.useLoaderData();` at the top. `CLUSTERS[p.cover as keyof typeof CLUSTERS]` works — `cover` is now the cluster string from the API.

- [ ] **Step 2: `blog.$slug.tsx`** — replace `import { getPost, posts } from "@/data/blogPosts";` and `import { CLUSTERS } from "@/data/products";` with:
```tsx
import { CLUSTERS } from "@/lib/visuals";
import { fetchBlogPost, fetchBlogPosts } from "@/lib/api/server-fns";
import { renderMarkdown } from "@/lib/markdown";
```
Replace the loader:
```tsx
  loader: async ({ params }) => {
    const [post, all] = await Promise.all([
      fetchBlogPost({ data: params.slug }),
      fetchBlogPosts(),
    ]);
    return { post, related: all.filter((x) => x.slug !== post.slug && x.category === post.category).slice(0, 2) };
  },
```
Update `head` to read `loaderData?.post`. In `function Page()`:
```tsx
  const { post: p, related } = Route.useLoaderData();
```
Delete the `related` const that filtered the static `posts`. Replace the body renderer (the `{p.body.map(...)}` block) with:
```tsx
          {renderMarkdown(p.bodyMd)}
```

- [ ] **Step 3: `components/Blog.tsx`** (home teaser) — it imports `posts` from `@/data/blogPosts`. Convert it to a prop-driven component: accept `posts: BlogPostSummary[]` as a prop and have `index.tsx` pass `posts.slice(0,3)`-style data. Concretely:
  - In `Blog.tsx`, replace the static import with `import type { BlogPostSummary } from "@/lib/api/mappers";` and `import { CLUSTERS } from "@/lib/visuals";`, change the component signature to `export function Blog({ posts }: { posts: BlogPostSummary[] }) {`.
  - In `index.tsx`, the loader must also provide blog posts. Update the loader to:
```tsx
  loader: async () => {
    const [products, posts] = await Promise.all([fetchProducts(), fetchBlogPosts()]);
    return { products, posts };
  },
```
  (add `import { fetchBlogPosts } from "@/lib/api/server-fns";`), then pass `<Blog posts={posts} />` where `<Blog />` is currently rendered, reading `const { products, posts } = Route.useLoaderData();`.

- [ ] **Step 4: Delete `data/blogPosts.ts`**

Grep `@/data/blogPosts` under `apps/customer/src` → expect no matches, then:
```bash
git rm apps/customer/src/data/blogPosts.ts
```

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @ms/customer exec tsc --noEmit` → PASS
```bash
git add -A
git commit -m "feat(customer): blog list/detail/home teaser load from API; drop static posts"
```

---

## Milestone 3 — Real checkout + order tracking

### Task 3.1: Rebuild `checkout.tsx` on the real pipeline

**Files:**
- Modify: `apps/customer/src/routes/checkout.tsx`

> The new flow: **Details** (collect name/phone/email/address, fetch live quote) → choose a courier option (or ₦0 when none) → **Place order** (server-fn → reserves stock + OPay URL) → **redirect to OPay**. The OPay return URL (`/order/:orderNumber?paid=1`) is the tracking page built in Task 3.2. Branch comes from `fetchBranches()` (first active branch).

- [ ] **Step 1: Add a loader for the branch** to the route:
```tsx
import { fetchBranches } from "@/lib/api/server-fns";
// ...
  loader: async () => ({ branches: await fetchBranches() }),
```

- [ ] **Step 2: Replace the fake `placeOrder` + delivery math** with real logic. Key changes inside `function Page()`:
  - Import the write server-fns + a uuid for the idempotency key:
```tsx
import { requestQuote, placeOrder } from "@/lib/api/server-fns";
import type { ApiDeliveryOption } from "@/lib/api/types";
```
  - State for quote + selection + submitting:
```tsx
  const { branches } = Route.useLoaderData();
  const branchId = branches[0]?.id ?? "";
  const [options, setOptions] = useState<ApiDeliveryOption[]>([]);
  const [quoteNotice, setQuoteNotice] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ApiDeliveryOption | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const delivery = chosen?.fee_ngn ?? 0;
  const total = subtotal + delivery;
```
  - A `loadQuote()` triggered when leaving the Details step (or on address blur):
```tsx
  async function loadQuote() {
    if (!branchId || !form.address) return;
    try {
      const q = await requestQuote({ data: { branch_id: branchId, dropoff_address: form.address, delivery_state: form.city } });
      setOptions(q.options);
      setChosen(q.options[0] ?? null);
      setQuoteNotice(q.options.length === 0 ? (q.notice ?? "No delivery charge applied.") : null);
    } catch {
      setOptions([]); setChosen(null);
      setQuoteNotice("Live delivery pricing is unavailable — no delivery charge applied.");
    }
  }
```
  - Replace the **Payment** step's static method list with the delivery-options chooser (radio list of `options` showing `courier_name` + `fee_ngn` + ETA; show `quoteNotice` when empty). Remove the "Card (coming soon)" copy.
  - Replace `placeOrder(items)` with:
```tsx
  async function submitOrder() {
    setPlacing(true); setPlaceError(null);
    try {
      const res = await placeOrder({
        data: {
          branch_id: branchId,
          delivery_fee_ngn: delivery,
          ...(chosen ? { delivery_quote_id: chosen.id } : {}),
          delivery_state: form.city,
          customer: { name: form.name, phone: form.phone, email: form.email || undefined, address: form.address },
          items: items.map((i) => ({ variant_id: i.variantId, quantity: i.qty })),
          notes: form.notes || undefined,
          idempotency_key: crypto.randomUUID(),
        },
      });
      clear();
      window.location.href = res.payment.authorization_url; // OPay (or mock URL in dev)
    } catch (err) {
      setPlaceError(err instanceof Error ? err.message : "Could not place your order. Please try again.");
      setPlacing(false);
    }
  }
```
  (`clear` comes from `useCart()`; add it to the destructure.)
  - The **Review** step's "Place order" button calls `submitOrder()` and shows `placeError` inline; disable while `placing`.
  - Delete the entire `step === "done"` branch and the `PlacedOrder` interface + `placed` state — completion now lives on the tracking page after the OPay round-trip.
  - Update the summary aside: `delivery === 0` shows the `quoteNotice` (or "Calculated at delivery") instead of the hardcoded "Free delivery over ₦20,000".

- [ ] **Step 3: Turnstile (optional, env-gated).** If `import.meta.env.VITE_TURNSTILE_SITE_KEY` is set, render the Cloudflare widget on the Review step and pass its token as `turnstile_token` in the `placeOrder` data. When unset, omit it (API fails open). Add a small client-only widget loader:
```tsx
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
```
  (Render `<div className="cf-turnstile" data-sitekey={turnstileSiteKey} />` + a `<script async src="https://challenges.cloudflare.com/turnstile/v0/api.js">` injected via a `useEffect`; read the token from the rendered input named `cf-turnstile-response`. If this proves fiddly, ship without the widget initially — the API fails open when `TURNSTILE_SECRET` is unset, and the prod cutover checklist re-enables it.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/customer/src/routes/checkout.tsx
git commit -m "feat(customer): real checkout — live quote, order create, OPay redirect"
```

### Task 3.2: Order tracking page (OPay return URL)

**Files:**
- Create: `apps/customer/src/routes/order.$orderNumber.tsx`

- [ ] **Step 1: Write the route.** It reads `?paid=1` for the success banner and asks for the phone to fetch tracking (the API requires phone to prevent enumeration). On submit, call `trackOrder`.

```tsx
import { useState } from "react";
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { SiteShell } from "@/components/SiteShell";
import { formatNaira } from "@/lib/cart";
import { trackOrder } from "@/lib/api/server-fns";
import type { ApiOrderTracking } from "@/lib/api/types";

export const Route = createFileRoute("/order/$orderNumber")({
  validateSearch: (s: Record<string, unknown>): { paid?: boolean } => ({ paid: s["paid"] === "1" || s["paid"] === true }),
  head: () => ({ meta: [{ title: "Your order — Mrs. Samuel Fruit Juice" }] }),
  component: Page,
});

function Page() {
  const { orderNumber } = Route.useParams();
  const { paid } = useSearch({ from: "/order/$orderNumber" });
  const [phone, setPhone] = useState("");
  const [order, setOrder] = useState<ApiOrderTracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      setOrder(await trackOrder({ data: { orderNumber, phone } }));
    } catch {
      setError("We couldn't find that order with that phone number.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <SiteShell>
      <div className="px-5 sm:px-10 max-w-2xl mx-auto pt-32 pb-24">
        {paid && (
          <div className="mb-6 rounded-2xl bg-[color:var(--brand-orange)]/10 p-5 text-[color:var(--brand)]">
            <h1 className="font-display text-3xl">Thank you — payment received.</h1>
            <p className="mt-1 text-sm text-[color:var(--brand)]/70">Order <span className="font-mono font-bold">{orderNumber}</span>. Enter your phone to see live status.</p>
          </div>
        )}
        {!order ? (
          <form onSubmit={lookup} className="rounded-2xl bg-white p-6 ring-1 ring-black/5">
            <h2 className="font-display text-2xl text-[color:var(--brand)]">Track order {orderNumber}</h2>
            <label className="mt-4 block text-sm font-semibold text-[color:var(--brand)]/70">Phone on the order</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+234…" required
              className="mt-1.5 w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-orange)]" />
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <button disabled={loading} className="mt-4 rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold disabled:opacity-50">
              {loading ? "Looking…" : "View status"}
            </button>
          </form>
        ) : (
          <div className="rounded-2xl bg-white p-6 ring-1 ring-black/5 space-y-3">
            <h2 className="font-display text-2xl text-[color:var(--brand)]">Order {order.order_number}</h2>
            <Row label="Status" value={order.status} />
            <Row label="Payment" value={order.payment_status} />
            <Row label="Subtotal" value={formatNaira(order.subtotal_ngn)} />
            <Row label="Delivery" value={order.delivery_fee_ngn === 0 ? "—" : formatNaira(order.delivery_fee_ngn)} />
            <Row label="Total" value={formatNaira(order.total_ngn)} />
            {order.delivery && (
              <div className="mt-3 rounded-xl bg-[color:var(--cream)]/60 p-4 text-sm">
                <div className="font-semibold text-[color:var(--brand)]">Delivery — {order.delivery.status}</div>
                {order.delivery.rider_name && <div className="text-[color:var(--brand)]/70">Rider: {order.delivery.rider_name} · {order.delivery.rider_phone}</div>}
                {order.delivery.eta_minutes != null && <div className="text-[color:var(--brand)]/70">ETA ~{order.delivery.eta_minutes} min</div>}
                {order.delivery.tracking_url && <a className="text-[color:var(--brand-orange)] font-semibold" href={order.delivery.tracking_url} target="_blank" rel="noreferrer">Live tracking →</a>}
              </div>
            )}
            <Link to="/juices" className="mt-2 inline-flex rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold">Order more</Link>
          </div>
        )}
      </div>
    </SiteShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-black/5 pb-2 text-sm">
      <span className="text-[color:var(--brand)]/60">{label}</span>
      <span className="font-semibold text-[color:var(--brand)] capitalize">{value}</span>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** (route tree regenerates on dev/build)

Run: `pnpm --filter @ms/customer exec tsc --noEmit`
Expected: PASS (after `routeTree.gen` updates — run `pnpm --filter @ms/customer dev` once or the router plugin's generate step if tsc complains about the missing route id).

- [ ] **Step 3: Commit**

```bash
git add apps/customer/src/routes/order.$orderNumber.tsx
git commit -m "feat(customer): order tracking page (OPay return target)"
```

---

## Milestone 4 — New backends (contact, subscription, bundles)

### Task 4.1: Migration — storefront marketing tables

**Files:**
- Create: `packages/db/migrations/0040_storefront_marketing.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Storefront marketing + lead capture: bundles and subscription plans served
-- read-only to the site (WhatsApp CTA), plus lead tables for contact-form and
-- subscription enquiries. Display rows are owner-seeded; lead rows are written
-- by the public site and also emit outbox events.

CREATE TABLE "contact_message" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       text NOT NULL,
  "email"      text NOT NULL,
  "phone"      text,
  "subject"    text NOT NULL,
  "message"    text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "subscription_plan" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"          text NOT NULL UNIQUE,
  "name"          text NOT NULL,
  "price_ngn"     integer NOT NULL,
  "period"        text NOT NULL,
  "bottles_label" text,
  "description"   text,
  "perks"         jsonb NOT NULL DEFAULT '[]'::jsonb,
  "popular"       boolean NOT NULL DEFAULT false,
  "display_order" integer NOT NULL DEFAULT 0,
  "is_active"     boolean NOT NULL DEFAULT true,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "subscription_lead" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       text NOT NULL,
  "phone"      text NOT NULL,
  "plan_slug"  text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "bundle" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"           text NOT NULL UNIQUE,
  "name"           text NOT NULL,
  "price_ngn"      integer NOT NULL,
  "description"    text,
  "contents_label" text,
  "badge"          text,
  "image_url"      text,
  "display_order"  integer NOT NULL DEFAULT 0,
  "is_active"      boolean NOT NULL DEFAULT true,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Apply + commit**

Run: `pnpm --filter @ms/db migrate`
```bash
git add packages/db/migrations/0040_storefront_marketing.sql
git commit -m "feat(db): contact_message/subscription_plan/subscription_lead/bundle tables"
```

### Task 4.2: Drizzle schemas + index export

**Files:**
- Create: `packages/db/src/schema/contact-message.ts`, `subscription-plan.ts`, `subscription-lead.ts`, `bundle.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the four schema modules**

```ts
// contact-message.ts
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
export const contactMessage = pgTable("contact_message", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// subscription-plan.ts
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
export const subscriptionPlan = pgTable("subscription_plan", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceNgn: integer("price_ngn").notNull(),
  period: text("period").notNull(),
  bottlesLabel: text("bottles_label"),
  description: text("description"),
  perks: jsonb("perks").notNull().default([]).$type<string[]>(),
  popular: boolean("popular").notNull().default(false),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// subscription-lead.ts
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
export const subscriptionLead = pgTable("subscription_lead", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  planSlug: text("plan_slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// bundle.ts
import { pgTable, uuid, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
export const bundle = pgTable("bundle", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceNgn: integer("price_ngn").notNull(),
  description: text("description"),
  contentsLabel: text("contents_label"),
  badge: text("badge"),
  imageUrl: text("image_url"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Export them** — add to `schema/index.ts`:
```ts
export * from "./contact-message.js";
export * from "./subscription-plan.js";
export * from "./subscription-lead.js";
export * from "./bundle.js";
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm --filter @ms/db exec tsc --noEmit` → PASS
```bash
git add packages/db/src/schema/
git commit -m "feat(db): drizzle schemas for marketing + lead tables"
```

### Task 4.3: Seed bundles + subscription plans

**Files:**
- Create: `packages/db/src/seed-data/storefront.json`
- Modify: `packages/db/src/seed.ts`

- [ ] **Step 1: Write the seed data** (the 4 bundles from `shop.tsx` + the 3 plans from `subscription.tsx`)

```json
{
  "bundles": [
    { "slug": "starter-6", "name": "Starter 6-Pack", "price_ngn": 14000, "description": "Six bottles, your pick of any classic flavours. The easiest way to discover a new favourite.", "contents_label": "6 × 330ml", "badge": "Most loved", "display_order": 1 },
    { "slug": "detox-12", "name": "Detox 12-Pack", "price_ngn": 27500, "description": "Twelve bottles built around our Detox, Immune Booster and Blood Booster. A clean two-week reset.", "contents_label": "12 × 330ml", "badge": "Reset", "display_order": 2 },
    { "slug": "family-20", "name": "Family 20-Pack", "price_ngn": 44000, "description": "Twenty bottles, mixed sizes — enough fresh juice for a household for two full weeks.", "contents_label": "20 × 330ml + 650ml", "badge": "Best value", "display_order": 3 },
    { "slug": "gift-box", "name": "Mrs. Samuel Gift Box", "price_ngn": 18500, "description": "Four Specials wrapped beautifully — Pink Paradise, Guyabano Delight and two seasonal picks. Birthdays. Baby showers. Sorry-I-missed-it.", "contents_label": "4 × 650ml + card", "badge": "Gift", "display_order": 4 }
  ],
  "subscription_plans": [
    { "slug": "weekly-juice-box", "name": "Weekly Juice Box", "price_ngn": 12500, "period": "/week", "bottles_label": "7 bottles", "description": "One bottle a day. Perfect to start a routine and keep it.", "perks": ["7 × 330ml weekly", "Skip any week", "5% off retail"], "popular": false, "display_order": 1 },
    { "slug": "monthly-detox", "name": "Monthly Detox Plan", "price_ngn": 42000, "period": "/month", "bottles_label": "20 bottles", "description": "Cleanse-focused — Detox, Immune Booster, Blood Booster on rotation.", "perks": ["20 × 330ml monthly", "Wellness call with Mrs. Samuel", "10% off + free delivery"], "popular": true, "display_order": 2 },
    { "slug": "family-package", "name": "Family Package", "price_ngn": 65000, "period": "/month", "bottles_label": "30 bottles", "description": "Mixed sizes, mixed flavours — enough fresh juice for a household.", "perks": ["30 bottles, mixed sizes", "Kid-friendly flavour priority", "12% off + free delivery"], "popular": false, "display_order": 3 }
  ]
}
```

- [ ] **Step 2: Add `seedStorefront()` to `seed.ts`** (idempotent find-or-insert by slug), import `bundle` + `subscriptionPlan`, read the JSON like `catalog.json`, and call it from `main()` after `seedBlogPosts()`:

```ts
import { bundle, subscriptionPlan } from "./schema/index.js";
// ...
interface StorefrontFile {
  bundles: Array<{ slug: string; name: string; price_ngn: number; description: string; contents_label: string; badge: string; display_order: number }>;
  subscription_plans: Array<{ slug: string; name: string; price_ngn: number; period: string; bottles_label: string; description: string; perks: string[]; popular: boolean; display_order: number }>;
}

async function seedStorefront(): Promise<void> {
  const data = JSON.parse(
    readFileSync(new URL("./seed-data/storefront.json", import.meta.url), "utf8"),
  ) as StorefrontFile;
  for (const b of data.bundles) {
    const [exists] = await db.select().from(bundle).where(eq(bundle.slug, b.slug)).limit(1);
    if (!exists) {
      await db.insert(bundle).values({
        slug: b.slug, name: b.name, priceNgn: b.price_ngn, description: b.description,
        contentsLabel: b.contents_label, badge: b.badge, displayOrder: b.display_order,
      });
    }
  }
  for (const p of data.subscription_plans) {
    const [exists] = await db.select().from(subscriptionPlan).where(eq(subscriptionPlan.slug, p.slug)).limit(1);
    if (!exists) {
      await db.insert(subscriptionPlan).values({
        slug: p.slug, name: p.name, priceNgn: p.price_ngn, period: p.period,
        bottlesLabel: p.bottles_label, description: p.description, perks: p.perks,
        popular: p.popular, displayOrder: p.display_order,
      });
    }
  }
  console.warn(`storefront seeded: ${data.bundles.length} bundles, ${data.subscription_plans.length} plans`);
}
```
Add `await seedStorefront();` to `main()`.

- [ ] **Step 3: Seed + commit**

Run: `pnpm --filter @ms/db seed`
```bash
git add packages/db/src/seed-data/storefront.json packages/db/src/seed.ts
git commit -m "feat(db): seed bundles + subscription plans"
```

### Task 4.4: Bundles + subscription-plans read endpoints (TDD)

**Files:**
- Modify: `apps/api/src/routes/public-catalog.ts`
- Test: `apps/api/test/integration/public-bundles.test.ts`, `public-subscriptions.test.ts`

- [ ] **Step 1: Write the failing bundles test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner } from "./helpers.js";
import { bundle, subscriptionPlan } from "@ms/db";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public bundles + subscription plans", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    await tdb.db.insert(bundle).values({ slug: "starter-6", name: "Starter 6-Pack", priceNgn: 14000, contentsLabel: "6 × 330ml", badge: "Most loved", displayOrder: 1 });
    await tdb.db.insert(subscriptionPlan).values({ slug: "weekly", name: "Weekly", priceNgn: 12500, period: "/week", perks: ["a", "b"], popular: false, displayOrder: 1 });
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => { server.close(); await container.stop(); });

  it("GET /v1/public/catalog/bundles returns active bundles", async () => {
    const res = await fetch(`${baseUrl}/v1/public/catalog/bundles`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ slug: string; price_ngn: number }> };
    expect(data[0]!.slug).toBe("starter-6");
    expect(data[0]!.price_ngn).toBe(14000);
  });

  it("GET /v1/public/catalog/subscription-plans returns active plans with perks", async () => {
    const res = await fetch(`${baseUrl}/v1/public/catalog/subscription-plans`);
    const { data } = (await res.json()) as { data: Array<{ slug: string; perks: string[] }> };
    expect(data[0]!.slug).toBe("weekly");
    expect(data[0]!.perks).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run → FAIL** (404, routes missing)

Run: `pnpm --filter @ms/api test -- test/integration/public-bundles.test.ts`

- [ ] **Step 3: Add the two read routes** to `public-catalog.ts`. Import `bundle, subscriptionPlan` and `asc`, then before `return r;`:
```ts
  r.get("/bundles", async (c) => {
    const rows = await db
      .select()
      .from(bundle)
      .where(eq(bundle.isActive, true))
      .orderBy(asc(bundle.displayOrder));
    return c.json({
      data: rows.map((b) => ({
        id: b.id, slug: b.slug, name: b.name, price_ngn: b.priceNgn,
        description: b.description, contents_label: b.contentsLabel,
        badge: b.badge, image_url: b.imageUrl,
      })),
    });
  });

  r.get("/subscription-plans", async (c) => {
    const rows = await db
      .select()
      .from(subscriptionPlan)
      .where(eq(subscriptionPlan.isActive, true))
      .orderBy(asc(subscriptionPlan.displayOrder));
    return c.json({
      data: rows.map((p) => ({
        id: p.id, slug: p.slug, name: p.name, price_ngn: p.priceNgn, period: p.period,
        bottles_label: p.bottlesLabel, description: p.description, perks: p.perks, popular: p.popular,
      })),
    });
  });
```
(Update the top import: `import { branch, bundle, subscriptionPlan, type DbClient } from "@ms/db";` and add `asc` to the drizzle import.)

- [ ] **Step 4: Run → PASS**, then commit

```bash
git add apps/api/src/routes/public-catalog.ts apps/api/test/integration/public-bundles.test.ts
git commit -m "feat(api): public bundles + subscription-plans read endpoints"
```

### Task 4.5: Contact endpoint (TDD)

**Files:**
- Create: `apps/api/src/routes/public-contact.ts`
- Modify: `apps/api/src/test-app.ts`
- Test: `apps/api/test/integration/public-contact.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner } from "./helpers.js";
import { contactMessage, outboxEvent } from "@ms/db";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public contact", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container; db = tdb.db;
    await seedOwner(db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => { server.close(); await container.stop(); });

  it("stores the message and emits a contact.message_received outbox event", async () => {
    const res = await fetch(`${baseUrl}/v1/public/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com", phone: "+2348012345678", subject: "Wholesale / B2B", message: "Need 200 bottles" }),
    });
    expect(res.status).toBe(201);
    const stored = await db.select().from(contactMessage).where(eq(contactMessage.email, "ada@example.com"));
    expect(stored.length).toBe(1);
    const events = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "contact.message_received"));
    expect(events.length).toBe(1);
  });

  it("rejects an invalid email with 400", async () => {
    const res = await fetch(`${baseUrl}/v1/public/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "X", email: "not-an-email", subject: "Press / partnership", message: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run → FAIL**

Run: `pnpm --filter @ms/api test -- test/integration/public-contact.test.ts`

- [ ] **Step 3: Write the route**

```ts
// apps/api/src/routes/public-contact.ts
import { Hono } from "hono";
import { z } from "zod";
import { contactMessage, outboxEvent, type DbClient } from "@ms/db";
import { rateLimit } from "../middleware/rate-limit.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { BusinessError } from "../lib/errors.js";
import { env } from "../env.js";

const ContactBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  subject: z.string().min(1).max(120),
  message: z.string().min(1).max(4000),
  turnstile_token: z.string().optional(),
});

export function publicContactRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 10, durationSeconds: 60, keyPrefix: "public-contact" }));

  r.post("/", async (c) => {
    const body = ContactBody.parse(await c.req.json());
    const human = await verifyTurnstileToken(env.TURNSTILE_SECRET, body.turnstile_token, c.req.header("cf-connecting-ip") ?? undefined);
    if (!human) throw new BusinessError("validation_failed", "Bot check failed — please retry.", 400);

    const [row] = await db.insert(contactMessage).values({
      name: body.name, email: body.email, phone: body.phone ?? null,
      subject: body.subject, message: body.message,
    }).returning();
    if (!row) throw new BusinessError("internal_error", "contact insert failed", 500);

    await db.insert(outboxEvent).values({
      eventType: "contact.message_received",
      payload: { contact_id: row.id, name: body.name, email: body.email, phone: body.phone ?? null, subject: body.subject },
    });
    return c.json({ data: { ok: true } }, 201);
  });

  return r;
}
```

- [ ] **Step 4: Mount it** in `test-app.ts`: add `import { publicContactRoutes } from "./routes/public-contact.js";` and `app.route("/v1/public/contact", publicContactRoutes(db));` in the public block.

- [ ] **Step 5: Run → PASS**, commit

```bash
git add apps/api/src/routes/public-contact.ts apps/api/src/test-app.ts apps/api/test/integration/public-contact.test.ts
git commit -m "feat(api): public contact endpoint — store + outbox event"
```

### Task 4.6: Subscription lead endpoint (TDD)

**Files:**
- Create: `apps/api/src/routes/public-subscriptions.ts`
- Modify: `apps/api/src/test-app.ts`
- Test: `apps/api/test/integration/public-subscriptions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner } from "./helpers.js";
import { subscriptionLead, outboxEvent } from "@ms/db";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public subscription leads", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container; db = tdb.db;
    await seedOwner(db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => { server.close(); await container.stop(); });

  it("stores the lead and emits a subscription.requested outbox event", async () => {
    const res = await fetch(`${baseUrl}/v1/public/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "Ada", phone: "+2348012345678", plan_slug: "monthly-detox" }),
    });
    expect(res.status).toBe(201);
    const leads = await db.select().from(subscriptionLead).where(eq(subscriptionLead.planSlug, "monthly-detox"));
    expect(leads.length).toBe(1);
    const events = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "subscription.requested"));
    expect(events.length).toBe(1);
  });

  it("rejects a too-short phone with 400", async () => {
    const res = await fetch(`${baseUrl}/v1/public/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "X", phone: "123", plan_slug: "weekly-juice-box" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write the route**

```ts
// apps/api/src/routes/public-subscriptions.ts
import { Hono } from "hono";
import { z } from "zod";
import { subscriptionLead, outboxEvent, type DbClient } from "@ms/db";
import { rateLimit } from "../middleware/rate-limit.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { BusinessError } from "../lib/errors.js";
import { env } from "../env.js";

const LeadBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(7).max(40),
  plan_slug: z.string().min(1).max(80),
  turnstile_token: z.string().optional(),
});

export function publicSubscriptionRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 10, durationSeconds: 60, keyPrefix: "public-subscriptions" }));

  r.post("/", async (c) => {
    const body = LeadBody.parse(await c.req.json());
    const human = await verifyTurnstileToken(env.TURNSTILE_SECRET, body.turnstile_token, c.req.header("cf-connecting-ip") ?? undefined);
    if (!human) throw new BusinessError("validation_failed", "Bot check failed — please retry.", 400);

    const [row] = await db.insert(subscriptionLead).values({
      name: body.name, phone: body.phone, planSlug: body.plan_slug,
    }).returning();
    if (!row) throw new BusinessError("internal_error", "lead insert failed", 500);

    await db.insert(outboxEvent).values({
      eventType: "subscription.requested",
      payload: { lead_id: row.id, name: body.name, phone: body.phone, plan_slug: body.plan_slug },
    });
    return c.json({ data: { ok: true } }, 201);
  });

  return r;
}
```

- [ ] **Step 4: Mount** in `test-app.ts`: `import { publicSubscriptionRoutes } from "./routes/public-subscriptions.js";` + `app.route("/v1/public/subscriptions", publicSubscriptionRoutes(db));`

- [ ] **Step 5: Run → PASS**, commit

```bash
git add apps/api/src/routes/public-subscriptions.ts apps/api/src/test-app.ts apps/api/test/integration/public-subscriptions.test.ts
git commit -m "feat(api): public subscription lead endpoint — store + outbox event"
```

### Task 4.7: Worker outbox formatter cases

**Files:**
- Modify: `apps/worker/src/outbox.ts`

- [ ] **Step 1: Add two `case`s** to `format()` before the `default:`:
```ts
    case "contact.message_received":
      return {
        chatIds: [owner],
        text:
          `✉️ *New contact message*\n` +
          `${p["name"]} · ${p["subject"]}\n` +
          `${p["email"]}${p["phone"] ? ` · ${p["phone"]}` : ""}`,
      };
    case "subscription.requested":
      return {
        chatIds: [owner],
        text:
          `🔔 *Subscription enquiry*\n` +
          `${p["name"]} · ${p["phone"]}\n` +
          `Plan: ${p["plan_slug"]}`,
      };
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm --filter @ms/worker exec tsc --noEmit` → PASS
```bash
git add apps/worker/src/outbox.ts
git commit -m "feat(worker): Telegram formatters for contact + subscription events"
```

### Task 4.8: Wire shop bundles, subscription, contact pages to the API

**Files:**
- Modify: `apps/customer/src/routes/shop.tsx`
- Modify: `apps/customer/src/routes/subscription.tsx`
- Modify: `apps/customer/src/routes/contact.tsx`
- Modify: `apps/customer/src/components/Subscription.tsx` (home teaser, if it imports static plans)

- [ ] **Step 1: `shop.tsx` bundles** — extend the loader to also fetch bundles:
```tsx
import { fetchProducts, fetchBundles } from "@/lib/api/server-fns";
// loader:
  loader: async () => {
    const [products, bundles] = await Promise.all([fetchProducts(), fetchBundles()]);
    return { products, bundles };
  },
```
Delete the static `const bundles = [...]` array. In `Page()` read `const { products, bundles } = Route.useLoaderData();`. The bundle card markup already maps `b.name/b.price/b.desc/b.items/b.badge` — these field names match the `toUiBundle` output, so only the WhatsApp link's `formatNaira(b.price)` stays valid.

- [ ] **Step 2: `subscription.tsx`** — load plans + post a lead on CTA:
```tsx
import { fetchSubscriptionPlans, requestSubscription } from "@/lib/api/server-fns";
// loader:
  loader: async () => ({ plans: await fetchSubscriptionPlans() }),
```
Delete the static `const plans = [...]`. In `Page()`: `const { plans } = Route.useLoaderData();`. The card uses `p.name/p.bottles/p.desc/p.price/p.period/p.perks/p.popular` — matches `toUiPlan`. Change the CTA `<a>` to also fire the lead before opening WhatsApp (keep the WhatsApp navigation):
```tsx
  onClick={() => { void requestSubscription({ data: { name: "Website visitor", phone: "n/a", plan_slug: p.slug } }); }}
```
> Note: the CTA has no form fields, so we post a minimal lead (name/phone placeholders) purely to register interest; the WhatsApp thread captures real details. The API requires `phone.min(7)` — send the plan name as context and a placeholder that satisfies validation, e.g. `phone: "0000000"`. Keep the `href` WhatsApp link intact so behaviour is unchanged for the user.

- [ ] **Step 3: `contact.tsx`** — real submit via server-fn. Convert the uncontrolled form to controlled state (name/email/phone/subject/message), and replace the `onSubmit`:
```tsx
import { sendContactMessage } from "@/lib/api/server-fns";
// inside Page():
  const [form, setForm] = useState({ name: "", email: "", phone: "", subject: "", message: "" });
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true); setErr(null);
    try {
      await sendContactMessage({ data: { name: form.name, email: form.email, phone: form.phone || undefined, subject: form.subject, message: form.message } });
      setSent(true);
    } catch {
      setErr("Could not send your message. Please WhatsApp us instead.");
    } finally {
      setSending(false);
    }
  }
```
Bind each input to `form` via `value`/`onChange`, wire the `<form onSubmit={onSubmit}>`, show `err`, and disable the submit button while `sending`. Keep the existing success UI (`sent`).

- [ ] **Step 4: Home `Subscription.tsx` teaser** — if it imports static plan data, switch it to take a `plans` prop from the home loader (same pattern as `Blog.tsx` in Task 2.7); if it's purely decorative copy with no plan list, leave it untouched. Verify with a grep for `@/data/` inside the component.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @ms/customer exec tsc --noEmit` → PASS
```bash
git add apps/customer/src/routes/shop.tsx apps/customer/src/routes/subscription.tsx apps/customer/src/routes/contact.tsx apps/customer/src/components/Subscription.tsx
git commit -m "feat(customer): shop/subscription/contact pages use live API"
```

---

## Milestone 5 — Config / env

### Task 5.1: Customer env + deploy config

**Files:**
- Create/modify: `apps/customer/.env.example`, `.env.production.example`
- Modify: deploy compose / env for the customer service (per `[[project_mrs_samuel_deployment]]`)

- [ ] **Step 1: Document the env vars.** Add to `apps/customer/.env.example`:
```
# Base URL of the Mrs. Samuel API (used by server functions; never sent to the browser)
VITE_API_URL=http://localhost:8787
# Cloudflare Turnstile site key for the checkout/contact bot check (optional in dev)
VITE_TURNSTILE_SITE_KEY=
```
And `apps/customer/.env.production.example`:
```
VITE_API_URL=https://api.mrssamuel.com
VITE_TURNSTILE_SITE_KEY=__set_in_prod__
```

- [ ] **Step 2: Wire the value into the deployed customer container.** Locate the compose/systemd unit that runs the customer `.output/server/index.mjs` and ensure `VITE_API_URL` is present at **build** time (Vite inlines it). If the customer image is built in CI/compose, add `VITE_API_URL` as a build arg/env. Document this in the deploy notes file. (No secret is involved — the API base is public; Turnstile **site** key is public too. The Turnstile **secret** already lives only in the API env.)

- [ ] **Step 3: Commit**

```bash
git add apps/customer/.env.example apps/customer/.env.production.example
git commit -m "chore(customer): document VITE_API_URL + Turnstile site key"
```

---

## Milestone 6 — Verification

### Task 6.1: Full quality gates

- [ ] **Step 1: Lint + typecheck the touched packages**

Run: `pnpm -r --filter @ms/customer --filter @ms/api --filter @ms/db --filter @ms/worker --filter @ms/admin exec tsc --noEmit`
Run: `pnpm --filter @ms/customer lint && pnpm --filter @ms/api lint`
Expected: 0 errors (baseline per `[[reference_quality_gates]]`).

- [ ] **Step 2: Run the new API tests solo** (per `[[reference_quality_gates]]`, run new files alone to avoid false testcontainer hook timeouts)

Run each individually:
```
pnpm --filter @ms/api test -- test/integration/public-blog-fields.test.ts
pnpm --filter @ms/api test -- test/integration/public-bundles.test.ts
pnpm --filter @ms/api test -- test/integration/public-contact.test.ts
pnpm --filter @ms/api test -- test/integration/public-subscriptions.test.ts
```
Expected: all PASS.

Run: `pnpm --filter @ms/customer test`
Expected: mappers + client suites PASS.

### Task 6.2: Manual Playwright smoke (per `[[reference_local_run]]`)

> Static audits miss render crashes — drive the CTAs.

- [ ] **Step 1: Boot the stack** (standalone pg/redis with published ports; export `DATABASE_URL`; migrate; seed; start API on 8787; start customer dev with `VITE_API_URL=http://localhost:8787`).

- [ ] **Step 2: Drive the happy paths** with Playwright (or by hand):
  1. Home renders products + blog teaser (no console error).
  2. `/juices` lists flavours from the API; open a product; **Add to cart**; cart shows the line with the right price.
  3. `/checkout` → fill details → a delivery quote appears (or the ₦0 notice) → **Place order** → browser is redirected to the OPay (mock) URL.
  4. Visit `/order/<orderNumber>?paid=1` → enter the phone used → tracking shows status/payment_status/totals.
  5. `/blog` lists posts; open one → markdown body renders with headings + a blockquote.
  6. `/shop` shows bundles from the API; `/subscription` shows plans; CTA opens WhatsApp.
  7. `/contact` → submit → success UI; confirm a `contact_message` row + a `contact.message_received` outbox row exist.

- [ ] **Step 3: Record results** in the PR description. Do NOT cut over production OPay until a real (non-mock) order has been placed end-to-end against staging keys and the OPay callback URL is registered (tracked in `[[project_mrs_samuel_payments]]`).

---

## Production cutover checklist (out of band — do not run as part of the merge)

- [ ] Set `VITE_API_URL=https://api.mrssamuel.com` for the customer build and rebuild the image; hard-refresh / clear SW (`[[reference_admin_pwa_cache]]`).
- [ ] Set `VITE_TURNSTILE_SITE_KEY` (prod) and confirm `TURNSTILE_SECRET` is set on the API; re-enable the widget if shipped disabled.
- [ ] Verify OPay live keys + callback URL `https://api.mrssamuel.com/v1/webhooks/opay` registered; place one real order and confirm the webhook flips `payment_status` and the tracking page reflects it.
- [ ] Confirm the worker is draining outbox (owner Telegram receives `sale.online_placed`, `contact.message_received`, `subscription.requested`).

---

## Self-review notes (coverage map vs spec)

- Spec §A (API client foundation) → Tasks 0.1–0.6. ✅ (server-fn refinement documented above)
- Spec §B (catalog wiring) → Milestone 1 (1.1–1.5). ✅ branches feed checkout (Task 3.1).
- Spec §C (blog schema/seed/API/admin/frontend) → Milestone 2 (2.1–2.7). ✅ blog `author` is the denormalized text column (matches the spec's flagged decision).
- Spec §D (cart + real checkout + tracking page + Turnstile) → Milestone 3 (3.1–3.2) + cart Task 1.1. ✅
- Spec §E (contact/subscription/bundle backends + outbox cases) → Milestone 4 (4.1–4.8). ✅
- Spec §F (config/env, migrations 0039/0040) → Task 2.1, 4.1, Milestone 5. ✅
- Spec §G (testing) → Tasks with TDD + Milestone 6. ✅
- Spec "delete static files after cutover" → Tasks 1.5, 2.7. ✅
```
