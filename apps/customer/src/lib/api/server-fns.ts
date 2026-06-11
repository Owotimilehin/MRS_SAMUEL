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
    try {
      return await apiFetch<ApiQuote>("/v1/public/orders/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
    } catch (err) {
      // Preserve the API's structured error across the RPC boundary so the
      // checkout can show the precise reason a quote failed.
      if (err instanceof ApiError) throw new Error(err.serialize());
      throw err;
    }
  });

export interface PlaceOrderInput {
  branch_id: string;
  delivery_fee_ngn: number;
  delivery_quote_id?: string;
  delivery_state?: string;
  scheduled_delivery_at?: string;
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
    try {
      return await apiFetch<ApiPlacedOrder>("/v1/public/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotency_key },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Preserve the API's structured error (code/status) across the RPC
      // boundary so the checkout UI can surface precise messages — e.g.
      // "insufficient stock" or the idempotency replay codes — instead of a
      // generic failure. The prototype is otherwise stripped on the client.
      if (err instanceof ApiError) throw new Error(err.serialize());
      throw err;
    }
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
