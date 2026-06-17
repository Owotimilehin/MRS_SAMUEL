import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { ArrowRight, Gift, Building2 } from "lucide-react";
import { getFruitFor } from "@/lib/visuals";
import { fetchProducts, fetchBundles } from "@/lib/api/server-fns";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { formatNaira, quickAddSize } from "@/lib/cart";
import bottleSunrise from "@/assets/bottle-sunrise.png";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/shop")({
  head: () =>
    seo({
      title: "Shop Cold-Pressed Juice — Bundles & Gift Boxes | Mrs. Samuel",
      description:
        "Order Mrs. Samuel cold-pressed juice in Lagos: starter packs, detox bundles, gift boxes and single bottles. Pressed fresh, delivered the same morning.",
      path: "/shop",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Shop", path: "/shop" }])],
    }),
  loader: async () => {
    const [products, bundles] = await Promise.all([fetchProducts(), fetchBundles()]);
    return { products, bundles };
  },
  component: Page,
});

function Page() {
  const { products, bundles } = Route.useLoaderData();
  return (
    <SiteShell>
      <PageHero
        eyebrow="Shop"
        title={<>Bundles built for the<br /><span className="text-[color:var(--brand-orange)]">way you actually drink.</span></>}
        subtitle="A bottle now and then is great. A fridge that always has one waiting is better. Pick a pack — or build your own from any flavour on the menu."
        decor={bottleSunrise}
      />

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-16">
        <h2 className="font-display text-3xl text-[color:var(--brand)]">Bundles & gift boxes</h2>
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-5">
          {bundles.map((b, i) => (
            <motion.div
              key={b.name}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, delay: i * 0.05 }}
              className="rounded-[1.5rem] bg-white p-7 ring-1 ring-black/5 hover:shadow-lg transition flex flex-col"
            >
              <div className="flex items-start justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">{b.badge}</span>
                <Gift className="h-5 w-5 text-[color:var(--brand)]/40" />
              </div>
              <h3 className="mt-3 font-display text-2xl text-[color:var(--brand)]">{b.name}</h3>
              <p className="mt-2 text-sm text-[color:var(--brand)]/70 leading-relaxed">{b.desc}</p>
              <div className="mt-4 text-xs text-[color:var(--brand)]/60">{b.items}</div>
              <div className="mt-5 flex items-center justify-between">
                <div className="font-display text-2xl font-semibold text-[color:var(--brand)]">{formatNaira(b.price)}</div>
                <a
                  href={`https://wa.me/2349019512246?text=${encodeURIComponent(`Hi Mrs. Samuel — I'd like to order the ${b.name} (${formatNaira(b.price)}).`)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white px-4 py-2 text-sm font-semibold hover:bg-[color:var(--brand-orange)] transition"
                >
                  Order on WhatsApp <ArrowRight className="h-3.5 w-3.5" />
                </a>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Single bottles */}
      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-20">
        <div className="flex items-end justify-between mb-6">
          <h2 className="font-display text-3xl text-[color:var(--brand)]">Single bottles</h2>
          <Link to="/juices" className="text-sm font-semibold text-[color:var(--brand-orange)]">Browse all →</Link>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {products.slice(0, 8).map((p) => (
            <Link key={p.id} to="/juices/$id" params={{ id: p.id }} className="group rounded-2xl bg-white ring-1 ring-black/5 overflow-hidden hover:shadow-lg transition">
              <div className="relative h-44 sm:h-52 overflow-hidden" style={{ background: p.palette.surface }}>
                <span aria-hidden className="pointer-events-none absolute inset-0 z-0" style={{ background: `radial-gradient(120% 80% at 50% 100%, ${p.palette.accent}22 0%, transparent 60%)` }} />
                <img src={p.image} alt={p.name} loading="lazy" className="absolute left-2 sm:left-3 bottom-2 h-[92%] w-auto object-contain object-bottom drop-shadow-[0_14px_18px_rgba(40,20,10,0.20)] z-10" />
                <img src={getFruitFor(p.id, p.cluster)} alt="" aria-hidden loading="lazy" className="absolute right-2 bottom-2 w-[45%] max-w-[120px] object-contain object-bottom z-[5] pointer-events-none" />
              </div>
              <div className="p-3 sm:p-4">
                <h3 className="font-display text-sm sm:text-base text-[color:var(--brand)] line-clamp-1">{p.name}</h3>
                <div className="mt-1 text-sm font-semibold" style={{ color: p.palette.accent }}>{formatNaira(p.prices[quickAddSize(p)])}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Wholesale */}
      <section className="px-5 sm:px-10 pb-20">
        <div className="mx-auto max-w-5xl rounded-[2rem] bg-[color:var(--brand)] text-white px-8 sm:px-12 py-12 grid grid-cols-1 md:grid-cols-[1.3fr_1fr] gap-8 items-center">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-white/70">
              <Building2 className="h-3.5 w-3.5" /> Wholesale & Events
            </div>
            <h2 className="mt-3 font-display text-3xl sm:text-4xl">Pressing for offices, hotels & events.</h2>
            <p className="mt-3 text-white/80">Custom labels available. Volume pricing from 50 bottles. We deliver and we pick up the glass.</p>
          </div>
          <div className="flex flex-col gap-3">
            <a href="https://wa.me/2349019512246" target="_blank" rel="noreferrer" className="rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-3 text-sm font-semibold text-center">Request a quote</a>
            <Link to="/contact" className="rounded-full bg-white/10 text-white px-6 py-3 text-sm font-semibold text-center hover:bg-white/20">Or contact us</Link>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
