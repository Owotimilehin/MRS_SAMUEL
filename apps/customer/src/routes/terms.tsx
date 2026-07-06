import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage, type PolicySection } from "@/components/PolicyPage";
import clusterGreen from "@/assets/decor/cluster-green.png";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/terms")({
  head: () =>
    seo({
      title: "Terms & Conditions — Mrs. Samuel Fruit Juice",
      description:
        "The terms for ordering cold-pressed juice from Mrs. Samuel Fruit Juice — pricing, payment, delivery, freshness, and your rights as a customer in Lagos, Nigeria.",
      path: "/terms",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Terms & Conditions", path: "/terms" }])],
    }),
  component: Page,
});

const sections: PolicySection[] = [
  {
    heading: "Who we are",
    body: [
      "Mrs. Samuel Fruit Juice (\"Mrs. Samuel\", \"we\", \"us\") is a cold-pressed fruit juice business based in Lagos, Nigeria. We press fresh juice and sell it directly to customers through this website, WhatsApp, and our shop.",
      "By placing an order with us — online, over WhatsApp, or in person — you agree to these terms. Please read them; they're written in plain language on purpose.",
    ],
  },
  {
    heading: "Our products",
    body: [
      "Our juice is cold-pressed from real fruit and contains no added sugar, water, or preservatives. Because it is fresh and unpasteurised, natural separation and small variations in colour and taste are normal — that is what real juice does.",
    ],
    bullets: [
      "Bottle sizes and prices are shown on each product page and may change over time.",
      "Some flavours and sizes are made to order or available by preorder only. Where that is the case, it is stated at checkout.",
      "Availability depends on the fruit we can source fresh that day, so a flavour may sell out or pause without notice.",
    ],
  },
  {
    heading: "Prices & payment",
    body: [
      "All prices are shown in Nigerian Naira (₦) and include any applicable charges shown at checkout. Delivery fees, where they apply, are added and shown before you pay.",
      "Online payments are handled by our payment provider on a secure page. We never see or store your full card details. Your order is confirmed once payment is successfully received.",
    ],
    bullets: [
      "If a payment is taken but your order does not confirm, it is automatically reconciled and either completed or refunded — contact us if anything looks wrong.",
      "We may cancel and refund an order if an item is mispriced due to an obvious error, or if we cannot fulfil it.",
    ],
  },
  {
    heading: "Orders & delivery",
    body: [
      "Once your order is confirmed we prepare it fresh. Delivery timing depends on your location and whether the item is in stock or being made to order.",
      "Full details are on our Delivery Information page. In short: we deliver within Lagos, in-stock orders go out the same or next morning, and preorders are delivered on the scheduled date.",
    ],
  },
  {
    heading: "Freshness & storage",
    body: [
      "Because our juice has no preservatives, it must be kept refrigerated and consumed within the shelf life shown on the bottle. Keeping it cold is important for both taste and safety.",
      "Once a delivery has been handed over, keeping the juice refrigerated is the customer's responsibility. We can't be responsible for juice left unrefrigerated after it reaches you.",
    ],
  },
  {
    heading: "Cancellations, returns & refunds",
    body: [
      "Because our products are fresh and perishable, our returns and refunds work a little differently from ordinary goods. If something is wrong with your order — it arrived damaged, spoiled, or incorrect — we will make it right.",
      "Please see our Returns & Refunds page for exactly how this works and the time window to contact us.",
    ],
  },
  {
    heading: "Glass bottles",
    body: [
      "We bottle in glass because it's better for the juice and the planet. Where a bottle-return arrangement applies, we'll explain it at the point of sale. Bottles remain reusable and we encourage returning them.",
    ],
  },
  {
    heading: "Liability",
    body: [
      "We take real care with hygiene and freshness. If you have a food allergy or a medical condition, please check the ingredients and consult your doctor before drinking — our juice is a natural food product, not a medicine, and we make no medical or health-cure claims.",
      "Nothing in these terms removes any rights you have under Nigerian consumer law.",
    ],
  },
  {
    heading: "Changes to these terms",
    body: [
      "We may update these terms from time to time. The version on this page, with the date shown above, is the current one. Continuing to order from us means you accept the latest version.",
    ],
  },
  {
    heading: "Contact us",
    body: [
      "Questions about these terms? Reach us on WhatsApp at 0901 951 2246, by email at info@mrssamuel.com, or visit us at 30 Asa-Afariogun Street, opposite Access Bank, Ajao Estate, Lagos.",
    ],
  },
];

function Page() {
  return (
    <PolicyPage
      eyebrow="The Fine Print"
      title={
        <>
          Terms &amp; <span className="text-[color:var(--brand-orange)]">Conditions</span>
        </>
      }
      subtitle="The simple, honest terms for ordering fresh juice from Mrs. Samuel. No legal traps — just how we work together."
      decor={clusterGreen}
      accent="#2f9e5f"
      lastUpdated="6 July 2026"
      sections={sections}
    />
  );
}
