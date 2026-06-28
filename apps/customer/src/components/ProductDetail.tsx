import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useState, useEffect } from "react";
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";
import { getFruitFor } from "@/lib/visuals";
import { useCart, formatNaira, isPreorderLine, quickAddSize } from "@/lib/cart";

/** Per-size stock label driven by `availableBySize[size]`. */
function StockLabel({ available }: { available: number }) {
  if (available <= 0) {
    return (
      <span className="mt-1 block text-[9px] font-semibold uppercase tracking-wide text-[color:var(--brand-orange)]">
        Made to order — we can prepare more for you
      </span>
    );
  }
  if (available <= 5) {
    return (
      <span className="mt-1 block text-[9px] font-semibold uppercase tracking-wide text-[color:var(--brand-orange)]">
        {available} in stock — order now
      </span>
    );
  }
  return (
    <span className="mt-1 block text-[9px] font-semibold uppercase tracking-wide text-[color:var(--brand)]/50">
      {available} in stock
    </span>
  );
}

const ALL_SIZES: Size[] = ["330ml", "650ml"];

interface Props {
  product: Product | null;
  onClose: () => void;
}

export function ProductDetail({ product, onClose }: Props) {
  // 650ml is the default size. The effect below refines this to the product's
  // actual default (650ml if it sells it, else its only size) once a product
  // opens — starting at 650ml avoids a flash of the 330ml selection.
  const [size, setSize] = useState<Size>("650ml");
  const { add } = useCart();

  // Only the sizes the API actually sells (have a variant) are offered.
  const sizes = product ? ALL_SIZES.filter((s) => product.variantIds[s]) : ALL_SIZES;

  useEffect(() => {
    if (product) setSize(quickAddSize(product));
  }, [product]);

  return (
    <AnimatePresence>
      {product && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            key={product.id}
            initial={{ y: 60, opacity: 0, scale: 0.97 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 40, opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", damping: 26, stiffness: 260 }}
            className="relative grid w-full max-w-3xl grid-cols-1 sm:grid-cols-[1fr_1.1fr] overflow-hidden rounded-[1.5rem] bg-white shadow-2xl"
            style={{ color: product.palette.text }}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 z-20 grid h-9 w-9 place-items-center rounded-full bg-white/90 hover:bg-white transition shadow"
              aria-label="Close"
            >
              <X className="h-4 w-4 text-foreground" />
            </button>

            {/* Bottle panel */}
            <div
              className="relative h-72 sm:h-auto min-h-[320px] overflow-hidden"
              style={{ background: product.palette.surface }}
            >
              {/* soft radial halo so the surface fades rather than hard-cuts */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background: `radial-gradient(120% 80% at 50% 100%, ${product.palette.accent}22 0%, transparent 60%)`,
                }}
              />
              <motion.img
                src={product.image}
                alt={product.name}
                className="absolute inset-0 m-auto h-[105%] w-auto object-contain drop-shadow-[0_24px_30px_rgba(40,20,10,0.25)] z-10"
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
              />
              <img
                src={getFruitFor(product.id, product.cluster)}
                alt=""
                aria-hidden
                className="absolute right-3 bottom-3 w-[42%] max-w-[140px] object-contain object-bottom drop-shadow-[0_14px_18px_rgba(40,20,10,0.20)] z-[5] pointer-events-none"
              />
            </div>

            {/* Info */}
            <div className="p-7 sm:p-9 flex flex-col">
              {product.category === "Special" && (
                <span
                  className="inline-block self-start rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white"
                  style={{ background: product.palette.accent }}
                >
                  Mrs. Samuel Special
                </span>
              )}

              <h2 className="mt-3 font-display text-3xl sm:text-[2.2rem] font-semibold leading-tight tracking-tight text-[color:var(--brand)]">
                {product.name}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--brand)]/70">
                {product.tagline}
              </p>

              <div className="mt-5">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[color:var(--brand)]/55">
                  Pressed from
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {product.ingredients.map((ing) => (
                    <span
                      key={ing}
                      className="rounded-full px-3 py-1 text-xs font-semibold"
                      style={{
                        background: product.palette.surface,
                        color: product.palette.accent,
                      }}
                    >
                      {ing}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-6">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[color:var(--brand)]/55 mb-2">
                  Choose size
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {sizes.map((s) => {
                    const active = size === s;
                    const sizeAvailable = product.availableBySize[s] ?? 0;
                    const isStockPreorder = isPreorderLine(product, s, 1);
                    return (
                      <button
                        key={s}
                        onClick={() => setSize(s)}
                        className="rounded-2xl border-2 px-4 py-3.5 text-left transition"
                        style={{
                          borderColor: active ? product.palette.accent : "transparent",
                          background: active ? product.palette.surface : "#f7f3eb",
                          color: "var(--brand)",
                        }}
                      >
                        <div className="text-xs font-semibold opacity-60">
                          {s}
                          {isStockPreorder && (
                            <span className="ml-1.5 rounded-full bg-[color:var(--brand-orange)]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[color:var(--brand-orange)]">
                              Preorder
                            </span>
                          )}
                        </div>
                        <div className="font-display text-xl font-semibold">
                          {formatNaira(product.prices[s])}
                        </div>
                        <StockLabel available={sizeAvailable} />
                      </button>
                    );
                  })}
                </div>
                {isPreorderLine(product, size, 1) && (
                  <p className="mt-2 text-xs font-medium text-[color:var(--brand-orange)]">
                    This size is made to order — pick a delivery day at checkout.
                  </p>
                )}
              </div>

              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  add(product, size);
                  onClose();
                }}
                className="mt-7 w-full rounded-full py-3.5 font-semibold text-[15px] text-white shadow-lg"
                style={{ background: product.palette.accent }}
              >
                Add to Cart — {formatNaira(product.prices[size])}
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
