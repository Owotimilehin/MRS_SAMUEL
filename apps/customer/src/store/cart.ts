import { useSyncExternalStore } from "react";

/**
 * Server-side cart. Lines live in Postgres, keyed by the `ms_cart` cookie set
 * by the API. The client keeps an in-memory mirror of the latest GET response
 * so React re-renders are instant; every mutation calls the API and replaces
 * the mirror with the server's authoritative response.
 */

export interface CartLine {
  id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  size_ml: number;
  unit_price_ngn: number;
  quantity: number;
  line_total_ngn: number;
}

export interface CartView {
  cart_id: string | null;
  lines: CartLine[];
  subtotal_ngn: number;
  total_items: number;
}

/** Legacy alias kept so existing callers compile unchanged. */
export interface CartItem {
  product_id: string;
  variant_id?: string;
  name: string;
  unit_price_ngn: number;
  quantity: number;
}

const EMPTY: CartView = { cart_id: null, lines: [], subtotal_ngn: 0, total_items: 0 };
let snapshot: CartView = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): CartView {
  return snapshot;
}
function applyServer(v: CartView): void {
  snapshot = v;
  emit();
}

interface CartResp {
  data: CartView;
}

async function fetchCart(method: string, path: string, body?: unknown): Promise<CartView> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    headers["idempotency-key"] = crypto.randomUUID();
  }
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  // Hono doesn't match a trailing slash on the mount root, so collapse "/" to "".
  const suffix = path === "/" ? "" : path;
  const res = await fetch(`/v1/public/cart${suffix}`, init);
  if (!res.ok) throw new Error(`cart request failed (${res.status})`);
  const json = (await res.json()) as CartResp;
  return json.data;
}

/** Public mutators. Each refreshes the in-memory snapshot from the server. */
export const cart = {
  async refresh(): Promise<void> {
    const v = await fetchCart("GET", "/");
    applyServer(v);
  },
  async add(variantId: string, quantity = 1): Promise<void> {
    const v = await fetchCart("POST", "/lines", { variant_id: variantId, quantity });
    applyServer(v);
  },
  async setQuantity(variantId: string, quantity: number): Promise<void> {
    const v = await fetchCart("PATCH", "/lines", { variant_id: variantId, quantity });
    applyServer(v);
  },
  async remove(variantId: string): Promise<void> {
    await cart.setQuantity(variantId, 0);
  },
  async clear(): Promise<void> {
    const v = await fetchCart("DELETE", "/");
    applyServer(v);
  },
};

/**
 * Legacy hook shape — many callers do `useCart((s) => s.items)`,
 * `useCart((s) => s.add)`, etc. We adapt the new server model onto the old
 * surface: `items` is a projection of `lines` (mirrors the previous shape so
 * MenuCard / cart page / checkout keep compiling), and mutator methods are
 * thin wrappers that call the API.
 */
interface CartState {
  items: CartItem[];
  lines: CartLine[];
  subtotal_ngn: number;
  total_items: number;
  add: (item: { product_id: string; variant_id?: string; name: string; unit_price_ngn: number }) => void;
  remove: (idOrVariant: string) => void;
  setQuantity: (idOrVariant: string, q: number) => void;
  clear: () => void;
  subtotal: () => number;
  totalItems: () => number;
}

function linesToItems(lines: CartLine[]): CartItem[] {
  return lines.map((l) => ({
    product_id: l.variant_id,
    variant_id: l.variant_id,
    name: `${l.product_name} (${l.size_ml}ml)`,
    unit_price_ngn: l.unit_price_ngn,
    quantity: l.quantity,
  }));
}

export function useCart<T>(selector: (s: CartState) => T): T {
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const state: CartState = {
    items: linesToItems(view.lines),
    lines: view.lines,
    subtotal_ngn: view.subtotal_ngn,
    total_items: view.total_items,
    add: (item) => {
      // Server cart is variant-keyed. If the caller didn't supply a variant_id
      // (very old code path), product_id IS the variant id (post-variant
      // refactor stored the variant uuid in product_id). Fire-and-forget; the
      // snapshot updates when the API returns.
      const vid = item.variant_id ?? item.product_id;
      void cart.add(vid, 1);
    },
    remove: (idOrVariant) => {
      void cart.remove(idOrVariant);
    },
    setQuantity: (idOrVariant, q) => {
      void cart.setQuantity(idOrVariant, q);
    },
    clear: () => {
      void cart.clear();
    },
    subtotal: () => view.subtotal_ngn,
    totalItems: () => view.total_items,
  };
  return selector(state);
}
