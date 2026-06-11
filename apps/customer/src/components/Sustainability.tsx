import { motion } from "framer-motion";
import { Sprout, Users, Recycle, TrendingUp, ArrowRight } from "lucide-react";

const stats = [
  { Icon: TrendingUp, value: "30–50%", label: "of Nigerian fruit is lost after harvest." },
  { Icon: Sprout, value: "100%", label: "of our fruit is grown on Nigerian farms." },
  { Icon: Recycle, value: "0", label: "preservatives, additives or concentrates." },
  { Icon: Users, value: "5,000", label: "bottles a day — new lines on the way." },
];

export function Sustainability() {
  return (
    <section id="mission" className="px-5 sm:px-10 py-20">
      <div className="mx-auto max-w-7xl rounded-[2rem] bg-[color:var(--brand)] text-white px-6 sm:px-14 py-16 relative overflow-hidden">
        <div
          className="absolute -top-32 -right-32 h-96 w-96 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(circle, #e85d1c 0%, transparent 70%)" }}
        />
        <div className="relative grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-12 items-center">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-white/60">
              Our Mission
            </div>
            <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold leading-[1.05]">
              Less waste.
              <br />
              <span className="text-[color:var(--brand-orange)] italic">More value.</span>
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-white/75 max-w-lg">
              Every year Nigeria loses thousands of tons of mangoes, oranges,
              pineapples and watermelons — fruit grown with hard work, lost
              before it ever reaches a glass. We started Mrs. Samuel to be
              part of the answer: when fruit gets processed, farmers earn more,
              waste falls, jobs are created, and the country grows stronger.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed text-white/75 max-w-lg">
              To every farmer, cooperative and distributor reading this —
              partner with us. Let's reduce waste together. Let's create value
              together.
            </p>
            <a
              href="#contact"
              className="mt-7 inline-flex items-center gap-2 rounded-full bg-[color:var(--brand-orange)] text-white pl-5 pr-4 py-3 text-sm font-semibold hover:bg-white hover:text-[color:var(--brand)] transition"
            >
              Partner With Us
              <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15">
                <ArrowRight className="h-3 w-3" />
              </span>
            </a>
          </div>

          <div className="grid grid-cols-2 gap-5">
            {stats.map(({ Icon, value, label }, i) => (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.07 }}
                className="rounded-2xl bg-white/8 ring-1 ring-white/15 backdrop-blur-sm p-5"
              >
                <Icon className="h-6 w-6 text-[color:var(--brand-orange)]" />
                <div className="mt-4 font-display text-3xl font-semibold">{value}</div>
                <div className="mt-1 text-[12px] text-white/70 leading-snug">{label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
