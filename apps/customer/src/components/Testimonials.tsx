import { motion } from "framer-motion";
import { Star, Instagram, Play } from "lucide-react";
import type { IgPost } from "@/lib/api/server-fns";
import { INSTAGRAM_FALLBACK, INSTAGRAM_PROFILE } from "@/lib/instagram-fallback";

const reviews = [
  { name: "Adaeze M.", text: "I look forward to my delivery every Monday. Tastes like the fruit was picked an hour ago." },
  { name: "Tunde A.", text: "Swapped soft drinks for the Detox bottle. My skin and my mornings are different now." },
  { name: "Kemi O.", text: "The Pink Paradise is unreal. My kids fight over the last bottle." },
];

/** First line of a caption, trimmed — used as alt text and visible caption. */
function captionLine(c: string, max = 110): string {
  const line = (c.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function Testimonials({ instagram = [] }: { instagram?: IgPost[] }) {
  // Live feed first; otherwise our own curated posts. Never placeholder art.
  const live = instagram.length > 0;
  const tiles = live
    ? instagram.slice(0, 6).map((p) => ({ url: p.permalink, caption: p.caption, image: p.imageUrl, isVideo: p.isVideo }))
    : INSTAGRAM_FALLBACK;
  return (
    <section id="reviews" className="px-5 sm:px-10 py-16 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-10">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
            What Our Customers Say
          </div>
          <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold tracking-tight text-[color:var(--brand)]">
            Real People. Real Results.
          </h2>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
            {reviews.map((r, i) => (
              <motion.div
                key={r.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
                className="rounded-2xl bg-white p-5 ring-1 ring-black/5 shadow-sm"
              >
                <p className="text-[13px] leading-relaxed text-[color:var(--brand)]/80 italic">
                  &ldquo;{r.text}&rdquo;
                </p>
                <div className="mt-4 flex items-center justify-between">
                  <div className="text-xs font-bold text-[color:var(--brand)]">— {r.name}</div>
                  <div className="flex gap-0.5 text-[color:var(--brand-orange)]">
                    {Array.from({ length: 5 }).map((_, k) => (
                      <Star key={k} className="h-3.5 w-3.5 fill-current" />
                    ))}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
          <a href="#products" className="mt-6 inline-flex text-sm font-semibold text-[color:var(--brand-orange)]">
            View All Reviews →
          </a>
        </div>

        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70 flex items-center gap-2">
            <Instagram className="h-3.5 w-3.5" /> Follow Us On Instagram
          </div>
          <h3 className="mt-3 font-display text-3xl font-semibold text-[color:var(--brand)]">
            @Mrs_samuelfruitjuice
          </h3>
          <ul className={`mt-6 grid gap-3 ${live ? "grid-cols-3" : "grid-cols-2"}`}>
            {tiles.map((t) => (
              <li key={t.url}>
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener"
                  title={captionLine(t.caption) || "Mrs. Samuel on Instagram"}
                  className={`group relative block overflow-hidden rounded-2xl ring-1 ring-black/5 ${live ? "aspect-square" : "aspect-[4/5]"}`}
                >
                  {t.image ? (
                    <img
                      src={t.image}
                      alt={captionLine(t.caption) || "Mrs. Samuel fresh juice on Instagram"}
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                    />
                  ) : (
                    <span className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-[color:var(--brand)] to-[#0f8a4c] p-4 text-white">
                      <Instagram className="h-5 w-5 opacity-80" aria-hidden />
                      <span className="text-[13px] font-medium leading-snug line-clamp-5">{captionLine(t.caption, 160)}</span>
                      <span className="text-[11px] font-bold uppercase tracking-[0.18em] opacity-80">
                        {t.isVideo ? "Watch reel" : "View post"} →
                      </span>
                    </span>
                  )}
                  {t.isVideo && (
                    <span className="pointer-events-none absolute inset-0 grid place-items-center">
                      <span className="grid h-12 w-12 place-items-center rounded-full bg-white/90 text-[color:var(--brand)] shadow-lg transition group-hover:scale-110">
                        <Play className="h-5 w-5 fill-current" aria-hidden />
                      </span>
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
          {live && tiles[0]?.caption && (
            <p className="mt-4 text-sm leading-relaxed text-[color:var(--brand)]/75">
              <span className="font-semibold">Latest:</span> {captionLine(tiles[0].caption, 220)}{" "}
              <a href={tiles[0].url} target="_blank" rel="noopener" className="underline">See post</a>
            </p>
          )}
          <a
            href={INSTAGRAM_PROFILE}
            target="_blank"
            rel="noopener"
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#f58529] via-[#dd2a7b] to-[#8134af] px-6 py-3 text-sm font-semibold text-white shadow-lg hover:opacity-90 transition"
          >
            <Instagram className="h-4 w-4" aria-hidden /> Follow @Mrs_samuelfruitjuice
          </a>
        </div>
      </div>
    </section>
  );
}
