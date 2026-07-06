import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage, type PolicySection } from "@/components/PolicyPage";
import clusterTropical from "@/assets/decor/cluster-tropical.png";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/delivery")({
  head: () =>
    seo({
      title: "Delivery Information — Mrs. Samuel Fruit Juice",
      description:
        "How Mrs. Samuel delivers cold-pressed juice across Lagos — delivery areas, timing, fees, preorder lead times, and how we keep your juice cold on the way to you.",
      path: "/delivery",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Delivery Information", path: "/delivery" }])],
    }),
  component: Page,
});

const sections: PolicySection[] = [
  {
    heading: "Where we deliver",
    body: [
      "We currently deliver across Lagos. If you're not sure whether we reach your area, message us on WhatsApp before ordering and we'll confirm.",
      "For locations outside our regular delivery zones, we can sometimes arrange delivery through a courier — reach out and we'll work it out with you.",
    ],
  },
  {
    heading: "When your order arrives",
    body: [
      "Everything is pressed fresh, so timing depends on whether your item is in stock or being made to order:",
    ],
    bullets: [
      "In stock: orders are delivered the same morning or the next morning, depending on the time you order.",
      "Preorder / made to order: delivered on the delivery date you choose or that we confirm at checkout.",
      "We deliver in the morning where possible, so your juice reaches you cold and fresh for the day.",
    ],
  },
  {
    heading: "Choosing your delivery date",
    body: [
      "At checkout you can choose to receive your order as soon as possible, or schedule it for a specific date that suits you. For preorder-only items, you'll pick from the available delivery dates.",
      "If you need a particular delivery window or have special instructions (gate code, landmark, best time to call), add them at checkout or send them to us on WhatsApp.",
    ],
  },
  {
    heading: "Delivery fees",
    body: [
      "Where a delivery fee applies, it is calculated from your address and shown clearly at checkout before you pay — no surprise charges.",
      "From time to time we run free-delivery offers or reduced fees for larger orders. Any such offer will be shown at checkout.",
    ],
  },
  {
    heading: "Keeping it cold",
    body: [
      "Our juice has no preservatives, so we handle it with care right up to your door. Please refrigerate it as soon as it arrives and drink it within the shelf life on the bottle.",
      "If you won't be home, let us know a safe way to deliver — we'd rather plan ahead than leave fresh juice sitting in the Lagos sun.",
    ],
  },
  {
    heading: "Tracking your order",
    body: [
      "After you order, you can follow its progress on your order page, and we'll keep you updated. If a rider is on the way, you'll be able to see that too.",
    ],
  },
  {
    heading: "Missed or failed delivery",
    body: [
      "If we can't reach you or nobody is available to receive a delivery, we'll contact you to rearrange. Because the product is perishable, repeated missed deliveries may mean we can't guarantee the same freshness — so please make sure someone can receive your order.",
    ],
  },
  {
    heading: "Need help?",
    body: [
      "For anything about a delivery — timing, address changes, or a problem on the day — message us on WhatsApp at 0901 951 2246 or email info@mrssamuel.com and we'll sort it out.",
    ],
  },
];

function Page() {
  return (
    <PolicyPage
      eyebrow="Getting It To You"
      title={
        <>
          Delivery <span className="text-[color:var(--brand-orange)]">Information</span>
        </>
      }
      subtitle="How, when, and where we bring fresh cold-pressed juice to your door across Lagos."
      decor={clusterTropical}
      accent="#ff9f43"
      lastUpdated="6 July 2026"
      sections={sections}
    />
  );
}
