import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CartItem {
  product_id: string;
  name: string;
  unit_price_ngn: number;
  quantity: number;
}

interface CartState {
  items: CartItem[];
  add: (item: Omit<CartItem, "quantity">) => void;
  remove: (productId: string) => void;
  setQuantity: (productId: string, q: number) => void;
  clear: () => void;
  subtotal: () => number;
  totalItems: () => number;
}

/**
 * Cart is persisted to localStorage so a refresh doesn't lose the order.
 * After successful checkout we clear() explicitly.
 */
export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      add: (item) =>
        set((s) => {
          const existing = s.items.find((i) => i.product_id === item.product_id);
          if (existing) {
            return {
              items: s.items.map((i) =>
                i.product_id === item.product_id
                  ? { ...i, quantity: i.quantity + 1 }
                  : i,
              ),
            };
          }
          return { items: [...s.items, { ...item, quantity: 1 }] };
        }),
      remove: (id) =>
        set((s) => ({ items: s.items.filter((i) => i.product_id !== id) })),
      setQuantity: (id, q) =>
        set((s) => ({
          items:
            q <= 0
              ? s.items.filter((i) => i.product_id !== id)
              : s.items.map((i) => (i.product_id === id ? { ...i, quantity: q } : i)),
        })),
      clear: () => set({ items: [] }),
      subtotal: () => get().items.reduce((sum, i) => sum + i.unit_price_ngn * i.quantity, 0),
      totalItems: () => get().items.reduce((sum, i) => sum + i.quantity, 0),
    }),
    { name: "ms_cart" },
  ),
);
