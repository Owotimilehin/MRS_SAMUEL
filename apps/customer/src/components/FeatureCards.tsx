import { motion } from "framer-motion";
import { Leaf, BookOpen, Briefcase, Bike, ArrowRight } from "lucide-react";

const cards = [
  {
    tag: "Nutrition & Ingredients",
    title: "Real Ingredients, Real Benefits",
    sub: "See what's inside every bottle and why it matters.",
    Icon: Leaf,
    bg: "#fdecd2",
    href: "#products",
  },
  {
    tag: "Blog & Health Tips",
    title: "Live Healthy, Drink Fresh",
    sub: "Tips, recipes and stories from the Mrs. Samuel kitchen.",
    Icon: BookOpen,
    bg: "#e5f0d2",
    href: "#blog",
  },
  {
    tag: "Wholesale & Partnerships",
    title: "For Businesses & Events",
    sub: "Bulk orders for offices, gyms, weddings and retailers.",
    Icon: Briefcase,
    bg: "#fbe7a8",
    href: "#contact",
  },
  {
    tag: "Delivery Coverage",
    title: "We Deliver To You",
    sub: "Same-day cold delivery across Lagos. Nationwide on request.",
    Icon: Bike,
    bg: "#fbd9e4",
    href: "#contact",
  },
];

export function FeatureCards() {
  return (
    <section className="px-5 sm:px-10 py-12 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {cards.map((c, i) => (
          <motion.a
            key={c.title}
            href={c.href}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.07 }}
            className="group relative overflow-hidden rounded-2xl p-6 ring-1 ring-black/5"
            style={{ background: c.bg }}
          >
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/70 flex items-center gap-1.5">
              <c.Icon className="h-3.5 w-3.5" /> {c.tag}
            </div>
            <h3 className="mt-3 font-display text-xl font-semibold text-[color:var(--brand)] leading-tight">
              {c.title}
            </h3>
            <p className="mt-2 text-[12px] text-[color:var(--brand)]/70 leading-snug">{c.sub}</p>
            <div className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-[color:var(--brand-orange)] group-hover:gap-2 transition-all">
              Learn More <ArrowRight className="h-3 w-3" />
            </div>
          </motion.a>
        ))}
      </div>
    </section>
  );
}
