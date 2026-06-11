import { motion } from "framer-motion";
import bottleSunrise from "@/assets/bottle-sunrise.png";
import bottleGolden from "@/assets/bottle-golden.png";
import bottleRuby from "@/assets/bottle-ruby.png";
import clusterCitrus from "@/assets/decor/cluster-citrus.png";

const paragraphs = [
  "Mrs. Samuel Fruit Juice began in September of last year — in a small Lagos kitchen, with one cold press, two believers, and the quiet conviction that Nigerians deserved juice they could actually trust.",
  "There was no warehouse. No investors. No shortcuts. Only sun-ripened fruit sourced directly from Nigerian farmers, pressed before sunrise, and delivered the same morning to the first handful of families who said yes.",
  "What started as a single bottle on a single counter has grown into more than forty thousand bottles shared across homes, offices, gyms and quiet weekday breakfasts — every one of them traceable to the farm it came from.",
  "Today, Mrs. Samuel is preparing for its biggest chapter yet: new production lines capable of pressing up to five thousand bottles a day, partnerships with fruit cooperatives across the country, and a continued commitment to zero added sugar, zero preservatives, and zero waste.",
  "Because for us, this was never only about juice. It is about building something honest in a market that rarely is — and proving that fresh, premium, locally-made Nigerian wellness belongs on every table.",
];

const milestones = [
  { number: "40K+", label: "Bottles pressed and shared since launch" },
  { number: "20", label: "Signature blends on the menu" },
  { number: "0", label: "Added sugar, preservatives, concentrates" },
  { number: "5K/day", label: "Production capacity in development" },
];

export function Story() {
  return (
    <section id="story" className="relative px-5 sm:px-10 py-24 overflow-hidden">
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.3fr] gap-12 lg:gap-16 items-center">
          {/* Bottle composition */}
          <div className="relative h-[460px] sm:h-[560px] w-full order-2 lg:order-1">
            <img src={clusterCitrus} alt="" aria-hidden className="absolute -left-6 bottom-2 w-[55%] opacity-80" />
            <div
              className="absolute inset-0 m-auto h-[78%] w-[78%] rounded-full blur-3xl opacity-70"
              style={{ background: "radial-gradient(circle, #ffd071 0%, transparent 65%)" }}
            />
            <motion.img
              src={bottleGolden} alt="" aria-hidden
              animate={{ y: [0, -10, 0] }} transition={{ duration: 7, repeat: Infinity }}
              className="absolute left-[2%] bottom-12 h-[68%] drop-shadow-2xl"
            />
            <motion.img
              src={bottleSunrise} alt="" aria-hidden
              animate={{ y: [0, -14, 0] }} transition={{ duration: 6, repeat: Infinity }}
              className="absolute left-1/2 -translate-x-1/2 bottom-0 h-[90%] drop-shadow-2xl z-10"
            />
            <motion.img
              src={bottleRuby} alt="" aria-hidden
              animate={{ y: [0, -10, 0] }} transition={{ duration: 7.5, repeat: Infinity, delay: 0.4 }}
              className="absolute right-[2%] bottom-12 h-[68%] drop-shadow-2xl"
            />
          </div>

          {/* Editorial copy */}
          <div className="order-1 lg:order-2">
            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
              Our Story
            </div>
            <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold leading-[1.04] text-[color:var(--brand)]">
              From one kitchen to{" "}
              <span className="italic text-[color:var(--brand-orange)]">forty thousand bottles.</span>
            </h2>

            <div className="mt-7 space-y-5">
              {paragraphs.map((p, i) => (
                <motion.p
                  key={i}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{ delay: i * 0.06 }}
                  className="text-[15.5px] leading-[1.75] text-[color:var(--brand)]/80"
                >
                  {p}
                </motion.p>
              ))}
            </div>

            <div className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-4">
              {milestones.map((m) => (
                <div key={m.label} className="rounded-2xl bg-white p-4 ring-1 ring-black/5">
                  <div className="font-display text-2xl font-semibold text-[color:var(--brand-orange)]">{m.number}</div>
                  <div className="mt-1 text-[11px] uppercase tracking-wide text-[color:var(--brand)]/65 leading-snug">{m.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
