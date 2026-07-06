import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage, type PolicySection } from "@/components/PolicyPage";
import clusterBerry from "@/assets/decor/cluster-berry.png";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/returns")({
  head: () =>
    seo({
      title: "Returns & Refunds — Mrs. Samuel Fruit Juice",
      description:
        "Mrs. Samuel's returns and refunds policy for fresh cold-pressed juice — what to do if your order arrives damaged, spoiled, or wrong, and how refunds are handled.",
      path: "/returns",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Returns & Refunds", path: "/returns" }])],
    }),
  component: Page,
});

const sections: PolicySection[] = [
  {
    heading: "Our promise",
    body: [
      "We want every bottle to reach you fresh and perfect. If it doesn't, we'll make it right — that's the short version of this whole page.",
      "Because our juice is a fresh, perishable food with no preservatives, we can't accept ordinary \"change of mind\" returns the way a shop selling non-perishable goods would. But if there's a genuine problem with your order, you're covered.",
    ],
  },
  {
    heading: "When we'll replace or refund",
    body: [
      "Please contact us as soon as possible if your order:",
    ],
    bullets: [
      "arrived damaged or leaking,",
      "arrived spoiled or not fresh,",
      "was the wrong item, flavour, or size, or",
      "was incomplete — something you paid for is missing.",
    ],
  },
  {
    heading: "How to report a problem",
    body: [
      "Message us on WhatsApp at 0901 951 2246 or email info@mrssamuel.com within 24 hours of receiving your order. A photo of the problem (and the bottle) really helps us understand what happened and sort it out fast.",
      "Please don't throw away the affected bottle until we've spoken — a quick photo lets us resolve most issues immediately.",
    ],
  },
  {
    heading: "How refunds work",
    body: [
      "Once we've confirmed the problem, we'll offer you a replacement on the next delivery run or a refund — your choice.",
      "Refunds are made to your original payment method. Depending on your bank, it can take a few working days for the money to appear after we process it.",
    ],
  },
  {
    heading: "Cancelling an order",
    body: [
      "If you need to cancel, contact us as quickly as possible. If we haven't started preparing your order yet, we can usually cancel and refund it in full.",
      "Once fresh juice has been pressed and prepared specifically for your order, we may not be able to offer a full refund — but talk to us; we're reasonable people.",
    ],
  },
  {
    heading: "What we can't refund",
    body: [
      "We're not able to refund juice that was delivered fresh and correct but wasn't kept refrigerated, or that was consumed after its shelf life. Keeping it cold once it reaches you is important for both taste and safety.",
    ],
  },
  {
    heading: "Your rights",
    body: [
      "This policy sits alongside — and does not take away — any rights you have under Nigerian consumer law. If in doubt, just reach out and we'll always try to do the fair thing.",
    ],
  },
];

function Page() {
  return (
    <PolicyPage
      eyebrow="If Something's Wrong"
      title={
        <>
          Returns &amp; <span className="text-[color:var(--brand-orange)]">Refunds</span>
        </>
      }
      subtitle="Fresh juice is perishable, so our policy is a little different — but if there's a genuine problem with your order, we'll always make it right."
      decor={clusterBerry}
      accent="#e85d8a"
      lastUpdated="6 July 2026"
      sections={sections}
    />
  );
}
