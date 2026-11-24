import { createFileRoute, Link } from "@tanstack/react-router";
import { Users, CalendarDays, Building2, Gift } from "lucide-react";
import { ServiceLanding, type ServiceFaq } from "@/components/ServiceLanding";
import { seo, breadcrumbLd, faqPageLd, serviceLd } from "@/lib/seo";
import clusterWatermelon from "@/assets/decor/cluster-watermelon.webp";

const PATH = "/bulk-orders";
const DESCRIPTION =
  "Cold-pressed fruit juice in quantity for events, offices, weddings and trade. Crate pricing, scheduled Lagos delivery, no added sugar or preservatives.";

// Owner confirmed (23 Nov 2026): minimum order is 1 bottle, no maximum.
// TODO(owner): confirm crate sizes and the per-bottle pricing tiers if you
// want them published.
// TODO(owner): confirm daily pressing capacity (largest single order you can
// take, and how much notice it needs).
// TODO(owner): confirm NAFDAC registration status/number before it is mentioned.
// TODO(owner): share 1–3 bulk-order case studies (client name only with their
// permission) to add as a "Recent orders" section.
const FAQS: ServiceFaq[] = [
  {
    q: "What is the minimum for a bulk order?",
    a: "There is no minimum beyond one bottle, and no maximum. Tell us roughly how many bottles or guests you are planning for and your date, and we will quote and plan the pressing.",
  },
  {
    q: "How is bulk juice priced?",
    a: "We quote per order. The price depends on the number of bottles, the sizes and flavours, and the delivery address in Lagos. Per-bottle pricing gets better as the quantity goes up. Ask us for a quote and we will send one back.",
  },
  {
    q: "Can I mix flavours and sizes in one order?",
    a: "Yes. You can mix flavours and sizes across a bulk order. We bottle in 330ml and 650ml; availability of each size depends on the flavour, so ask us what is possible for your date.",
  },
  {
    q: "How much notice do you need?",
    a: "As much as you can give. Every bottle is pressed to order, so larger orders need a few days' notice for us to plan the pressing. Get in touch as soon as your date is fixed, even if the numbers are not final.",
  },
  {
    q: "How long does the juice keep?",
    a: "About 48 hours from pressing, kept refrigerated at 2–6°C. It is cold-pressed with no preservatives, so plan cold storage before delivery and serve it fresh.",
  },
  {
    q: "Do you deliver bulk orders across Lagos?",
    a: "Yes. We deliver chilled crates all round Lagos, scheduled to your date and time. Other cities are by special arrangement: message us on WhatsApp on 0901 951 2246.",
  },
  {
    q: "Do you offer invoices and payment terms for businesses?",
    a: "Yes. Business orders come with an invoice, and we can discuss payment terms for standing or repeat orders.",
  },
];

export const Route = createFileRoute("/bulk-orders")({
  head: () =>
    seo({
      title: "Bulk Juice Orders — Events, Offices & Trade | Mrs. Samuel",
      description: DESCRIPTION,
      path: PATH,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Bulk Orders", path: PATH },
        ]),
        serviceLd({
          name: "Bulk cold-pressed juice orders in Lagos",
          serviceType: "Bulk drinks supply",
          description: DESCRIPTION,
          path: PATH,
        }),
        faqPageLd(FAQS),
      ],
    }),
  component: Page,
});

const linkCls = "font-semibold underline underline-offset-2 hover:text-[color:var(--brand-orange)]";

function Page() {
  return (
    <ServiceLanding
      eyebrow="Bulk Orders"
      title={
        <>
          Juice for
          <br />
          <span className="text-[color:var(--brand-orange)]">a full room.</span>
        </>
      }
      subtitle="Crates of cold-pressed juice for events, offices and trade — pressed to order and delivered chilled across Lagos."
      decor={clusterWatermelon}
      accent="#f7a8b0"
      intro={[
        "When you need juice for more than a handful of people, a supermarket run does not cut it. Mrs. Samuel presses fruit juice in quantity for weddings, parties, offices, conferences, gifting and trade, and delivers it chilled across Lagos on the day and time you choose.",
        "Every bottle is 100% fruit and vegetables, cold-pressed in our kitchen in Ajao Estate, Ikeja, with no added sugar, no water and no preservatives. It is the same juice we sell one bottle at a time, just more of it. Over 40,000 bottles shared so far.",
      ]}
      cardsHeading="Who orders in bulk"
      cards={[
        {
          Icon: CalendarDays,
          title: "Weddings & parties",
          desc: "Chilled crates delivered close to the event, so nothing sits warm overnight.",
        },
        {
          Icon: Building2,
          title: "Offices & meetings",
          desc: "Standing weekly or monthly drops for the fridge, invoiced together.",
        },
        {
          Icon: Users,
          title: "Conferences & pop-ups",
          desc: "Volume for a crowd, delivered to the venue on your schedule.",
        },
        {
          Icon: Gift,
          title: "Corporate gifting",
          desc: "Branded crates and hampers for clients and staff.",
        },
      ]}
      sections={[
        {
          heading: "Bulk juice for every occasion",
          body: [
            <>
              Planning a wedding, owambe or birthday? Our{" "}
              <Link to="/events-juice-lagos" className={linkCls}>
                juice for events
              </Link>{" "}
              page covers how much to order per guest and how to keep it cold at the venue. Setting
              up a staff fridge or a wellness day? See{" "}
              <Link to="/corporate" className={linkCls}>
                office juice supply
              </Link>
              . Sending hampers at Christmas or Valentine&apos;s Day? Start with{" "}
              <Link to="/gifts" className={linkCls}>
                juice gifts and hampers
              </Link>
              .
            </>,
            "Whatever the occasion, the process is the same: you tell us what you need, we suggest quantities and flavours, we send a quote, and we press and deliver your order fresh.",
          ],
        },
        {
          heading: "How bulk ordering works",
          body: [
            "We keep it simple and talk it through with you on WhatsApp, so there is one conversation from first question to delivery.",
          ],
          bullets: [
            "Send us your date, delivery address and a rough number of bottles or guests.",
            "We suggest sizes and a flavour mix that suits your crowd and your budget.",
            "You get a quote. Once you confirm, we plan the pressing around your date.",
            "Your juice is pressed fresh and delivered chilled to the person you name.",
          ],
        },
        {
          heading: "Sizes and flavours",
          body: [
            <>
              We bottle in 330ml and 650ml, and you can mix flavours and sizes across one order.
              Smaller bottles suit events where guests walk around and staff fridges where one
              bottle is one serving. Larger bottles suit tables where drinks are poured into
              glasses. Browse{" "}
              <Link to="/juices" className={linkCls}>
                our full range of juices
              </Link>{" "}
              to choose your mix, from orange and pineapple to ginger blends and green juice.
            </>,
          ],
        },
        {
          heading: "Pricing and minimum order",
          body: [
            "We do not publish a fixed bulk price list, because every order is different. Your quote depends on the number of bottles, the sizes and flavours you pick, and where in Lagos we are delivering. What does not change: per-bottle pricing gets better as quantity goes up.",
            "The minimum order is one bottle and there is no maximum. Ask us for a quote with your rough numbers and date, and we will confirm the options that make sense for you.",
          ],
        },
        {
          heading: "Freshness and storage",
          body: [
            "Our juice is cold-pressed and has no preservatives. That is what makes it taste like real fruit, and it is also why it needs a little care. Keep it refrigerated at 2–6°C from the moment it arrives and drink it within 48 hours of pressing.",
          ],
          bullets: [
            "Plan fridge or cooler space for the full order before delivery day.",
            "Keep crates out of direct sun and pack coolers with ice at events.",
            "Bring bottles out in batches so each one is served cold.",
          ],
        },
        {
          heading: "Scheduled delivery across Lagos",
          body: [
            <>
              We deliver bulk orders chilled all round Lagos, scheduled to your date and time, from
              our kitchen at 30 Asa Afariogun Street, Ajao Estate, Ikeja. See{" "}
              <Link to="/juice-delivery-lagos" className={linkCls}>
                fresh juice delivery in Lagos
              </Link>{" "}
              for the areas we cover. Deliveries outside Lagos are by special arrangement.
            </>,
            <>
              Want juice under your own brand for a café, hotel or shop? That is{" "}
              <Link to="/white-label" className={linkCls}>
                white label juice production
              </Link>
              .
            </>,
          ],
        },
      ]}
      checklistHeading="What you get"
      checklist={[
        "Better per-bottle pricing as quantity goes up",
        "Mix flavours and sizes across the order",
        "Delivery scheduled to your date and time",
        "Pressed to order — never sitting in a warehouse",
        "Invoice and payment terms for businesses",
      ]}
      checklistNote="Tell us the date, roughly how many people and which flavours you're after, and we'll come back with a quote. Larger orders need a few days' notice so everything is pressed fresh."
      enquiry={{
        type: "bulk_order",
        cta: "Request a bulk quote",
        template: "Hi Mrs. Samuel — I'd like a quote for a bulk juice order.",
        leadSource: "bulk_orders",
      }}
      faqs={FAQS}
      related={[
        { to: "/events-juice-lagos", label: "Juice for events" },
        { to: "/corporate", label: "Office juice supply" },
        { to: "/gifts", label: "Juice gifts and hampers" },
      ]}
    />
  );
}
