import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Users, CalendarDays, Building2, Gift, Check } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { EnquiryForm } from "@/components/EnquiryForm";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/bulk-orders")({
  head: () =>
    seo({
      title: "Bulk Juice Orders — Events, Offices & Trade | Mrs. Samuel",
      description:
        "Cold-pressed fruit juice in quantity for events, offices, weddings and trade. Crate pricing, scheduled Lagos delivery, no added sugar or preservatives.",
      path: "/bulk-orders",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Bulk Orders", path: "/bulk-orders" }])],
    }),
  component: Page,
});

const occasions = [
  { Icon: CalendarDays, title: "Weddings & parties", desc: "Chilled crates delivered the morning of, so nothing sits warm overnight." },
  { Icon: Building2, title: "Offices & meetings", desc: "Standing weekly or monthly drops for the fridge, invoiced together." },
  { Icon: Users, title: "Conferences & pop-ups", desc: "Volume for a crowd, delivered to the venue on your schedule." },
  { Icon: Gift, title: "Corporate gifting", desc: "Branded crates and hampers for clients and staff." },
];

const included = [
  "Better per-bottle pricing as quantity goes up",
  "Mix flavours and sizes across the order",
  "Delivery scheduled to your date and time",
  "Pressed to order — never sitting in a warehouse",
  "Invoice and payment terms for businesses",
];

function Page() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Bulk Orders"
        title={<>Juice for<br /><span className="text-[color:var(--brand-orange)]">a full room.</span></>}
        subtitle="Crates of cold-pressed juice for events, offices and trade — pressed to order and delivered chilled across Lagos."
      />

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {occasions.map((o, i) => (
            <motion.div
              key={o.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.06 }}
              className="rounded-[1.25rem] bg-white ring-1 ring-black/5 p-6"
            >
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-[color:var(--brand-orange)]/10">
                <o.Icon className="h-5 w-5 text-[color:var(--brand-orange)]" />
              </div>
              <h3 className="mt-4 font-semibold text-[color:var(--brand)]">{o.title}</h3>
              <p className="mt-1.5 text-sm text-[color:var(--brand)]/70 leading-relaxed">{o.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start">
          <div className="rounded-[1.5rem] bg-[color:var(--brand)] text-white p-8">
            <h2 className="font-display text-3xl">What you get</h2>
            <ul className="mt-6 space-y-3">
              {included.map((s) => (
                <li key={s} className="flex items-start gap-3 text-sm text-white/85">
                  <Check className="h-4 w-4 shrink-0 mt-0.5 text-[color:var(--brand-orange)]" />
                  {s}
                </li>
              ))}
            </ul>
            <p className="mt-8 text-sm text-white/60 leading-relaxed">
              Tell us the date, roughly how many people and which flavours you&apos;re after, and
              we&apos;ll come back with a quote. Larger orders need a few days&apos; notice so
              everything is pressed fresh.
            </p>
          </div>

          <EnquiryForm
            enquiryType="bulk_order"
            cta="Request a bulk quote"
            template="Hi Mrs. Samuel — I'd like a quote for a bulk juice order."
          />
        </div>
      </section>
    </SiteShell>
  );
}
