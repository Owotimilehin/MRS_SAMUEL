import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { getFruitFor } from "@/lib/visuals";
import { fetchProducts } from "@/lib/api/server-fns";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import clusterTropical from "@/assets/decor/cluster-tropical.png";

export const Route = createFileRoute("/juices/")({
  head: () => ({
    meta: [
      { title: "Our Juices — Mrs. Samuel Fruit Juice" },
      { name: "description", content: "Browse all 16 cold-pressed Mrs. Samuel juices. Filter by ingredient or category. Pressed fresh in Lagos." },
      { property: "og:title", content: "Our Juices — Mrs. Samuel" },
      { property: "og:description", content: "Sixteen flavours. One promise — real fruit, nothing else." },
    ],
  }),
  loader: async () => ({ products: await fetchProducts() }),
  component: Page,
});

function Page() {
  const { products } = Route.useLoaderData();
  const [filter, setFilter] = useState<"All" | "Classic" | "Special">("All");
  const [ingFilter, setIngFilter] = useState<string | null>(null);

  const allIngredients = useMemo(() => {
    const s = new Set<string>();
    products.forEach((p) => p.ingredients.forEach((i) => s.add(i)));
    return Array.from(s).sort();
  }, [products]);

  const list = products.filter((p) => {
    if (filter !== "All" && p.category !== filter) return false;
    if (ingFilter && !p.ingredients.includes(ingFilter)) return false;
    return true;
  });

  return (
    <SiteShell>
      <PageHero
        eyebrow="Our Juices"
        title={<>Twenty flavours.<br /><span className="text-[color:var(--brand-orange)]">One promise.</span></>}
        subtitle="Real fruit, cold-pressed in Lagos. Nothing added — not sugar, not water, not preservatives. Pick a bottle by mood, by ingredient, or by what your body's asking for today."
        decor={clusterTropical}
        accent="#fdc651"
      />

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-20">
        {/* Category filter */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {(["All", "Classic", "Special"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                filter === c
                  ? "bg-[color:var(--brand)] text-white"
                  : "bg-white text-[color:var(--brand)] ring-1 ring-black/5 hover:bg-black/5"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Ingredient chips */}
        <div className="mb-10 flex flex-wrap gap-2">
          <button
            onClick={() => setIngFilter(null)}
            className={`text-xs rounded-full px-3 py-1.5 font-semibold transition ${
              ingFilter === null ? "bg-[color:var(--brand-orange)] text-white" : "bg-white/70 text-[color:var(--brand)]/70 hover:bg-white"
            }`}
          >
            All ingredients
          </button>
          {allIngredients.map((i) => (
            <button
              key={i}
              onClick={() => setIngFilter(i === ingFilter ? null : i)}
              className={`text-xs rounded-full px-3 py-1.5 font-medium transition ${
                ingFilter === i ? "bg-[color:var(--brand-orange)] text-white" : "bg-white/70 text-[color:var(--brand)]/70 hover:bg-white"
              }`}
            >
              {i}
            </button>
          ))}
        </div>

        {list.length === 0 && (
          <p className="text-center text-[color:var(--brand)]/60 py-12">No juices match that combination — try removing a filter.</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 sm:gap-6">
          {list.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.45, delay: (i % 4) * 0.05 }}
            >
              <Link
                to="/juices/$id"
                params={{ id: p.id }}
                className="group flex flex-col overflow-hidden rounded-[1.25rem] bg-white shadow-[0_2px_12px_rgba(20,20,10,0.06)] ring-1 ring-black/5 transition-shadow hover:shadow-[0_18px_45px_-10px_rgba(20,20,10,0.18)]"
              >
                <div className="relative h-64 w-full overflow-hidden" style={{ background: p.palette.surface }}>
                  {p.category === "Special" && (
                    <span
                      className="absolute top-3 left-3 z-20 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-white"
                      style={{ background: p.palette.accent }}
                    >
                      Special
                    </span>
                  )}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 z-0"
                    style={{ background: `radial-gradient(120% 80% at 50% 100%, ${p.palette.accent}22 0%, transparent 60%)` }}
                  />
                  <img src={p.image} alt={p.name} loading="lazy" className="absolute left-3 sm:left-4 bottom-3 h-[92%] w-auto object-contain object-bottom drop-shadow-[0_18px_22px_rgba(40,20,10,0.22)] z-10 transition-transform group-hover:scale-105" />
                  <img src={getFruitFor(p.id, p.cluster)} alt="" aria-hidden loading="lazy" className="absolute right-3 bottom-3 w-[48%] max-w-[150px] object-contain object-bottom drop-shadow-[0_14px_18px_rgba(40,20,10,0.20)] z-[5] pointer-events-none transition-transform duration-500 group-hover:translate-y-[-4px]" />
                </div>
                <div className="flex flex-col gap-3 p-5">
                  <div>
                    <h3 className="font-display text-[19px] font-semibold leading-tight text-[color:var(--brand)]">{p.name}</h3>
                    <p className="mt-1 text-[13px] leading-snug text-[color:var(--brand)]/65 line-clamp-2">{p.tagline}</p>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="font-display text-xl font-semibold" style={{ color: p.palette.accent }}>
                      ₦{p.prices["330ml"].toLocaleString("en-NG")}
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[color:var(--brand)]/70 group-hover:text-[color:var(--brand-orange)] transition">
                      Read more <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
