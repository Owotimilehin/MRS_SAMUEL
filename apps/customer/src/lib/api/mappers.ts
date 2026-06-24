// apps/customer/src/lib/api/mappers.ts
import type { ApiProduct, ApiBlogSummary, ApiBlogPost, ApiBundle, ApiSubscriptionPlan } from "./types";
import { CLUSTERS, clusterForSlug, DEFAULT_BOTTLE, type Cluster, type Size } from "@/lib/visuals";

const isCluster = (s: string | null): s is Cluster =>
  s != null && Object.prototype.hasOwnProperty.call(CLUSTERS, s);

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
  preorderBySize: Partial<Record<Size, boolean>>;
  /** Per-flavour available pool at the online-default branch. Absence means API
   *  did not return it (older bundle); treat as in-stock (no badge). */
  available?: number;
  note?: string;
}

const FALLBACK_PALETTE = { surface: "#fdf3e7", accent: "#f6a623", text: "#3a2a18" };

export function toUiProduct(api: ApiProduct): Product {
  const prices: Record<string, number> = {};
  const variantIds: Partial<Record<Size, string>> = {};
  const preorderBySize: Partial<Record<Size, boolean>> = {};
  for (const v of api.variants) {
    const label = `${v.size_ml}ml` as Size;
    prices[label] = v.price_ngn;
    variantIds[label] = v.id;
    preorderBySize[label] = v.preorder_only;
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
    preorderBySize,
    available: api.available,
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
    cover: isCluster(api.cluster) ? api.cluster : "tropical",
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
