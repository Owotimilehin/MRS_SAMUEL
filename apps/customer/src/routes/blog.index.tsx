import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Clock } from "lucide-react";
import { fetchBlogPosts } from "@/lib/api/server-fns";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { CLUSTERS } from "@/lib/visuals";
import { useState } from "react";
import clusterBerry from "@/assets/decor/cluster-berry.png";

export const Route = createFileRoute("/blog/")({
  loader: async () => ({ posts: await fetchBlogPosts() }),
  head: () => ({
    meta: [
      { title: "Blog — Mrs. Samuel Fruit Juice" },
      { name: "description", content: "Stories from the Mrs. Samuel kitchen — wellness, recipes, behind-the-scenes, and the mission to end Nigerian fruit waste." },
      { property: "og:title", content: "Blog — Mrs. Samuel" },
      { property: "og:description", content: "Stories from the kitchen." },
    ],
  }),
  component: Page,
});

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
              <img src={CLUSTERS[featured.cover as keyof typeof CLUSTERS]} alt="" aria-hidden className="absolute inset-0 m-auto h-[88%] w-auto object-contain" />
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
              className="rounded-2xl bg-white ring-1 ring-black/5 overflow-hidden hover:shadow-lg transition"
            >
              <Link to="/blog/$slug" params={{ slug: p.slug }} className="block">
                <div className="relative h-52 bg-[color:var(--cream)]">
                  <img src={CLUSTERS[p.cover as keyof typeof CLUSTERS]} alt="" aria-hidden className="absolute inset-0 m-auto h-[85%] w-auto object-contain" />
                </div>
                <div className="p-5">
                  <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">{p.category}</div>
                  <h3 className="mt-2 font-display text-xl text-[color:var(--brand)] line-clamp-2">{p.title}</h3>
                  <p className="mt-2 text-sm text-[color:var(--brand)]/65 line-clamp-2">{p.excerpt}</p>
                  <div className="mt-4 flex items-center justify-between text-xs text-[color:var(--brand)]/55">
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
