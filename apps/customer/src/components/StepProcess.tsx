import { motion } from "framer-motion";
import { Sprout, Droplets, Snowflake, Package, Truck } from "lucide-react";

const steps = [
  { Icon: Sprout, title: "Picked Fresh", sub: "Sourced from Nigerian farms we know by name." },
  { Icon: Droplets, title: "Washed & Sorted", sub: "Every fruit is rinsed and inspected by hand." },
  { Icon: Snowflake, title: "Cold Pressed", sub: "Pressed slow and cold so nutrients stay intact." },
  { Icon: Package, title: "Bottled Daily", sub: "Filled the same morning in our Lagos kitchen." },
  { Icon: Truck, title: "Delivered Fresh", sub: "At your door, still chilled, still vibrant." },
];

export function StepProcess() {
  return (
    <section id="process" className="bg-white px-5 sm:px-10 py-20">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-end justify-between gap-6 mb-10">
          <div>
            <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
              <span className="h-px w-6 bg-[color:var(--brand)]/40" /> How It's Made
            </div>
            <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold tracking-tight text-[color:var(--brand)]">
              From Fruit to Bottle in 5 Steps
            </h2>
          </div>
          <a href="#story" className="hidden sm:inline-flex text-sm font-semibold text-[color:var(--brand-orange)]">
            Learn More →
          </a>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
          {steps.map(({ Icon, title, sub }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.07 }}
              className="relative flex flex-col items-center text-center"
            >
              <span className="relative grid h-28 w-28 place-items-center rounded-full bg-[#fdf1cf] text-[color:var(--brand)] ring-1 ring-[color:var(--brand)]/10 shadow-sm">
                <Icon className="h-11 w-11" />
                <span className="absolute -top-1 -right-1 grid h-8 w-8 place-items-center rounded-full bg-[color:var(--brand)] text-white text-xs font-bold shadow">
                  {i + 1}
                </span>
              </span>
              <div className="mt-4 text-[15px] font-bold text-[color:var(--brand)]">{title}</div>
              <div className="mt-1 text-[12px] text-[color:var(--brand)]/65 max-w-[170px]">{sub}</div>
              {i < steps.length - 1 && (
                <span className="hidden md:block absolute top-14 left-[75%] w-[50%] border-t-2 border-dashed border-[color:var(--brand)]/25" />
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
