import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus, ShoppingBag, Trash2, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCart, formatNaira } from "@/lib/cart";
import { deliveryPromise } from "@/lib/availability-label";

export function CartDrawer() {
  const { items, open, setOpen, setQty, remove, subtotal } = useCart();
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            className="fixed top-0 right-0 z-50 h-full w-full max-w-md glass-dark shadow-2xl flex flex-col"
          >
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/30">
              <div className="flex items-center gap-2">
                <ShoppingBag className="h-5 w-5" />
                <h3 className="font-display text-2xl font-black">Your Basket</h3>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-full bg-white/60 hover:bg-white/90 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {items.length === 0 && (
                <div className="text-center py-20 opacity-70">
                  <div className="text-6xl mb-3">🥤</div>
                  <p className="font-semibold">Your basket is empty</p>
                  <p className="text-sm mt-1">Pick a juice to get started.</p>
                </div>
              )}
              {items.map((item) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 50 }}
                  className="flex items-center gap-3 rounded-2xl bg-white/70 p-3 shadow"
                >
                  <div
                    className="grid h-16 w-16 place-items-center overflow-hidden rounded-xl shrink-0"
                    style={{ background: item.product.palette.surface }}
                  >
                    <img
                      src={item.product.image}
                      alt=""
                      className="h-14 w-14 object-contain drop-shadow"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold leading-tight truncate">{item.product.name}</div>
                    <div className="flex items-center gap-1.5 text-xs opacity-70">
                      <span>{item.size}</span>
                    </div>
                    {(() => {
                      const available = item.product.availableBySize[item.size] ?? 0;
                      const inStock = available > 0;
                      return (
                        <div className={`text-[10px] font-semibold mt-0.5 ${inStock ? "text-[color:var(--brand)]/70" : "text-[color:var(--brand-orange)]"}`}>
                          {inStock ? `${available} in stock` : deliveryPromise(item.size, 0)}
                        </div>
                      );
                    })()}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={() => setQty(item.id, item.qty - 1)}
                        className="grid h-7 w-7 place-items-center rounded-full bg-foreground/10 hover:bg-foreground/20"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-6 text-center text-sm font-bold">{item.qty}</span>
                      <button
                        onClick={() => setQty(item.id, item.qty + 1)}
                        className="grid h-7 w-7 place-items-center rounded-full bg-foreground/10 hover:bg-foreground/20"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-display font-black">
                      {formatNaira(item.unitPrice * item.qty)}
                    </div>
                    <button
                      onClick={() => remove(item.id)}
                      className="mt-2 text-xs opacity-60 hover:opacity-100 inline-flex items-center gap-1"
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>

            <div className="border-t border-white/30 px-6 py-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold opacity-70">Subtotal</span>
                <span className="font-display text-2xl font-black">{formatNaira(subtotal)}</span>
              </div>
              <Link
                to="/checkout"
                onClick={() => setOpen(false)}
                aria-disabled={!items.length}
                tabIndex={items.length ? 0 : -1}
                className={`block w-full text-center rounded-full bg-foreground text-background py-4 font-bold shadow-xl transition ${items.length ? "hover:opacity-90" : "opacity-40 pointer-events-none"}`}
              >
                Checkout
              </Link>
              <p className="text-center text-[11px] opacity-60">Delivery across Lagos within 24 hours.</p>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
