import { Instagram, ArrowUpRight } from "lucide-react";
import { FEATURES } from "@/lib/press";

/** "Loved by Lagos creators" — plain server-rendered links to real features. */
export function FeaturedBy() {
  if (FEATURES.length === 0) return null;
  return (
    <section id="featured" className="px-5 sm:px-10 py-16 max-w-7xl mx-auto">
      <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">As Featured By</div>
      <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold tracking-tight text-[color:var(--brand)] leading-tight">
        Loved by Lagos creators
      </h2>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <li key={f.handle}>
            <a
              href={f.url}
              target="_blank"
              rel="noopener"
              className="group flex h-full flex-col rounded-2xl bg-white p-5 ring-1 ring-black/5 hover:shadow-lg transition"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-[color:var(--brand)]">
                <Instagram className="h-4 w-4 text-[color:var(--brand-orange)]" aria-hidden />
                {f.name}
              </span>
              <span className="text-xs text-[color:var(--brand)]/60">@{f.handle}</span>
              <span className="mt-3 flex-1 text-[14px] leading-relaxed text-[color:var(--brand)]/80">{f.blurb}</span>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-[color:var(--brand-orange)]">
                Watch the reel <ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
