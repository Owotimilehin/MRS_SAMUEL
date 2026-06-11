import { motion } from "framer-motion";
import { Leaf, FlaskConical, Package, Droplets, ArrowRight } from "lucide-react";

const items = [
  { Icon: Leaf, title: "100% Real Fruit", sub: "Only real fruit, nothing else." },
  { Icon: FlaskConical, title: "No Preservatives", sub: "No artificial colours or preservatives." },
  { Icon: Package, title: "No Added Sugar", sub: "Naturally sweet and healthy." },
  { Icon: Droplets, title: "Cold Pressed", sub: "Retains nutrients and taste." },
];

export function Benefits() {
  return (
    <section id="benefits" className="px-5 sm:px-10 py-20">
      <div className="mx-auto max-w-7xl rounded-[2rem] bg-[#eef3da] px-6 sm:px-14 py-14 sm:py-16 grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-12 items-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--brand)]/70">
            Why Choose Mrs. Samuel?
          </div>
          <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold leading-tight text-[color:var(--brand)]">
            Fuel Your Body
            <br />
            Naturally
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-[color:var(--brand)]/70 max-w-md">
            Our juices are crafted to nourish your body, refresh your mind and
            keep you going strong — pressed fresh from Lagos every morning.
          </p>
          <a
            href="#story"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white pl-5 pr-4 py-3 text-sm font-semibold hover:bg-[color:var(--brand-orange)] transition"
          >
            Learn More
            <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15">
              <ArrowRight className="h-3 w-3" />
            </span>
          </a>
        </motion.div>

        <div className="grid grid-cols-2 gap-5 sm:gap-8">
          {items.map(({ Icon, title, sub }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="flex flex-col items-center text-center"
            >
              <span className="grid h-16 w-16 place-items-center rounded-full bg-white shadow-sm text-[color:var(--brand)]">
                <Icon className="h-7 w-7" />
              </span>
              <div className="mt-3 text-[15px] font-bold text-[color:var(--brand)]">{title}</div>
              <div className="mt-1 text-[12px] text-[color:var(--brand)]/65 max-w-[160px]">{sub}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
