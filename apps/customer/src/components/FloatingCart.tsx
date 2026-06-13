import { AnimatePresence, motion } from "framer-motion";
import { ShoppingCart } from "lucide-react";
import { useCart, formatNaira } from "@/lib/cart";

/**
 * Thumb-reachable cart button for phones/tablets. The header cart sits at the
 * very top (awkward to reach mid-scroll), so this floats bottom-right whenever
 * there's something in the basket. Hidden on desktop (lg+), where the header
 * cart and a wider layout are enough.
 */
export function FloatingCart() {
  const { count, subtotal, setOpen, open } = useCart();

  return (
    <AnimatePresence>
      {count > 0 && !open && (
        <motion.button
          initial={{ opacity: 0, y: 24, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.9 }}
          transition={{ type: "spring", damping: 22, stiffness: 280 }}
          onClick={() => setOpen(true)}
          className="lg:hidden fixed bottom-5 right-5 z-40 flex items-center gap-3 rounded-full bg-[color:var(--brand)] py-3 pl-4 pr-5 text-white shadow-[0_10px_30px_-6px_rgba(20,20,10,0.45)] active:scale-95 transition"
          aria-label={`View cart, ${count} item${count === 1 ? "" : "s"}`}
        >
          <span className="relative grid h-7 w-7 place-items-center">
            <ShoppingCart className="h-5 w-5" />
            <span className="absolute -top-1.5 -right-1.5 grid h-5 w-5 place-items-center rounded-full bg-[color:var(--brand-orange)] text-[10px] font-bold">
              {count}
            </span>
          </span>
          <span className="text-sm font-semibold">{formatNaira(subtotal)}</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
