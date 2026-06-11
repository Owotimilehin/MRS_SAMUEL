import { motion } from "framer-motion";
import bottleSunrise from "@/assets/bottle-sunrise.png";
import bottleRuby from "@/assets/bottle-ruby.png";
import bottleYellow from "@/assets/bottle-yellow.png";
import bottleGreen from "@/assets/bottle-green.png";
import bottlePink from "@/assets/bottle-pink.png";

const cats = [
  { name: "Citrus", img: bottleSunrise, bg: "#fdecd2" },
  { name: "Berry & Beet", img: bottleRuby, bg: "#fbd9de" },
  { name: "Tropical", img: bottleYellow, bg: "#fdf3c5" },
  { name: "Detox & Green", img: bottleGreen, bg: "#e5f0d2" },
  { name: "Specials", img: bottlePink, bg: "#fbd9e4" },
];

export function Categories() {
  return (
    <section id="categories" className="bg-white px-5 sm:px-10 py-16">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-end justify-between gap-6 mb-8">
          <div>
            <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
              <span className="h-px w-6 bg-[color:var(--brand)]/40" /> Explore Categories
            </div>
            <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold tracking-tight text-[color:var(--brand)]">
              Find Your Perfect Juice
            </h2>
          </div>
          <a href="#products" className="hidden sm:inline-flex text-sm font-semibold text-[color:var(--brand-orange)]">
            View All →
          </a>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-5">
          {cats.map((c, i) => (
            <motion.a
              key={c.name}
              href="#products"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05 }}
              className="group flex flex-col items-center text-center"
            >
              <span
                className="grid h-36 w-36 place-items-center rounded-full overflow-hidden shadow-md transition group-hover:scale-105 group-hover:shadow-lg"
                style={{ background: c.bg }}
              >
                <img src={c.img} alt={c.name} className="h-[115%] w-auto object-contain" />
              </span>
              <div className="mt-3 text-[14px] font-bold text-[color:var(--brand)]">{c.name}</div>
            </motion.a>
          ))}
        </div>
      </div>
    </section>
  );
}
