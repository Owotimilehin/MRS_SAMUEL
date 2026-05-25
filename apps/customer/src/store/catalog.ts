import { create } from "zustand";
import { api } from "../lib/api.js";

export interface CatalogVariant {
  id: string;
  size_ml: number;
  sku: string;
  price_ngn: number;
}

export interface CatalogProduct {
  id: string;
  name: string;
  slug: string;
  category: string;
  ingredients: string[];
  image_url: string | null;
  price_ngn: number;
  variants: CatalogVariant[];
}

interface CatalogState {
  products: CatalogProduct[];
  byName: Map<string, CatalogProduct>;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  variantFor: (name: string, sizeMl: number) => CatalogVariant | undefined;
}

let inflight: Promise<void> | null = null;

/**
 * Snapshot of /v1/public/catalog/products. The customer landing reads variant
 * UUIDs from here so cart lines carry the same identity the server prices on.
 */
export const useCatalog = create<CatalogState>((set, get) => ({
  products: [],
  byName: new Map(),
  loaded: false,
  loading: false,
  error: null,
  load: async () => {
    if (get().loaded || get().loading) {
      if (inflight) await inflight;
      return;
    }
    set({ loading: true, error: null });
    inflight = (async () => {
      try {
        const res = await api<{ data: CatalogProduct[] }>("/catalog/products");
        const byName = new Map<string, CatalogProduct>();
        for (const p of res.data) {
          byName.set(p.name.toLowerCase().trim(), p);
        }
        set({ products: res.data, byName, loaded: true, loading: false });
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inflight = null;
      }
    })();
    await inflight;
  },
  variantFor: (name, sizeMl) => {
    const p = get().byName.get(name.toLowerCase().trim());
    if (!p) return undefined;
    return p.variants.find((v) => v.size_ml === sizeMl);
  },
}));
