import { createFileRoute, Link } from "@tanstack/react-router";
import { Heart, PartyPopper, Cake, Briefcase, Instagram } from "lucide-react";
import { ServiceLanding, type ServiceFaq } from "@/components/ServiceLanding";
import { seo, breadcrumbLd, faqPageLd, serviceLd } from "@/lib/seo";
import clusterWatermelon from "@/assets/decor/cluster-watermelon.png";

const PATH = "/events-juice-lagos";
const DESCRIPTION =
  "Cold-pressed juice for weddings, owambes, birthdays and corporate events in Lagos. Chilled crates, no added sugar. Tell us your date for a quote.";

// Owner confirmed (23 Nov 2026): minimum order is 1 bottle, no maximum.
// TODO(owner): confirm crate sizes and per-bottle event pricing tiers, if you
// want them published; until then the page only says "Ask us for a quote".
const FAQS: ServiceFaq[] = [
  {
    q: "How much juice do I need per guest?",
    a: "A good starting point is one bottle per guest for a short event of two or three hours, and one and a half to two bottles per guest for a long wedding reception or owambe, especially in the hot season. Remember the vendors, ushers, band and family helping out back. We will help you work out the numbers.",
  },
  {
    q: "Is there a minimum order for events?",
    a: "No. The minimum order is one bottle and there is no maximum, so a small birthday and a 1,000-guest wedding are both welcome. For large orders, tell us your date early so we can plan the pressing. Use the quote form on this page or WhatsApp us on 0901 951 2246.",
  },
  {
    q: "How much does juice for an event cost?",
    a: "We quote per event, because the price depends on how many bottles, which sizes and flavours, and where you are in Lagos. Per-bottle pricing gets better as the quantity goes up. Ask us for a quote and we will send one back.",
  },
  {
    q: "How far ahead should I book?",
    a: "As soon as your date and rough guest count are fixed, even if the numbers are not final. Every bottle is pressed fresh, so larger orders need notice for us to plan the pressing, and we deliver close to your event so guests drink it at its freshest.",
  },
  {
    q: "How do I keep the juice cold at the venue?",
    a: "Keep it refrigerated at 2–6°C, or in coolers packed with ice and out of direct sun, and serve it within 48 hours of pressing. Bring bottles out in batches instead of putting everything on the tables at once.",
  },
  {
    q: "Can the crates or bottles be branded for my event?",
    a: "We offer branded crates and hampers for events and gifting. Tell us your colours, names or logo when you request a quote and we will tell you what is possible for your date.",
  },
  {
    q: "Do you deliver to venues outside Lagos?",
    a: "We deliver cold all round Lagos, from the mainland to the Island, Lekki and Ajah. Other cities are by special arrangement: message us on WhatsApp on 0901 951 2246.",
  },
];

// Real photos from events you have supplied. Add WebP files to
// src/assets/events/ and list them here with their pixel size.
// TODO(owner): send 6–9 event photos (with the hosts' permission).
const EVENT_PHOTOS: { src: string; alt: string; width: number; height: number }[] = [];

export const Route = createFileRoute("/events-juice-lagos")({
  head: () =>
    seo({
      title: "Juice for Events in Lagos: Weddings & Parties | Mrs. Samuel",
      description: DESCRIPTION,
      path: PATH,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Juice for Events in Lagos", path: PATH },
        ]),
        serviceLd({
          name: "Fresh juice for weddings, parties and events in Lagos",
          serviceType: "Event drinks supply",
          description: DESCRIPTION,
          path: PATH,
        }),
        faqPageLd(FAQS),
      ],
    }),
  component: Page,
});

const linkCls = "font-semibold underline underline-offset-2 hover:text-[color:var(--brand-orange)]";

function Gallery() {
  return (
    <section className="px-5 sm:px-10 max-w-5xl mx-auto py-12">
      <h2 className="font-display text-3xl font-semibold text-[color:var(--brand)]">
        From recent events
      </h2>
      {EVENT_PHOTOS.length > 0 ? (
        <ul className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
          {EVENT_PHOTOS.map((p) => (
            <li key={p.src}>
              <img
                src={p.src}
                alt={p.alt}
                width={p.width}
                height={p.height}
                loading="lazy"
                className="h-full w-full rounded-2xl object-cover"
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-6 rounded-2xl bg-white p-6 ring-1 ring-black/5 text-[15px] leading-relaxed text-[color:var(--brand)]/80">
          <p>
            Our event photo gallery is on its way. In the meantime, see chilled crates at weddings,
            parties and office events on our Instagram.
          </p>
          <a
            href="https://instagram.com/Mrs_samuelfruitjuice"
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full bg-[color:var(--brand)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[color:var(--brand-orange)] transition"
          >
            <Instagram className="h-4 w-4" aria-hidden /> See events on Instagram
          </a>
        </div>
      )}
    </section>
  );
}

function Page() {
  return (
    <ServiceLanding
      eyebrow="Events · Lagos"
      title={
        <>
          Juice for weddings, owambes{" "}
          <span className="text-[color:var(--brand-orange)]">and every Lagos party.</span>
        </>
      }
      subtitle="Chilled crates of cold-pressed fruit juice for weddings, birthdays, naming ceremonies and corporate events, pressed fresh and delivered across Lagos."
      decor={clusterWatermelon}
      accent="#f7a8b0"
      intro={[
        "A Lagos party is judged on three things: the food, the music and whether the drinks were cold. We can't help with the DJ, but after sharing over 40,000 bottles we know a fair bit about keeping a crowd refreshed. Whether you are planning an owambe, a traditional and white wedding, a milestone birthday or a company end-of-year party, we press your juice fresh and bring it chilled to your venue.",
        "Every Mrs. Samuel bottle is 100% fruit and vegetables, cold-pressed in our kitchen in Ajao Estate, Ikeja, with no added sugar and no preservatives. It is a drink guests remember, and a thoughtful choice for the aunties watching their sugar, the children, expectant mothers and anyone skipping alcohol.",
      ]}
      cardsHeading="Event packages"
      cards={[
        {
          Icon: Heart,
          title: "Weddings",
          desc: "Traditional and white weddings, counted separately if the guest lists differ. High-table flavours set aside on request. Ask us for a quote.",
        },
        {
          Icon: PartyPopper,
          title: "Owambes & parties",
          desc: "Crates of crowd-pleasing flavours for long parties in the Lagos heat, delivered chilled close to the start. Ask us for a quote.",
        },
        {
          Icon: Cake,
          title: "Birthdays & naming ceremonies",
          desc: "Smaller 330ml bottles that guests can carry around, so fewer half-finished drinks are left on tables. Ask us for a quote.",
        },
        {
          Icon: Briefcase,
          title: "Corporate events",
          desc: "Launches, conferences, end-of-year parties and town halls, with an invoice for your finance team. Ask us for a quote.",
        },
      ]}
      sections={[
        {
          heading: "How event orders work",
          body: [
            "Planning drinks for a few hundred guests should not be stressful. Our process is simple, and we talk it through with you on WhatsApp so nothing gets lost.",
          ],
          bullets: [
            "Tell us your date, venue, delivery time and rough guest count using the form on this page.",
            "We suggest quantities, bottle sizes and a flavour mix for your crowd.",
            "We send you a quote. Once you confirm, we plan the pressing around your date.",
            "Your juice is pressed fresh and delivered chilled to the venue, to the person you name.",
          ],
        },
        {
          heading: "Choosing sizes and flavours",
          body: [
            "We bottle in 330ml and 650ml. Smaller bottles suit parties where guests walk around; larger ones work for high tables, family tables and anywhere drinks are poured into glasses. Availability of each size depends on the flavour, so ask us what is possible for your date.",
            <>
              Most crowds love a few familiar favourites such as orange, pineapple and guava, with
              one or two adventurous bottles for guests who like something new. Have a look at{" "}
              <Link to="/juices" className={linkCls}>
                our full range of juices
              </Link>{" "}
              and tell us which ones you would like.
            </>,
          ],
        },
        {
          heading: "Minimum order and pricing",
          body: [
            "Every event is different, so we quote per order instead of publishing a fixed price list. The quote depends on the number of bottles, the sizes and flavours you choose, and where your venue is in Lagos. Per-bottle pricing gets better as the order grows.",
            "There is no event too small or too big: the minimum order is one bottle and there is no maximum. Share your guest count and date and we will suggest what makes sense.",
          ],
        },
        {
          heading: "Keeping juice cold on the day",
          body: [
            "Cold-pressed juice has no preservatives, so temperature matters. Keep it at 2–6°C and serve it within 48 hours of pressing. A little planning makes the difference between a warm bottle and a happy guest.",
          ],
          bullets: [
            "Arrange fridges, chest freezers set to chill, or large coolers before delivery day.",
            "Pack coolers with ice and top up through the event.",
            "Keep coolers out of the afternoon sun and away from generators.",
            "Bring bottles out in batches so every one reaches a guest cold.",
            "Name one person to receive the crates, check the count and get them into cold storage.",
          ],
        },
        {
          heading: "Delivery to your venue",
          body: [
            <>
              We deliver cold all round Lagos from our kitchen at 30 Asa Afariogun Street, Ajao
              Estate, Ikeja. See{" "}
              <Link to="/juice-delivery-lagos" className={linkCls}>
                fresh juice delivery in Lagos
              </Link>{" "}
              for the areas we cover. For events, we agree a delivery time with you so the juice
              arrives close to the start and goes straight into cold storage.
            </>,
          ],
        },
      ]}
      checklistHeading="What to send us"
      checklist={[
        "Your event date and the time you want delivery",
        "The venue address in Lagos",
        "Your estimated guest count",
        "Flavours you love or want to avoid",
        "Whether you want branded crates or gift bottles",
      ]}
      checklistNote="Every bottle is pressed fresh for your event, so the earlier you reach out, the easier it is to plan. We are open Monday to Saturday 8am–8pm and Sunday 10am–8pm."
      enquiry={{
        type: "events",
        cta: "Request an event quote",
        heading: "Get an event quote",
        template: "Hi Mrs. Samuel — I'd like a quote for juice for an event.",
        leadSource: "events",
      }}
      faqs={FAQS}
      related={[
        { to: "/corporate", label: "Office juice supply" },
        { to: "/gifts", label: "Juice gifts and hampers" },
        { to: "/bulk-orders", label: "Bulk orders" },
      ]}
    >
      <Gallery />
    </ServiceLanding>
  );
}
