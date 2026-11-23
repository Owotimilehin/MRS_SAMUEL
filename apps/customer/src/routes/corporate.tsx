import { createFileRoute, Link } from "@tanstack/react-router";
import { Refrigerator, Presentation, HeartPulse, Gift } from "lucide-react";
import { ServiceLanding, type ServiceFaq } from "@/components/ServiceLanding";
import { seo, breadcrumbLd, faqPageLd, serviceLd } from "@/lib/seo";
import clusterGreen from "@/assets/decor/cluster-green.png";

const PATH = "/corporate";
const DESCRIPTION =
  "Office juice supply in Lagos: weekly or monthly fridge drops, juice for meetings, staff wellness days and corporate gifts. Cold-pressed, no added sugar.";

// Owner confirmed (23 Nov 2026): minimum order is 1 bottle, no maximum.
// TODO(owner): confirm any per-bottle
// pricing tiers and payment terms (e.g. invoice net 30) before they are
// published here. Until then the page says "Ask us for a quote".
const FAQS: ServiceFaq[] = [
  {
    q: "How does office juice delivery work?",
    a: "You agree a standing drop with us, weekly or monthly, and we deliver chilled juice to your office on the agreed day. Standing drops are invoiced together, so your admin team handles one invoice instead of many receipts.",
  },
  {
    q: "How much juice should we order for the office?",
    a: "Order what your team will drink within two days, because fresh juice keeps for about 48 hours in the fridge. Count your regular drinkers rather than your full headcount, and plan around office days if you work a hybrid week. Starting modest and adjusting after a couple of weeks works well.",
  },
  {
    q: "Is there a minimum order for offices?",
    a: "No. The minimum order is one bottle and there is no maximum, so a small team can start with a handful and a large office can order as much as it needs. Tell us roughly how many people you want to cater for and we will suggest a plan. WhatsApp us on 0901 951 2246 or use the form on this page.",
  },
  {
    q: "Can you supply juice for a wellness day or health week?",
    a: "Yes. We supply chilled juice for wellness days, health talks and step challenges, including lower-sugar green and vegetable blends. Juice is a nourishing drink, not a cure for anything, so we suggest it sits alongside water and good food in your programme.",
  },
  {
    q: "Do you deliver to offices on the Island and Lekki?",
    a: "We deliver cold all round Lagos, from our kitchen in Ajao Estate, Ikeja, to Victoria Island, Ikoyi, Lekki and across the mainland. If you are not sure we reach you, message us your address.",
  },
  {
    q: "Can we get an invoice?",
    a: "Yes. Business orders come with an invoice, and standing weekly or monthly drops are invoiced together. Tell us who should receive the invoice when you set up your order.",
  },
];

export const Route = createFileRoute("/corporate")({
  head: () =>
    seo({
      title: "Office Juice Supply in Lagos & Wellness Days | Mrs. Samuel",
      description: DESCRIPTION,
      path: PATH,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Corporate Juice Supply", path: PATH },
        ]),
        serviceLd({
          name: "Office juice supply and staff wellness days in Lagos",
          serviceType: "Corporate drinks supply",
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
      eyebrow="Corporate · Lagos"
      title={
        <>
          Fresh juice for your office,{" "}
          <span className="text-[color:var(--brand-orange)]">delivered cold.</span>
        </>
      }
      subtitle="Standing fridge drops, juice for meetings, staff wellness days and corporate gifts, cold-pressed in Ikeja and delivered across Lagos."
      decor={clusterGreen}
      accent="#a8d27a"
      intro={[
        "By the time your team has battled Third Mainland Bridge or the Ikorodu Road traffic, they deserve something better than a warm soft drink from the vending machine. Office juice supply from Mrs. Samuel puts fresh, cold-pressed juice in the fridge without anyone having to remember to buy it.",
        "Every bottle is 100% fruit and vegetables, pressed in our kitchen in Ajao Estate, Ikeja, with no added sugar and no preservatives. A fridge stocked with real juice is a small, visible sign that a company cares about the people who work there, and it is a welcome change at meetings and client visits.",
      ]}
      cardsHeading="How companies use our juice"
      cards={[
        {
          Icon: Refrigerator,
          title: "Office fridge drops",
          desc: "Standing weekly or monthly deliveries for the staff fridge or reception, invoiced together.",
        },
        {
          Icon: Presentation,
          title: "Meetings & board days",
          desc: "Chilled bottles for trainings, pitches and board days, in a mix of familiar and lighter flavours.",
        },
        {
          Icon: HeartPulse,
          title: "Wellness days",
          desc: "Green and vegetable blends for health weeks, talks and step challenges.",
        },
        {
          Icon: Gift,
          title: "Corporate gifts",
          desc: "Branded crates and hampers for clients, partners and staff at year end.",
        },
      ]}
      sections={[
        {
          heading: "Standing office drops",
          body: [
            "The simplest setup is a standing order. Instead of placing a new order each time the fridge runs low, you agree a regular drop with us. Weekly drops suit offices where juice is part of everyday life. Monthly drops suit teams that want juice for a town hall, team day or end-of-month celebration.",
            "Because the juice has no preservatives, it should be kept at 2–6°C and drunk within 48 hours. We help you set the quantity and the day so your fridge is never full of juice past its best.",
          ],
        },
        {
          heading: "Staff wellness days",
          body: [
            "Many Lagos companies now run wellness weeks, health talks and hydration drives in the hot season. Fresh juice fits naturally into these, especially lower-sugar green and vegetable blends, as long as it is part of a bigger picture with water, rest and good food. We keep our own wellness messaging honest: juice is a pleasant, nourishing drink, not a cure for anything.",
            "A simple idea that works: a swap-your-soft-drink week, where staff trade one sugary drink a day for a fresh juice or water.",
          ],
        },
        {
          heading: "Flavours for the office",
          body: [
            <>
              A good office mix has familiar fruit bottles like orange and pineapple, a lighter
              option for people who prefer less sweetness, and a green juice for the
              health-conscious. Smaller 330ml bottles usually work best for a staff fridge, because
              one bottle is one serving. Browse{" "}
              <Link to="/juices" className={linkCls}>
                our juices
              </Link>{" "}
              to pick your favourites.
            </>,
          ],
        },
        {
          heading: "Pricing and invoicing",
          body: [
            "We quote per office, because the price depends on how many bottles you need, how often, and where you are. Per-bottle pricing gets better as quantity goes up, and business orders come with an invoice. Ask us for a quote and we will come back with one.",
          ],
        },
        {
          heading: "Delivery across Lagos",
          body: [
            <>
              Your juice is pressed in the morning and delivered cold to offices across Lagos. See{" "}
              <Link to="/juice-delivery-lagos" className={linkCls}>
                fresh juice delivery in Lagos
              </Link>{" "}
              for the areas we cover. Hosting an end-of-year party or launch? Our{" "}
              <Link to="/events-juice-lagos" className={linkCls}>
                event juice service
              </Link>{" "}
              covers that too.
            </>,
          ],
        },
      ]}
      checklistHeading="What to tell us"
      checklist={[
        "Your office address and the best delivery time",
        "Roughly how many people you want to cater for",
        "Weekly drops, monthly drops, a one-off meeting or gifting",
        "Favourite flavours, or any you would rather avoid",
        "Who should receive the invoice",
      ]}
      checklistNote="Prefer to see us first? Visit our kitchen at 30 Asa Afariogun Street, Ajao Estate, Ikeja, Monday to Saturday 8am–8pm and Sunday 10am–8pm."
      enquiry={{
        type: "corporate",
        cta: "Set up office juice",
        heading: "Get an office quote",
        template: "Hi Mrs. Samuel — I'd like to set up juice supply for our office.",
        leadSource: "corporate",
      }}
      faqs={FAQS}
      related={[
        { to: "/events-juice-lagos", label: "Juice for events" },
        { to: "/gifts", label: "Juice gifts and hampers" },
        { to: "/bulk-orders", label: "Bulk orders" },
      ]}
    />
  );
}
