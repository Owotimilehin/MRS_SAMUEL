import { motion } from "framer-motion";
import { ArrowUpRight, Clock } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { BlogPostSummary } from "@/lib/api/mappers";
import { CLUSTERS } from "@/lib/visuals";

export function Blog({ posts }: { posts: BlogPostSummary[] }) {
  const featured = posts.slice(0, 3);
  if (featured.length === 0) return null;

  return (
    <section id="blog" className="px-5 sm:px-10 py-20 max-w-7xl mx-auto">
      <div className="flex items-end justify-between gap-6 mb-10">
        <div>
          <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
            <span className="h-px w-6 bg-[color:var(--brand)]/40" /> Live Healthy, Drink Fresh
          </div>
          <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold tracking-tight text-[color:var(--brand)]">
            Stories from the Kitchen
          </h2>
        </div>
        <Link to="/blog" className="hidden sm:inline-flex text-sm font-semibold text-[color:var(--brand-orange)]">
          Read All →
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {featured.map((p, i) => (
          <motion.article
            key={p.slug}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.08 }}
            className="group flex flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-black/5 shadow-sm hover:shadow-xl transition"
          >
            <Link to="/blog/$slug" params={{ slug: p.slug }} className="flex flex-1 flex-col">
              <div className="relative h-56 overflow-hidden bg-[color:var(--cream)]">
                <img
                  src={CLUSTERS[p.cover]}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 m-auto h-[88%] w-auto object-contain transition duration-500 group-hover:scale-105"
                />
                <span className="absolute top-3 left-3 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[color:var(--brand)]">
                  {p.category}
                </span>
              </div>
              <div className="p-5 flex-1 flex flex-col">
                <div className="text-[11px] font-medium text-[color:var(--brand)]/55 inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {p.readMins} min read
                </div>
                <h3 className="mt-2 font-display text-xl font-semibold leading-tight text-[color:var(--brand)]">
                  {p.title}
                </h3>
                <p className="mt-2 text-[13px] text-[color:var(--brand)]/70 leading-relaxed line-clamp-2">
                  {p.excerpt}
                </p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-[color:var(--brand-orange)] group-hover:gap-2 transition-all">
                  Read Story <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </div>
            </Link>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
