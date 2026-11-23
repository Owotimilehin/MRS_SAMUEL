import { createFileRoute, Link } from "@tanstack/react-router";
import { TreePine, HeartHandshake, Building2, Sparkles } from "lucide-react";
import { ServiceLanding, type ServiceFaq } from "@/components/ServiceLanding";
import { seo, breadcrumbLd, faqPageLd, serviceLd } from "@/lib/seo";
import clusterBerry from "@/assets/decor/cluster-berry.png";

const PATH = "/gifts";
const DESCRIPTION =
  "Fresh juice gift hampers in Lagos for Christmas, Valentine's Day, clients and staff. Cold-pressed, no added sugar, delivered chilled. Ask us for a quote.";

// TODO(owner): confirm hamper contents (bottles per box, extras), any set
// hamper prices, the Christmas and Valentine's order cut-off dates, and
// whether custom labels/messages are offered. Until then: "Ask us".
// TODO(owner): add hamper photos (WebP, with width/height) when available.
const FAQS: ServiceFaq[] = [
  {
    q: "Is there a minimum order for juice gifts?",
    a: "No. The minimum order is one bottle and there is no maximum, so you can send a single gift or a box for every client and staff member. For large orders, tell us your date early so we can plan the pressing.",
  },
  {
    q: "Do you make Christmas juice hampers?",
    a: "Yes. We put together fresh juice hampers and branded crates for Christmas and the end of the year, for families, clients and staff. Tell us how many you need and when, and we will send you a quote.",
  },
  {
    q: "Can I send juice as a Valentine's gift?",
    a: "Yes. A box of fresh, cold-pressed juice is a thoughtful Valentine's gift for someone who loves fruit or is cutting back on sugar. Message us with the delivery address and date in Lagos.",
  },
  {
    q: "How much does a juice hamper cost?",
    a: "Our prices stay the same affordable prices all year, Christmas included: a hamper costs the bottles that go in it, with no holiday mark-up. Tell us how many bottles, which sizes and flavours, and how many hampers, and we will send the total. You can see every bottle's price on the shop page.",
  },
  {
    q: "How long does the juice in a hamper last?",
    a: "About 48 hours from pressing, kept refrigerated at 2–6°C. Because it has no preservatives, gifts work best when they are delivered close to the day and opened soon after.",
  },
  {
    q: "Can you deliver hampers to several addresses?",
    a: "We deliver cold all round Lagos. For corporate gifting to several addresses, send us the list and dates and we will plan the deliveries with you.",
  },
  {
    q: "Can the hampers carry our company branding?",
    a: "We offer branded crates and hampers for corporate gifting. Share your logo and colours when you request a quote and we will tell you what is possible for your dates.",
  },
];

export const Route = createFileRoute("/gifts")({
  head: () =>
    seo({
      title: "Juice Gift Hampers in Lagos for Christmas | Mrs. Samuel",
      description: DESCRIPTION,
      path: PATH,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Juice Gifts & Hampers", path: PATH },
        ]),
        serviceLd({
          name: "Fresh juice gift hampers in Lagos",
          serviceType: "Gift hampers",
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
      eyebrow="Gifts · Lagos"
      title={
        <>
          Juice gifts and hampers{" "}
          <span className="text-[color:var(--brand-orange)]">they will actually enjoy.</span>
        </>
      }
      subtitle="Fresh, cold-pressed juice hampers for Christmas, Valentine's Day, clients and staff, delivered chilled across Lagos."
      decor={clusterBerry}
      accent="#f7a8b0"
      intro={[
        "Every December, offices and homes across Lagos fill up with the same hampers of biscuits, wine and tinned drinks. A box of fresh, cold-pressed juice stands out. It is colourful, it tastes like real fruit, and it suits everyone from the aunty watching her sugar to the colleague who does not drink.",
        "Every Mrs. Samuel bottle is 100% fruit and vegetables, pressed in our kitchen in Ajao Estate, Ikeja, with no added sugar and no preservatives. Over 40,000 bottles shared so far, and every one pressed fresh.",
      ]}
      cardsHeading="Gifts for every season"
      cards={[
        {
          Icon: TreePine,
          title: "Christmas hampers",
          desc: "Fresh juice hampers for family, friends and neighbours over the festive season.",
        },
        {
          Icon: HeartHandshake,
          title: "Valentine's gifts",
          desc: "A box of their favourite flavours, delivered chilled on the day.",
        },
        {
          Icon: Building2,
          title: "Client & staff gifts",
          desc: "Branded crates and hampers for clients, partners and teams at year end.",
        },
        {
          Icon: Sparkles,
          title: "Thank-yous & welcomes",
          desc: "New-starter welcome packs, speaker gifts and thank-you boxes all year round.",
        },
      ]}
      sections={[
        {
          heading: "Christmas and end-of-year hampers",
          body: [
            "December is the busiest gifting month in Lagos, and fresh juice needs planning on our side because every bottle is pressed to order. Get in touch as early as you can with the number of hampers, the dates and the delivery addresses, and we will plan the pressing so every hamper arrives cold and at its freshest.",
            "For companies, we offer branded crates and hampers for clients, partners and staff. It is an easy way to say thank you that people actually use, instead of another hamper that sits in a cupboard until March.",
          ],
        },
        {
          heading: "Valentine's Day juice gifts",
          body: [
            "Flowers fade and chocolate melts in the Lagos heat. A box of chilled juice in their favourite flavours is a thoughtful gift for a partner, friend or parent who loves fruit or is cutting back on sugar. Tell us the date and address and we will deliver it cold.",
          ],
        },
        {
          heading: "Choosing what goes inside",
          body: [
            <>
              We bottle in 330ml and 650ml, and the mix is up to you: familiar favourites like
              orange and pineapple, bright ginger blends, or green juices for the health-conscious.
              Browse{" "}
              <Link to="/juices" className={linkCls}>
                all our juices
              </Link>{" "}
              and tell us which ones you would like in your hampers.
            </>,
          ],
        },
        {
          heading: "Keeping gifts fresh",
          body: [
            <>
              Our juice has no preservatives, so it should be kept at 2–6°C and drunk within 48
              hours of pressing. That is why we deliver close to the day, and why we recommend
              recipients put their bottles straight in the fridge. Handing out gifts at a party or
              launch? See our{" "}
              <Link to="/events-juice-lagos" className={linkCls}>
                juice for events
              </Link>{" "}
              page for tips on keeping bottles cold.
            </>,
          ],
        },
        {
          heading: "Delivery across Lagos",
          body: [
            <>
              We deliver gifts cold all round Lagos from Ikeja to the Island, Lekki and Ajah. See{" "}
              <Link to="/juice-delivery-lagos" className={linkCls}>
                fresh juice delivery in Lagos
              </Link>{" "}
              for details. Sending a single gift today? You can also{" "}
              <Link to="/shop" className={linkCls}>
                order online
              </Link>{" "}
              and have it delivered.
            </>,
          ],
        },
      ]}
      checklistHeading="What to tell us"
      checklist={[
        "How many hampers or gift boxes you need",
        "Delivery date, or dates if you are sending to several people",
        "Delivery address or addresses in Lagos",
        "Flavours you would like, or a budget per gift",
        "Whether you want your company branding on it",
      ]}
      checklistNote="Hampers are pressed to order, so the earlier you get in touch before Christmas or Valentine's Day, the easier it is to fit your dates."
      enquiry={{
        type: "gifts",
        cta: "Ask about gift hampers",
        heading: "Plan your gifts",
        template: "Hi Mrs. Samuel — I'd like to order juice gift hampers.",
        leadSource: "gifts",
      }}
      faqs={FAQS}
      related={[
        { to: "/corporate", label: "Office juice supply" },
        { to: "/events-juice-lagos", label: "Juice for events" },
        { to: "/bulk-orders", label: "Bulk orders" },
      ]}
    />
  );
}
