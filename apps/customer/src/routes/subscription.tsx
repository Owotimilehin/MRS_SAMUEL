import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, Calendar, Repeat, Truck } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { fetchSubscriptionPlans, requestSubscription } from "@/lib/api/server-fns";
import bottleGreen from "@/assets/bottle-green.png";

export const Route = createFileRoute("/subscription")({
  loader: async () => ({ plans: await fetchSubscriptionPlans() }),
  head: () => ({
    meta: [
      { title: "Subscription — Mrs. Samuel Fruit Juice" },
      { name: "description", content: "Fresh, cold-pressed juice delivered to your door on your schedule. Weekly, monthly detox, or family plans." },
      { property: "og:title", content: "Subscription — Mrs. Samuel" },
      { property: "og:description", content: "Goodness delivered. Skip or cancel anytime." },
    ],
  }),
  component: Page,
});

// Fire-and-forget interest signal when a visitor clicks a plan CTA. The real
// details are captured in the WhatsApp thread the CTA opens; this just registers
// the lead so the owner gets a heads-up. Placeholder phone satisfies API
// validation (min 7 chars) since the public CTA has no form fields.
function registerInterest(planSlug: string): void {
  void requestSubscription({ data: { name: "Website visitor", phone: "0000000", plan_slug: planSlug } }).catch(
    () => {
      /* best-effort; WhatsApp is the real channel */
    },
  );
}

const steps = [
  { Icon: Calendar, title: "Pick a plan", desc: "Weekly, monthly detox, or family. Change later anytime." },
  { Icon: Repeat, title: "Customise your bottles", desc: "Tell us your flavour preferences and any ingredient you don't want." },
  { Icon: Truck, title: "We deliver fresh", desc: "Pressed at sunrise, delivered the same morning across Lagos." },
];

function Page() {
  const { plans } = Route.useLoaderData();
  return (
    <SiteShell>
      <PageHero
        eyebrow="Subscription Plans"
        title={<>Goodness delivered<br /><span className="text-[color:var(--brand-orange)]">to your door.</span></>}
        subtitle="A subscription means you stop thinking about juice and start drinking it. We press, we deliver, we take the empties back. You drink."
        decor={bottleGreen}
        accent="#a8d27a"
      />

      {/* Plans */}
      <section id="subscription" className="px-5 sm:px-10 max-w-7xl mx-auto pb-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {plans.map((p, i) => (
            <motion.div
              key={p.slug}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, delay: i * 0.06 }}
              className={`relative rounded-[1.5rem] p-7 ring-1 ${
                p.popular
                  ? "bg-[color:var(--brand)] text-white ring-[color:var(--brand)] shadow-xl scale-[1.02]"
                  : "bg-white text-[color:var(--brand)] ring-black/5"
              }`}
            >
              {p.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[color:var(--brand-orange)] text-white text-[10px] font-bold uppercase tracking-[0.22em] px-3 py-1">
                  Most Popular
                </span>
              )}
              <h3 className="font-display text-2xl">{p.name}</h3>
              <div className={`text-xs font-bold uppercase tracking-[0.18em] mt-1 ${p.popular ? "text-white/60" : "text-[color:var(--brand-orange)]"}`}>{p.bottles}</div>
              <p className={`mt-3 text-sm ${p.popular ? "text-white/80" : "text-[color:var(--brand)]/70"}`}>{p.desc}</p>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="font-display text-4xl font-semibold">₦{p.price.toLocaleString("en-NG")}</span>
                <span className={`text-sm ${p.popular ? "text-white/70" : "text-[color:var(--brand)]/60"}`}>{p.period}</span>
              </div>
              <ul className="mt-5 space-y-2">
                {p.perks.map((perk) => (
                  <li key={perk} className="flex items-start gap-2 text-sm">
                    <Check className={`h-4 w-4 mt-0.5 ${p.popular ? "text-[color:var(--brand-orange)]" : "text-[color:var(--brand-orange)]"}`} />
                    <span>{perk}</span>
                  </li>
                ))}
              </ul>
              <a
                href={`https://wa.me/2349019512246?text=${encodeURIComponent(`Hi Mrs. Samuel — I'd like to subscribe to the ${p.name}.`)}`}
                target="_blank"
                rel="noreferrer"
                onClick={() => registerInterest(p.slug)}
                className={`mt-7 inline-flex items-center justify-center rounded-full px-5 py-3 text-sm font-semibold transition w-full ${
                  p.popular
                    ? "bg-[color:var(--brand-orange)] text-white hover:opacity-90"
                    : "bg-[color:var(--brand)] text-white hover:bg-[color:var(--brand-orange)]"
                }`}
              >
                Start this plan
              </a>
            </motion.div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-20">
        <h2 className="font-display text-3xl text-[color:var(--brand)]">How it works</h2>
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          {steps.map(({ Icon, title, desc }, i) => (
            <div key={title} className="rounded-2xl bg-white p-6 ring-1 ring-black/5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-[color:var(--brand-orange)]/10 text-[color:var(--brand-orange)]">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-xs font-bold text-[color:var(--brand-orange)]">STEP {i + 1}</span>
              </div>
              <h3 className="mt-3 font-display text-xl text-[color:var(--brand)]">{title}</h3>
              <p className="mt-2 text-sm text-[color:var(--brand)]/70 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
