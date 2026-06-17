import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, Calendar, Repeat, Truck, Loader2, X } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { fetchSubscriptionPlans, subscribe } from "@/lib/api/server-fns";
import { launchPayazaCheckout } from "@/lib/payaza";
import type { ApiSubscriptionPlan } from "@/lib/api/types";
import bottleGreen from "@/assets/bottle-green.png";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/subscription")({
  loader: async () => ({ plans: await fetchSubscriptionPlans() }),
  head: () =>
    seo({
      title: "Juice Subscription — Fresh Delivery on Your Schedule | Mrs. Samuel",
      description:
        "Fresh, cold-pressed juice delivered to your door on your schedule — weekly, monthly detox, or family plans. Skip or cancel anytime. Lagos delivery.",
      path: "/subscription",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Subscription", path: "/subscription" }])],
    }),
  component: Page,
});

const steps = [
  { Icon: Calendar, title: "Pick a plan", desc: "Weekly, monthly detox, or family. Change later anytime." },
  { Icon: Repeat, title: "Customise your bottles", desc: "Tell us your flavour preferences and any ingredient you don't want." },
  { Icon: Truck, title: "We deliver fresh", desc: "Pressed at sunrise, delivered the same morning across Lagos." },
];

function Page() {
  const { plans } = Route.useLoaderData();
  const [selected, setSelected] = useState<ApiSubscriptionPlan | null>(null);
  return (
    <SiteShell>
      {selected && <SubscribeModal plan={selected} onClose={() => setSelected(null)} />}
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
              <button
                type="button"
                onClick={() => setSelected(p)}
                className={`mt-7 inline-flex items-center justify-center rounded-full px-5 py-3 text-sm font-semibold transition w-full ${
                  p.popular
                    ? "bg-[color:var(--brand-orange)] text-white hover:opacity-90"
                    : "bg-[color:var(--brand)] text-white hover:bg-[color:var(--brand-orange)]"
                }`}
              >
                Start this plan
              </button>
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

function SubscribeModal({ plan, onClose }: { plan: ApiSubscriptionPlan; onClose: () => void }) {
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setError(null);
    if (!form.name.trim() || form.phone.trim().length < 7) {
      setError("Please enter your name and a valid phone number.");
      return;
    }
    setBusy(true);
    try {
      const res = await subscribe({
        data: {
          plan_slug: plan.slug,
          customer: {
            name: form.name.trim(),
            phone: form.phone.trim(),
            ...(form.email.trim() ? { email: form.email.trim() } : {}),
            ...(form.address.trim() ? { address: form.address.trim() } : {}),
          },
        },
      });
      await launchPayazaCheckout(res.payment.payaza, {
        onPaid: () => setDone(true),
        onClose: () => setBusy(false),
      });
    } catch {
      setError("Something went wrong starting your subscription. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 text-[color:var(--brand)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display text-2xl">{plan.name}</h3>
            <p className="text-sm text-[color:var(--brand)]/60">
              ₦{plan.price.toLocaleString("en-NG")} {plan.period}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="mt-6 text-center">
            <Check className="mx-auto h-10 w-10 text-[color:var(--brand-orange)]" />
            <p className="mt-3 text-sm">
              You're subscribed to the {plan.name}. We'll prepare and deliver each cycle —
              you can cancel anytime.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 w-full rounded-full bg-[color:var(--brand)] px-5 py-3 text-sm font-semibold text-white"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {(["name", "phone", "email", "address"] as const).map((field) => (
              <input
                key={field}
                value={form[field]}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                placeholder={
                  field === "name"
                    ? "Full name"
                    : field === "phone"
                      ? "Phone number"
                      : field === "email"
                        ? "Email (optional)"
                        : "Delivery address (optional)"
                }
                className="w-full rounded-xl border border-black/10 px-4 py-3 text-sm outline-none focus:border-[color:var(--brand-orange)]"
              />
            ))}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--brand-orange)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Opening payment…
                </>
              ) : (
                <>Subscribe — ₦{plan.price.toLocaleString("en-NG")}</>
              )}
            </button>
            <p className="text-center text-[11px] text-[color:var(--brand)]/50">
              You'll pay securely via Payaza. Cancel anytime.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
