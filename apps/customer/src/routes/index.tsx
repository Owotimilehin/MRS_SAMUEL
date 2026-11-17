import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import type { Product } from "@/lib/api/mappers";
import { fetchProducts, fetchBlogPosts, fetchBanner, fetchInstagramFeed } from "@/lib/api/server-fns";
import { TopBanner } from "@/components/TopBanner";
import { pickCustomBannerMessage } from "@/lib/banner";
import { SiteShell } from "@/components/SiteShell";
import { Hero } from "@/components/Hero";
import { StockBanner } from "@/components/StockBanner";
import { deriveStockSummary, sortByStock650 } from "@/lib/stock-summary";
import { ProductCard } from "@/components/ProductCard";
import { ProductDetail } from "@/components/ProductDetail";
import { Benefits } from "@/components/Benefits";
import { StepProcess } from "@/components/StepProcess";
import { Categories } from "@/components/Categories";
import { Testimonials } from "@/components/Testimonials";
import { FeaturedBy } from "@/components/FeaturedBy";
import { FeatureCards } from "@/components/FeatureCards";
import { FAQ, faqs } from "@/components/FAQ";
import { Story } from "@/components/Story";
import { Sustainability } from "@/components/Sustainability";
import { Blog } from "@/components/Blog";
import { seo, faqPageLd } from "@/lib/seo";

export const Route = createFileRoute("/")({
  // Brand fonts are loaded for every page in routes/__root.tsx.
  head: () =>
    seo({
      title: "Fresh Fruit Juice in Lagos — Delivered Cold | Mrs. Samuel",
      description:
        "Fresh, 100% natural fruit juice made daily in Lagos: zobo, pineapple, orange, green juice and more. No added sugar, no preservatives. Order online for cold delivery.",
      path: "/",
      jsonLd: [faqPageLd(faqs)],
    }),
  loader: async () => {
    const [products, posts, banner, instagram] = await Promise.all([
      fetchProducts(),
      fetchBlogPosts(),
      fetchBanner(),
      fetchInstagramFeed(),
    ]);
    return { products, posts, banner, instagram };
  },
  component: Page,
});

function Page() {
  const { products, posts, banner, instagram } = Route.useLoaderData();
  const [selected, setSelected] = useState<Product | null>(null);
  const classics = sortByStock650(products.filter((p) => p.category === "Classic")).slice(0, 8);
  const specials = sortByStock650(products.filter((p) => p.category === "Special"));

  const stockSummary = deriveStockSummary(products);

  const customMessage = pickCustomBannerMessage(banner);
  const topBar = customMessage
    ? <TopBanner message={customMessage} />
    : <StockBanner summary={stockSummary} />;

  return (
    <SiteShell topBar={topBar}>
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

        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6">
          {classics.map((p, i) => (
            <ProductCard key={p.id} product={p} index={i} onClick={() => setSelected(p)} />
          ))}
        </div>

        <div className="mt-12 sm:mt-16 mb-8 flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">
              <span className="h-px w-6 bg-[color:var(--brand-orange)]/60" /> Mrs. Samuel Specials
            </div>
            <h2 className="mt-3 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[color:var(--brand)]">
              Limited bottles, pressed weekly.
            </h2>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6">
          {specials.map((p, i) => (
            <ProductCard key={p.id} product={p} index={i} onClick={() => setSelected(p)} />
          ))}
        </div>

        {/* Phone: the header link is hidden, so offer the full menu here. */}
        <div className="mt-8 flex justify-center sm:hidden">
          <Link
            to="/juices"
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-[color:var(--brand)] ring-1 ring-[color:var(--brand)]/15"
          >
            View all juices →
          </Link>
        </div>
      </section>

      <Benefits />
      <StepProcess />
      <Categories />
      <Story />
      <Sustainability />
      <Testimonials instagram={instagram} />
      <FeaturedBy />
      <Blog posts={posts} />
      <FeatureCards />
      <FAQ />

      <ProductDetail product={selected} onClose={() => setSelected(null)} />
    </SiteShell>
  );
}
