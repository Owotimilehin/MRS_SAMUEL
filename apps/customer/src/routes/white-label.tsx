import { createFileRoute, Link } from "@tanstack/react-router";
import { Beaker, Palette, Package, Truck } from "lucide-react";
import { ServiceLanding, type ServiceFaq } from "@/components/ServiceLanding";
import { seo, breadcrumbLd, faqPageLd, serviceLd } from "@/lib/seo";
import clusterGreen from "@/assets/decor/cluster-green.png";

const PATH = "/white-label";
const DESCRIPTION =
  "Cold-pressed Nigerian fruit juice bottled under your own brand. Your recipe or ours, your label, your sizes. For cafés, hotels, gyms and shops in Lagos.";

// TODO(owner): confirm minimum order quantity per white label run, the bottle
// sizes/types on offer, typical lead time from sample to first delivery, and
// production capacity before any of them are published.
// TODO(owner): confirm NAFDAC status (ours, and whether we support clients'
// own product registration) before it is mentioned on this page.
// TODO(owner): share 1–2 white label case studies (named only with the
// client's permission) to add as a "Brands we press for" section.
const FAQS: ServiceFaq[] = [
  {
    q: "What is white label juice?",
    a: "White label juice is juice we press and bottle that is sold under your brand name. You choose or create the blend, put your label on the bottle, and we handle the pressing and bottling in our Lagos kitchen.",
  },
  {
    q: "Can I use my own recipe?",
    a: "Yes. Start from one of our recipes or bring your own, and we press samples until it tastes right. We work with whole fruit and vegetables, so the final juice has no added sugar and no preservatives.",
  },
  {
    q: "What is the minimum order for white label juice?",
    a: "Minimum order quantities depend on the blend, the bottle size and how often you want deliveries, so we quote per project. Tell us what you have in mind and we will tell you what works.",
  },
  {
    q: "How much does white label juice cost?",
    a: "Pricing depends on the recipe, the bottle size, the label and the volume. We quote per project rather than off a price list. Use the form on this page or WhatsApp us on 0901 951 2246 to start.",
  },
  {
    q: "How long does white label juice last?",
    a: "Our juice is cold-pressed and unpasteurised with no preservatives, so it keeps for about 48 hours from pressing in the fridge at 2–6°C. That suits venues that sell it fresh, such as cafés, gyms and hotels, and it is why we deliver on a regular schedule.",
  },
  {
    q: "Do you handle the labels?",
    a: "Yes. You bring the brand and we handle the print run for your labels, with your story on the back. If you plan to sell in shops, talk to us early about registration and labelling requirements, because they affect your label design and timeline.",
  },
  {
    q: "Do you deliver outside Lagos?",
    a: "We deliver on a schedule across Lagos, or you can collect from us. Deliveries elsewhere in Nigeria are arranged on request.",
  },
];

export const Route = createFileRoute("/white-label")({
  head: () =>
    seo({
      title: "White Label Juice Production in Lagos | Mrs. Samuel",
      description: DESCRIPTION,
      path: PATH,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "White Label", path: PATH },
        ]),
        serviceLd({
          name: "White label cold-pressed juice production",
          serviceType: "Private label juice manufacturing",
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
      eyebrow="White Label"
      title={
        <>
          Your brand.
          <br />
          <span className="text-[color:var(--brand-orange)]">Our press.</span>
        </>
      }
      subtitle="Real cold-pressed fruit juice, bottled under your own label. No added sugar, no preservatives — the same juice we put our own name on."
      decor={clusterGreen}
      accent="#a8d27a"
      intro={[
        "A house juice is one of the easiest ways for a café, hotel, gym or wellness brand to stand out in Lagos. Customers remember a drink with your name on it. But setting up your own pressing kitchen, sourcing fruit every morning and keeping quality steady is a big job. White label juice production lets you skip all of that.",
        "We press real Nigerian fruit and vegetables in our kitchen in Ajao Estate, Ikeja, and bottle it under your brand. It is the same cold-pressed juice we sell as Mrs. Samuel: 100% fruit, no added sugar, no water and no preservatives. Over 40,000 bottles shared under our own name so far.",
      ]}
      cardsHeading="How it works"
      cards={[
        {
          Icon: Beaker,
          title: "Agree the blend",
          desc: "Start from one of our recipes or bring your own. We press samples until it tastes right.",
        },
        {
          Icon: Palette,
          title: "Put your brand on it",
          desc: "Your label, your bottle size, your story on the back. We handle the print run.",
        },
        {
          Icon: Package,
          title: "We press and bottle",
          desc: "Made fresh to your order in our Lagos kitchen, to the same standard as our own juice.",
        },
        {
          Icon: Truck,
          title: "Delivered to you",
          desc: "Scheduled drops across Lagos, or collection from us. Nationwide arranged on request.",
        },
      ]}
      sections={[
        {
          heading: "Your recipe or ours",
          body: [
            <>
              Some partners already know exactly what they want: a signature green juice, a
              zobo-based blend, a breakfast juice for the hotel buffet. Others want help. You can
              start from any juice in{" "}
              <Link to="/juices" className={linkCls}>
                our range
              </Link>{" "}
              and adjust it, or bring your own idea and we will develop it with you.
            </>,
            "We press samples, you taste them, and we adjust until the blend is right. Every recipe follows the same rule as our own juice: whole fruit and vegetables, cold-pressed, with nothing added.",
          ],
        },
        {
          heading: "Labels, bottles and branding",
          body: [
            "Your label, your bottle size and your story on the back. You bring the brand and we handle the print run, so the finished bottle looks like it came from your own kitchen. Tell us early if you plan to sell in shops or supermarkets, because registration and labelling requirements affect your label design and timeline.",
          ],
        },
        {
          heading: "Fresh by design",
          body: [
            "Cold-pressed juice without preservatives keeps for about 48 hours in the fridge at 2–6°C. That is a strength for venues that sell it fresh: your customers get juice pressed days, not months, before they drink it. It also shapes how white label works. We press to your order and deliver on a regular schedule, rather than filling a warehouse.",
          ],
          bullets: [
            "Cafés and restaurants wanting a house juice",
            "Hotels and short-lets stocking in-room drinks or breakfast juice",
            "Gyms, studios and wellness brands",
            "Retailers building a private label",
            "Event planners and corporate gifting",
          ],
        },
        {
          heading: "Minimums and pricing",
          body: [
            "Minimum order quantities and pricing depend on the blend, the bottle size and how often you want deliveries, so we quote per project rather than off a price list. Share what you have in mind, even roughly, and we will come back with what works for your volume.",
          ],
        },
        {
          heading: "Delivery and collection",
          body: [
            <>
              We deliver white label orders on a schedule across Lagos, or you can collect from our
              kitchen at 30 Asa Afariogun Street, Ajao Estate, Ikeja. See{" "}
              <Link to="/juice-delivery-lagos" className={linkCls}>
                fresh juice delivery in Lagos
              </Link>{" "}
              for the areas we cover. Deliveries elsewhere in Nigeria are arranged on request.
            </>,
            <>
              Only need a large one-off order under our own label for an event or office? See{" "}
              <Link to="/bulk-orders" className={linkCls}>
                bulk orders
              </Link>{" "}
              instead.
            </>,
          ],
        },
      ]}
      checklistHeading="What to tell us"
      checklist={[
        "Your business and where you will sell the juice",
        "Our recipe, your recipe, or an idea to develop",
        "The bottle size you have in mind",
        "Roughly how many bottles, and how often",
        "Whether you already have a label design",
      ]}
      checklistNote="Minimum order quantities and pricing depend on the blend, bottle size and how often you want deliveries — so we quote per project rather than off a price list."
      enquiry={{
        type: "white_label",
        cta: "Discuss white labelling",
        template: "Hi Mrs. Samuel — I'm interested in white label juice production.",
        leadSource: "white_label",
      }}
      faqs={FAQS}
      related={[
        { to: "/bulk-orders", label: "Bulk orders" },
        { to: "/corporate", label: "Office juice supply" },
      ]}
    />
  );
}
