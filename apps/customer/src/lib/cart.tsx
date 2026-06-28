import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";

// Some sizes are made to order — preorder only (driven by the variant's
// `preorder_only` flag from the API). They can't ship same-day, so checkout
// forces a scheduled delivery day when the basket holds one.
export const isPreorderSize = (product: Product, size: Size): boolean =>
  product.preorderBySize[size] ?? false;

/** A line is a preorder when the wanted qty exceeds the online-default
 *  branch's available stock for that size. Whole line flips (spec). */
export const isPreorderLine = (product: Product, size: Size, qty: number): boolean =>
  qty > (product.availableBySize[size] ?? 0);

/** The size a one-tap "quick add" should use: the largest size with stock > 0,
 *  otherwise the largest size the product sells (preorder path). */
export function quickAddSize(product: Product): Size {
  // Prefer the largest size that has live stock available.
  const inStock = (["650ml", "330ml"] as const).find(
    (s) => product.variantIds[s] && (product.availableBySize[s] ?? 0) > 0,
  );
  if (inStock) return inStock;
  // Fall back to largest available variant (will be a preorder).
  if (product.variantIds["650ml"]) return "650ml";
  if (product.variantIds["330ml"]) return "330ml";
  return "650ml";
}

export interface CartItem {
  id: string;
  product: Product;
  size: Size;
  variantId: string;
  unitPrice: number;
  qty: number;
  preorder: boolean;
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
  hasPreorder: boolean;
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
      if (raw) {
        const saved = JSON.parse(raw) as CartItem[];
        // Backfill preorder using stock-driven logic; recompute on every hydration
        // so stale carts pick up the latest stock figures.
        setItems(saved.map((i) => ({ ...i, preorder: isPreorderLine(i.product, i.size, i.qty) })));
      }
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
      if (exist) {
        const newQty = exist.qty + 1;
        return prev.map((i) =>
          i.id === id ? { ...i, qty: newQty, preorder: isPreorderLine(product, size, newQty) } : i,
        );
      }
      return [...prev, { id, product, size, variantId, unitPrice, qty: 1, preorder: isPreorderLine(product, size, 1) }];
    });
    setOpen(true);
  };

  const remove = (id: string) => setItems((p) => p.filter((i) => i.id !== id));
  const setQty = (id: string, qty: number) =>
    setItems((p) =>
      qty <= 0
        ? p.filter((i) => i.id !== id)
        : p.map((i) =>
            i.id === id ? { ...i, qty, preorder: isPreorderLine(i.product, i.size, qty) } : i,
          ),
    );
  const clear = () => setItems([]);

  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const count = items.reduce((s, i) => s + i.qty, 0);
  const hasPreorder = items.some((i) => i.preorder);

  return (
    <Ctx.Provider value={{ items, add, remove, setQty, clear, open, setOpen, subtotal, count, hasPreorder }}>
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
