import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { ArrowLeft, ShoppingCart, Leaf, Check, Zap } from "lucide-react";
import { useState } from "react";
import type { Size } from "@/lib/visuals";
import { CLUSTERS } from "@/lib/visuals";
import { fetchProductBySlug, fetchProducts } from "@/lib/api/server-fns";
import { SiteShell } from "@/components/SiteShell";
import { useCart, formatNaira, isPreorderSize, quickAddSize } from "@/lib/cart";
import { seo, productLd, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/juices/$id")({
  loader: async ({ params }) => {
    const [product, all] = await Promise.all([
      fetchProductBySlug({ data: params.id }),
      fetchProducts(),
    ]);
    return { product, related: all.filter((x) => x.id !== product.id && x.cluster === product.cluster).slice(0, 3) };
  },
  head: ({ loaderData }) => {
    const p = loaderData?.product;
    if (!p) {
      return seo({ title: "Juice — Mrs. Samuel Fruit Juice", path: "/juices" });
    }
    const path = `/juices/${p.id}`;
    const description =
      `${p.tagline} Cold-pressed ${p.name} made fresh in Lagos with ${p.ingredients.slice(0, 4).join(", ")} — no added sugar, no preservatives.`.trim();
    const fromPrice = p.prices["330ml"] || p.prices["650ml"];
    return seo({
      title: `${p.name} — Cold-Pressed Juice | Mrs. Samuel`,
      description,
      path,
      image: p.image,
      type: "product",
      jsonLd: [
        productLd({ name: p.name, description, image: p.image, path, priceNgn: fromPrice }),
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Our Juices", path: "/juices" },
          { name: p.name, path },
        ]),
      ],
    });
  },
  component: Page,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <SiteShell>
      <div className="px-5 max-w-3xl mx-auto py-40 text-center">
        <h1 className="font-display text-5xl text-[color:var(--brand)]">Juice not found</h1>
        <p className="mt-3 text-[color:var(--brand)]/70">We couldn't find that bottle. Browse the full menu instead.</p>
        <Link to="/juices" className="mt-6 inline-flex rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold">View all juices</Link>
      </div>
    </SiteShell>
  );
}

function Page() {
  const { product: p, related } = Route.useLoaderData();
  const { add, setOpen } = useCart();
  const navigate = useNavigate();
  // Default to the deliverable big can; the small can is preorder-only.
  const [size, setSize] = useState<Size>(quickAddSize(p));
  const [qty, setQty] = useState(1);

  const clusterImg = CLUSTERS[p.cluster];
  const preorder = isPreorderSize(p, size);
  // Only offer sizes the product actually sells.
  const sizes = (["330ml", "650ml"] as const).filter((s) => p.variantIds[s]);

  return (
    <SiteShell>
      <div className="px-5 sm:px-10 pt-32 sm:pt-36 max-w-7xl mx-auto">
        <Link to="/juices" className="inline-flex items-center gap-2 text-sm font-semibold text-[color:var(--brand)]/70 hover:text-[color:var(--brand-orange)]">
          <ArrowLeft className="h-4 w-4" /> All juices
        </Link>
      </div>

      {/* Hero */}
      <section className="px-5 sm:px-10 max-w-7xl mx-auto pt-10 pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8 }}
            className="relative h-[420px] sm:h-[560px] rounded-[2rem] overflow-hidden"
            style={{ background: p.palette.surface }}
          >
            <img src={clusterImg} alt="" aria-hidden className="absolute -bottom-6 -right-6 w-[55%] opacity-90" />
            <motion.img
              src={p.image}
              alt={p.name}
              className="absolute inset-0 m-auto h-[88%] w-auto object-contain drop-shadow-[0_28px_36px_rgba(80,40,10,0.28)]"
              animate={{ y: [0, -10, 0] }}
              transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
            />
          </motion.div>

          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: p.palette.accent }}>
              {p.category} · {p.bestFor.join(" · ")}
            </div>
            <h1 className="mt-3 font-display text-5xl sm:text-6xl font-semibold tracking-tight text-[color:var(--brand)]">
              {p.name}
            </h1>
            <p className="mt-4 text-lg text-[color:var(--brand)]/75 leading-relaxed">{p.tagline}</p>

            <div className="mt-6 flex flex-wrap gap-2">
              {p.benefits.map((b: string) => (
                <span key={b} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-[color:var(--brand)] ring-1 ring-black/5">
                  <Check className="h-3 w-3" style={{ color: p.palette.accent }} /> {b}
                </span>
              ))}
            </div>

            {/* Size + Qty + Add */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {sizes.map((s) => (
                <button
                  key={s}
                  onClick={() => setSize(s)}
                  className={`relative rounded-full px-4 py-2 text-sm font-semibold transition ${
                    size === s ? "bg-[color:var(--brand)] text-white" : "bg-white ring-1 ring-black/10 text-[color:var(--brand)]"
                  }`}
                >
                  {s} · {formatNaira(p.prices[s])}
                  {isPreorderSize(p, s) && (
                    <span className="ml-2 rounded-full bg-[color:var(--brand-orange)]/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[color:var(--brand-orange)]">
                      Preorder
                    </span>
                  )}
                </button>
              ))}
              <div className="ml-1 flex items-center gap-2 rounded-full bg-white ring-1 ring-black/10 px-2 py-1">
                <button onClick={() => setQty(Math.max(1, qty - 1))} className="grid h-7 w-7 place-items-center rounded-full bg-black/5 text-[color:var(--brand)]">−</button>
                <span className="w-6 text-center text-sm font-bold text-[color:var(--brand)]">{qty}</span>
                <button onClick={() => setQty(qty + 1)} className="grid h-7 w-7 place-items-center rounded-full bg-black/5 text-[color:var(--brand)]">+</button>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={() => { for (let i = 0; i < qty; i++) add(p, size); }}
                className="inline-flex items-center gap-3 rounded-full text-white pl-6 pr-3 py-3.5 text-sm font-semibold transition hover:opacity-90"
                style={{ background: p.palette.accent }}
              >
                Add to cart · {formatNaira(p.prices[size] * qty)}
                <span className="grid h-8 w-8 place-items-center rounded-full bg-white/20">
                  <ShoppingCart className="h-4 w-4" />
                </span>
              </button>
              <button
                onClick={() => {
                  for (let i = 0; i < qty; i++) add(p, size);
                  setOpen(false);
                  navigate({ to: "/checkout" });
                }}
                className="inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white px-6 py-3.5 text-sm font-semibold hover:bg-[color:var(--brand-orange)] transition"
              >
                <Zap className="h-4 w-4" /> Buy now
              </button>
            </div>
            {preorder ? (
              <p className="mt-3 text-xs font-medium text-[color:var(--brand-orange)]">
                This size is made to order — you'll pick a delivery day at checkout.
              </p>
            ) : (
              <p className="mt-3 text-xs text-[color:var(--brand)]/60">Free delivery on orders over ₦20,000 · Lagos same-day</p>
            )}
          </div>
        </div>
      </section>

      {/* Ingredients */}
      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-20">
        <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">What's inside</div>
        <h2 className="mt-3 font-display text-4xl font-semibold text-[color:var(--brand)]">Every ingredient, every benefit.</h2>
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {p.ingredientDetails.map((ing: { name: string; benefit: string }) => (
            <div key={ing.name} className="rounded-2xl bg-white p-5 ring-1 ring-black/5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full" style={{ background: p.palette.surface, color: p.palette.accent }}>
                  <Leaf className="h-4 w-4" />
                </span>
                <h3 className="font-display text-lg font-semibold text-[color:var(--brand)]">{ing.name}</h3>
              </div>
              <p className="mt-3 text-sm text-[color:var(--brand)]/70 leading-relaxed">{ing.benefit}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Story */}
      <section className="px-5 sm:px-10 pb-20">
        <div className="mx-auto max-w-4xl rounded-[2rem] p-8 sm:p-12" style={{ background: p.palette.surface }}>
          <div className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: p.palette.accent }}>The story</div>
          <p className="mt-4 font-display text-2xl sm:text-3xl leading-snug text-[color:var(--brand)]">
            "{p.story}"
          </p>
          <div className="mt-6 pt-6 border-t border-black/10">
            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/60">Pair with</div>
            <p className="mt-2 text-[color:var(--brand)]/80">{p.pairing}</p>
          </div>
        </div>
      </section>

      {/* Related */}
      {related.length > 0 && (
        <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-24">
          <h2 className="font-display text-3xl text-[color:var(--brand)]">You might also like</h2>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-5">
            {related.map((r) => (
              <Link key={r.id} to="/juices/$id" params={{ id: r.id }} className="group rounded-2xl bg-white ring-1 ring-black/5 overflow-hidden hover:shadow-lg transition">
                <div className="relative h-52" style={{ background: r.palette.surface }}>
                  <img src={r.image} alt={r.name} className="absolute inset-0 m-auto h-[105%] w-auto object-contain" />
                </div>
                <div className="p-4">
                  <h3 className="font-display text-lg text-[color:var(--brand)]">{r.name}</h3>
                  <p className="text-xs text-[color:var(--brand)]/60 mt-1 line-clamp-2">{r.tagline}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </SiteShell>
  );
}
