import { motion } from "framer-motion";
import { Star, Instagram } from "lucide-react";
import bottleSunrise from "@/assets/bottle-sunrise.png";
import bottleGreen from "@/assets/bottle-green.png";
import bottleRuby from "@/assets/bottle-ruby.png";
import bottleGolden from "@/assets/bottle-golden.png";

const reviews = [
  { name: "Adaeze M.", text: "I look forward to my delivery every Monday. Tastes like the fruit was picked an hour ago." },
  { name: "Tunde A.", text: "Swapped soft drinks for the Detox bottle. My skin and my mornings are different now." },
  { name: "Kemi O.", text: "The Pink Paradise is unreal. My kids fight over the last bottle." },
];

const ig = [
  { img: bottleSunrise, bg: "#fdecd2" },
  { img: bottleGolden, bg: "#fbe7a8" },
  { img: bottleRuby, bg: "#f4ccd2" },
  { img: bottleGreen, bg: "#e5f0d2" },
];

export function Testimonials() {
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
          <div className="mt-6 grid grid-cols-4 gap-3">
            {ig.map((g, i) => (
              <a
                key={i}
                href="https://instagram.com/Mrs_samuelfruitjuice"
                target="_blank"
                rel="noreferrer"
                className="group relative aspect-square overflow-hidden rounded-xl"
                style={{ background: g.bg }}
              >
                <img src={g.img} alt="" className="h-full w-full object-contain p-2 transition group-hover:scale-110" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
