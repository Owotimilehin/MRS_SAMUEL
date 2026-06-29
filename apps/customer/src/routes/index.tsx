import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import type { Product } from "@/lib/api/mappers";
import { fetchProducts, fetchBlogPosts, fetchSubscriptionPlans } from "@/lib/api/server-fns";
import { SiteShell } from "@/components/SiteShell";
import { Hero } from "@/components/Hero";
import { StockBanner } from "@/components/StockBanner";
import { deriveStockSummary, sortByStock650 } from "@/lib/stock-summary";
import { ProductCard } from "@/components/ProductCard";
import { ProductDetail } from "@/components/ProductDetail";
import { Benefits } from "@/components/Benefits";
import { StepProcess } from "@/components/StepProcess";
import { Categories } from "@/components/Categories";
import { Subscription } from "@/components/Subscription";
import { Testimonials } from "@/components/Testimonials";
import { FeatureCards } from "@/components/FeatureCards";
import { FAQ } from "@/components/FAQ";
import { Story } from "@/components/Story";
import { Sustainability } from "@/components/Sustainability";
import { Blog } from "@/components/Blog";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/")({
  head: () => {
    const base = seo({
      title: "Mrs. Samuel Fruit Juice — Real Fruit, Real Good. Cold-Pressed in Lagos",
      description:
        "100% natural, cold-pressed Nigerian juice made fresh in Lagos. Over 40,000 bottles shared. No added sugar, no preservatives — pressed at sunrise, delivered the same morning.",
      path: "/",
    });
    return {
      ...base,
      links: [
        ...base.links,
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
        { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,300..700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" },
      ],
    };
  },
  loader: async () => {
    const [products, posts, plans] = await Promise.all([
      fetchProducts(),
      fetchBlogPosts(),
      fetchSubscriptionPlans(),
    ]);
    return { products, posts, plans };
  },
  component: Page,
});

function Page() {
  const { products, posts, plans } = Route.useLoaderData();
  const [selected, setSelected] = useState<Product | null>(null);
  const classics = sortByStock650(products.filter((p) => p.category === "Classic")).slice(0, 8);
  const specials = sortByStock650(products.filter((p) => p.category === "Special"));

  const stockSummary = deriveStockSummary(products);

  return (
    <SiteShell topBar={<StockBanner summary={stockSummary} />}>
      <Hero products={products} />

      <section id="products" className="px-5 sm:px-10 pt-6 pb-10 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="flex items-end justify-between gap-6 mb-8"
        >
          <div>
            <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
              <span className="h-px w-6 bg-[color:var(--brand)]/40" /> Our Best Sellers
            </div>
            <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold tracking-tight text-[color:var(--brand)]">
              Fresh Favourites
            </h2>
          </div>
          <Link to="/juices" className="hidden sm:inline-flex items-center gap-2 text-sm font-semibold text-[color:var(--brand-orange)]">
            View All Juices →
          </Link>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 sm:gap-6">
          {classics.map((p, i) => (
            <ProductCard key={p.id} product={p} index={i} onClick={() => setSelected(p)} />
          ))}
        </div>

        <div className="mt-16 mb-8 flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">
              <span className="h-px w-6 bg-[color:var(--brand-orange)]/60" /> Mrs. Samuel Specials
            </div>
            <h2 className="mt-3 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[color:var(--brand)]">
              Limited bottles, pressed weekly.
            </h2>
          </div>
          <span className="hidden sm:inline-flex font-display text-2xl font-semibold text-[color:var(--brand-orange)]">
            ₦4,500
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 sm:gap-6">
          {specials.map((p, i) => (
            <ProductCard key={p.id} product={p} index={i} onClick={() => setSelected(p)} />
          ))}
        </div>
      </section>

      <Benefits />
      <StepProcess />
      <Categories />
      <Subscription plans={plans} />
      <Story />
      <Sustainability />
      <Testimonials />
      <Blog posts={posts} />
      <FeatureCards />
      <FAQ />

      <ProductDetail product={selected} onClose={() => setSelected(null)} />
    </SiteShell>
  );
}
