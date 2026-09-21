import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Beaker, Palette, Package, Truck, Check } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { EnquiryForm } from "@/components/EnquiryForm";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/white-label")({
  head: () =>
    seo({
      title: "White Label Juice Production — Your Brand, Our Press | Mrs. Samuel",
      description:
        "Cold-pressed Nigerian fruit juice bottled under your own brand. Your recipe or ours, your label, your sizes. Cafés, hotels, gyms and retailers across Lagos.",
      path: "/white-label",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "White Label", path: "/white-label" }])],
    }),
  component: Page,
});

const steps = [
  { Icon: Beaker, title: "Agree the blend", desc: "Start from one of our recipes or bring your own. We press samples until it tastes right." },
  { Icon: Palette, title: "Put your brand on it", desc: "Your label, your bottle size, your story on the back. We handle the print run." },
  { Icon: Package, title: "We press and bottle", desc: "Made fresh to your order in our Lagos kitchen, to the same standard as our own juice." },
  { Icon: Truck, title: "Delivered to you", desc: "Scheduled drops across Lagos, or collection from us. Nationwide arranged on request." },
];

const suits = [
  "Cafés and restaurants wanting a house juice",
  "Hotels and short-lets stocking in-room drinks",
  "Gyms, studios and wellness brands",
  "Retailers building a private label",
  "Event planners and corporate gifting",
];

function Page() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="White Label"
        title={<>Your brand.<br /><span className="text-[color:var(--brand-orange)]">Our press.</span></>}
        subtitle="Real cold-pressed fruit juice, bottled under your own label. No added sugar, no preservatives — the same juice we put our own name on."
      />

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {steps.map((s, i) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.06 }}
              className="rounded-[1.25rem] bg-white ring-1 ring-black/5 p-6"
            >
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-[color:var(--brand-orange)]/10">
                <s.Icon className="h-5 w-5 text-[color:var(--brand-orange)]" />
              </div>
              <h3 className="mt-4 font-semibold text-[color:var(--brand)]">{s.title}</h3>
              <p className="mt-1.5 text-sm text-[color:var(--brand)]/70 leading-relaxed">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start">
          <div className="rounded-[1.5rem] bg-[color:var(--brand)] text-white p-8">
            <h2 className="font-display text-3xl">Who it&apos;s for</h2>
            <ul className="mt-6 space-y-3">
              {suits.map((s) => (
                <li key={s} className="flex items-start gap-3 text-sm text-white/85">
                  <Check className="h-4 w-4 shrink-0 mt-0.5 text-[color:var(--brand-orange)]" />
                  {s}
                </li>
              ))}
            </ul>
            <p className="mt-8 text-sm text-white/60 leading-relaxed">
              Minimum order quantities and pricing depend on the blend, bottle size and how often
              you want deliveries — so we quote per project rather than off a price list.
            </p>
          </div>

          <EnquiryForm
            enquiryType="white_label"
            cta="Discuss white labelling"
            template="Hi Mrs. Samuel — I'm interested in white label juice production."
          />
        </div>
      </section>
    </SiteShell>
  );
}
