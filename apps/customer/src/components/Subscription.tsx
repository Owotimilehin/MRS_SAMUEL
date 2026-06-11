import { motion } from "framer-motion";
import { Check, ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { SubscriptionPlan } from "@/lib/api/mappers";
import { formatNaira } from "@/lib/cart";
import bottleSunrise from "@/assets/bottle-sunrise.png";
import bottleGreen from "@/assets/bottle-green.png";
import bottleRuby from "@/assets/bottle-ruby.png";
import bottleGolden from "@/assets/bottle-golden.png";

export function Subscription({ plans }: { plans: SubscriptionPlan[] }) {
  if (plans.length === 0) return null;
  return (
    <section id="subscription" className="px-5 sm:px-10 py-16">
      <div className="mx-auto max-w-7xl grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-6">
        {/* Left: pitch */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="relative overflow-hidden rounded-[2rem] bg-[#eef3da] p-8 sm:p-10"
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
            Subscription Plans
          </div>
          <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold leading-tight text-[color:var(--brand)]">
            Freshness on
            <br />
            Repeat.
          </h2>
          <ul className="mt-6 space-y-2.5 text-[15px] text-[color:var(--brand)]/80">
            {["Save up to 20% every order", "Pause or cancel anytime", "Fresh bottles on your schedule"].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <Check className="h-4 w-4 text-[color:var(--brand-orange)]" /> {t}
              </li>
            ))}
          </ul>
          <Link
            to="/subscription"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white pl-5 pr-4 py-3 text-sm font-semibold hover:bg-[color:var(--brand-orange)] transition"
          >
            Explore Plans
            <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15">
              <ArrowRight className="h-3 w-3" />
            </span>
          </Link>

          {/* bottle row */}
          <div className="relative mt-8 h-40 sm:h-48">
            {[bottleSunrise, bottleGolden, bottleGreen, bottleRuby].map((b, i) => (
              <img
                key={i}
                src={b}
                alt=""
                aria-hidden
                className="absolute bottom-0 h-[100%] w-auto object-contain drop-shadow-[0_18px_20px_rgba(20,40,20,0.18)]"
                style={{ left: `${i * 22}%` }}
              />
            ))}
          </div>
        </motion.div>

        {/* Right: plans */}
        <div className="rounded-[2rem] bg-white p-6 sm:p-8 ring-1 ring-black/5">
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
            Choose Your Plan
          </div>
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
            {plans.map((p, i) => (
              <motion.div
                key={p.slug}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
                className={`relative rounded-2xl p-5 ring-1 ${
                  p.popular ? "ring-[color:var(--brand)] bg-[color:var(--cream)]" : "ring-black/10 bg-white"
                }`}
              >
                {p.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[color:var(--brand)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-white">
                    Most Popular
                  </span>
                )}
                <div className="font-display text-lg font-semibold text-[color:var(--brand)]">{p.name}</div>
                <div className="mt-1 text-[13px] font-bold text-[color:var(--brand-orange)]">{p.bottles}</div>
                <p className="mt-2 text-[12px] text-[color:var(--brand)]/65 leading-snug">{p.desc}</p>
                <div className="mt-4 font-display text-2xl font-semibold text-[color:var(--brand)]">
                  {formatNaira(p.price)}
                  <span className="text-xs font-medium text-[color:var(--brand)]/60">{p.period}</span>
                </div>
                <Link
                  to="/subscription"
                  className="mt-4 block w-full rounded-full bg-[color:var(--brand)] text-white py-2.5 text-center text-xs font-semibold hover:bg-[color:var(--brand-orange)] transition"
                >
                  Start Plan
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
