/** Calls for /v1/catalogue (suite spec 08). */
import { api } from "@admin/lib/api.js";
import type { OrderTemplateName } from "@ms/shared";

export type ItemState = "pending" | "sent" | "live" | "rejected" | "blocked" | "removed";

export interface CatalogueProblem {
  kind: "config" | "temporary";
  code: string | null;
  message: string | null;
  plain: string;
  at: string | null;
}

export interface CatalogueLink {
  catalog_id: string;
  name: string | null;
  whatsapp_connected: boolean;
  is_cart_enabled: boolean | null;
  is_catalog_visible: boolean | null;
  sync_enabled: boolean;
  ask_fulfilment_auto: boolean;
  order_updates_enabled: boolean;
  last_sync_at: string | null;
  last_reconcile_at: string | null;
  problem: CatalogueProblem | null;
  /** Only on the answer to "Connect to WhatsApp", when the connection worked but a setting did not. */
  warning?: string;
}

export interface CatalogueStatus {
  /** Is a Meta token present on the server at all? */
  configured: boolean;
  link: CatalogueLink | null;
  online_branch: { id: string; name: string } | null;
  counts: Record<ItemState, number>;
  /** "APPROVED", another Meta status, or "missing". */
  templates: Record<OrderTemplateName, string>;
}

export interface CatalogueItem {
  id: string;
  retailer_id: string;
  title: string;
  state: ItemState;
  price_ngn: number | null;
  availability: "in stock" | "out of stock" | null;
  picture_url: string | null;
  problem_plain: string | null;
  problem_raw: string | null;
  review_status: string | null;
  pushed_at: string | null;
  checked_at: string | null;
}

export type SettingsPatch = Partial<
  Pick<CatalogueLink, "sync_enabled" | "ask_fulfilment_auto" | "order_updates_enabled"> & {
    is_cart_enabled: boolean;
    is_catalog_visible: boolean;
  }
>;

export const catalogueKeys = {
  status: ["catalogue", "status"] as const,
  items: (state: string, q: string) => ["catalogue", "items", state, q] as const,
  allItems: ["catalogue", "items"] as const,
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const catalogueApi = {
  status: async () => (await api<{ data: CatalogueStatus }>("/catalogue/status")).data,
  /** The card shows the server's sentence under the field, so no toast. */
  link: async (catalogId: string) =>
    (await api<{ data: CatalogueLink }>("/catalogue/link", json("POST", { catalog_id: catalogId }), { silentError: true })).data,
  unlink: () => api<{ data: { ok: true } }>("/catalogue/link", { method: "DELETE" }),
  connectWhatsApp: async () => (await api<{ data: CatalogueLink }>("/catalogue/connect-whatsapp", json("POST", { confirm: true }))).data,
  settings: async (patch: SettingsPatch) => (await api<{ data: CatalogueLink }>("/catalogue/settings", json("PATCH", patch))).data,
  sync: (mode: "changes" | "full") => api<{ data: { queued: true } }>("/catalogue/sync", json("POST", { mode })),
  items: async (p: { state?: ItemState; q?: string }) => {
    const qs = new URLSearchParams({ limit: "500" });
    if (p.state) qs.set("state", p.state);
    if (p.q) qs.set("q", p.q);
    return (await api<{ data: { items: CatalogueItem[]; total: number } }>(`/catalogue/items?${qs.toString()}`)).data;
  },
  retry: async (id: string) => (await api<{ data: CatalogueItem }>(`/catalogue/items/${id}/retry`, { method: "POST" })).data,
};
