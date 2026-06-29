import { motion } from "framer-motion";
import { ShoppingCart } from "lucide-react";
import type { Product } from "@/lib/api/mappers";
import { getFruitFor } from "@/lib/visuals";
import { quickAddSize } from "@/lib/cart";
import { deliveryPromise } from "@/lib/availability-label";

interface Props {
  product: Product;
  onClick: () => void;
  index: number;
}

export function ProductCard({ product, onClick, index }: Props) {
  const { palette } = product;
  const fruit = getFruitFor(product.id, product.cluster);
  const featuredSize = quickAddSize(product);
  const featuredStock = product.availableBySize[featuredSize] ?? 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.5, delay: (index % 4) * 0.06 }}
      className="group flex flex-col overflow-hidden rounded-[1.25rem] bg-white shadow-[0_4px_20px_rgba(20,20,10,0.10)] ring-1 ring-black/5 transition-all hover:shadow-[0_20px_50px_-8px_rgba(20,20,10,0.22)] hover:-translate-y-1"
    >
      <button
        onClick={onClick}
        className="relative h-64 w-full overflow-hidden text-left"
        style={{ background: palette.surface }}
        aria-label={`View ${product.name}`}
      >
        {product.category === "Special" && (
          <span
            className="absolute top-3 left-3 z-20 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-white"
            style={{ background: palette.accent }}
          >
            Special
          </span>
        )}
        {/* soft radial halo so the surface fades rather than hard-cuts the imagery */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background: `radial-gradient(120% 80% at 50% 100%, ${palette.accent}22 0%, transparent 60%)`,
          }}
        />
        <motion.img
          src={product.image}
          alt={product.name}
          loading="lazy"
          className="absolute left-3 sm:left-4 bottom-3 h-[92%] w-auto object-contain object-bottom drop-shadow-[0_18px_22px_rgba(40,20,10,0.22)] z-10"
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut", delay: index * 0.2 }}
        />
        <img
          src={fruit}
          alt=""
          aria-hidden
          loading="lazy"
          className="absolute right-3 bottom-3 w-[48%] max-w-[150px] object-contain object-bottom drop-shadow-[0_14px_18px_rgba(40,20,10,0.20)] z-[5] pointer-events-none transition-transform duration-500 group-hover:translate-y-[-4px] group-hover:scale-[1.04]"
        />
      </button>

      <div className="flex flex-col gap-3 p-5">
        <div>
          <h3 className="font-display text-[19px] font-semibold leading-tight text-[color:var(--brand)]">
            {product.name}
          </h3>
          <p className="mt-1 text-[13px] leading-snug text-[color:var(--brand)]/65 line-clamp-2">
            {product.tagline}
          </p>
          <p
            className="mt-1.5 text-[11px] font-semibold"
            style={{ color: featuredStock > 0 ? "var(--brand)" : palette.accent }}
          >
            {featuredStock > 0
              ? `${featuredSize}: ${featuredStock} in stock`
              : `${featuredSize}: ${deliveryPromise(featuredSize, 0)}`}
          </p>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <div
            className="font-display text-xl font-semibold"
            style={{ color: palette.accent }}
          >
            ₦{product.prices[quickAddSize(product)].toLocaleString("en-NG")}
          </div>
          <button
            onClick={onClick}
            className="grid h-10 w-10 place-items-center rounded-full transition hover:scale-105"
            style={{ background: palette.surface, color: palette.accent }}
            aria-label={`Add ${product.name} to cart`}
          >
            <ShoppingCart className="h-4 w-4" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
