import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Clock } from "lucide-react";
import { fetchBlogPosts } from "@/lib/api/server-fns";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { CLUSTERS, HARD_EDGED_DECOR } from "@/lib/visuals";
import { useState } from "react";
import clusterBerry from "@/assets/decor/cluster-berry.png";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/blog/")({
  loader: async () => ({ posts: await fetchBlogPosts() }),
  head: () =>
    seo({
      title: "The Mrs. Samuel Journal — Juice, Wellness & Nigerian Fruit",
      description:
        "Stories from the Mrs. Samuel kitchen — cold-pressed wellness, juice recipes, the health benefits of Nigerian fruit, and the mission to end fruit waste.",
      path: "/blog",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Journal", path: "/blog" }])],
    }),
  component: Page,
});

/** Cut-out covers float in the frame; edge-to-edge photos fill it. */
function coverCls(src: string, height: string): string {
  return HARD_EDGED_DECOR.has(src)
    ? "absolute inset-0 h-full w-full object-cover"
    : `absolute inset-0 m-auto ${height} w-auto object-contain`;
}

const categories = ["All", "Story", "Wellness", "Behind the Scenes", "Recipes"] as const;

function Page() {
  const { posts } = Route.useLoaderData();
  const [cat, setCat] = useState<(typeof categories)[number]>("All");
  const list = cat === "All" ? posts : posts.filter((p) => p.category === cat);
  const [featured, ...rest] = list;

  return (
    <SiteShell>
      <PageHero
        eyebrow="The Mrs. Samuel Journal"
        title={<>Stories from the<br /><span className="text-[color:var(--brand-orange)]">kitchen.</span></>}
        subtitle="Wellness notes, behind-the-press stories, and the occasional Mrs. Samuel recipe. No fluff, no filler."
        decor={clusterBerry}
        accent="#e85d8a"
      />

      {/* Filter chips */}
      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-8">
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                cat === c
                  ? "bg-[color:var(--brand)] text-white"
                  : "bg-white text-[color:var(--brand)] ring-1 ring-black/5 hover:bg-black/5"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </section>

      {/* Featured */}
      {featured && (
        <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-10">
          <Link to="/blog/$slug" params={{ slug: featured.slug }} className="group grid grid-cols-1 lg:grid-cols-2 gap-8 rounded-[2rem] overflow-hidden bg-white ring-1 ring-black/5 hover:shadow-lg transition">
            <div className="relative h-72 lg:h-auto min-h-[300px] bg-[color:var(--cream)]">
              <img src={CLUSTERS[featured.cover as keyof typeof CLUSTERS]} alt="" aria-hidden className={coverCls(CLUSTERS[featured.cover as keyof typeof CLUSTERS], "h-[88%]")} />
            </div>
            <div className="p-8 sm:p-12 flex flex-col justify-center">
              <div className="text-xs font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">FEATURED · {featured.category}</div>
              <h2 className="mt-3 font-display text-3xl sm:text-4xl text-[color:var(--brand)] group-hover:text-[color:var(--brand-orange)] transition">{featured.title}</h2>
              <p className="mt-3 text-[color:var(--brand)]/70 leading-relaxed">{featured.excerpt}</p>
              <div className="mt-5 flex items-center gap-4 text-xs text-[color:var(--brand)]/60">
                <span>{featured.author}</span>
                <span>{featured.date}</span>
                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {featured.readMins} min</span>
              </div>
            </div>
          </Link>
        </section>
      )}

      {/* Grid */}
      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {rest.map((p, i) => (
            <motion.article
              key={p.slug}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: (i % 3) * 0.05 }}
              className="flex flex-col rounded-2xl bg-white ring-1 ring-black/5 overflow-hidden hover:shadow-lg transition"
            >
              <Link to="/blog/$slug" params={{ slug: p.slug }} className="flex flex-1 flex-col">
                <div className="relative h-52 shrink-0 bg-[color:var(--cream)]">
                  <img src={CLUSTERS[p.cover as keyof typeof CLUSTERS]} alt="" aria-hidden className={coverCls(CLUSTERS[p.cover as keyof typeof CLUSTERS], "h-[85%]")} />
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">{p.category}</div>
                  <h3 className="mt-2 font-display text-xl leading-snug text-[color:var(--brand)] line-clamp-3">{p.title}</h3>
                  <p className="mt-2 text-sm text-[color:var(--brand)]/65 line-clamp-2">{p.excerpt}</p>
                  <div className="mt-auto flex items-center justify-between pt-4 text-xs text-[color:var(--brand)]/55">
                    <span>{p.date}</span>
                    <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{p.readMins} min</span>
                  </div>
                </div>
              </Link>
            </motion.article>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
