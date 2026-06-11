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
