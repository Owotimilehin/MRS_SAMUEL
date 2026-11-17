import { createFileRoute, Link } from "@tanstack/react-router";
import { fetchProducts } from "@/lib/api/server-fns";
import { sortByStock650 } from "@/lib/stock-summary";
import { LocalLanding, type LocalFaq } from "@/components/LocalLanding";
import { PUBLISHED_AREAS } from "@/lib/areas";
import { seo, breadcrumbLd, faqPageLd } from "@/lib/seo";
import clusterTropical from "@/assets/decor/cluster-tropical.png";

const PATH = "/juice-delivery-lagos";

const FAQS: LocalFaq[] = [
  {
    q: "Do you deliver fresh juice across Lagos?",
    a: "Yes, we deliver all round Lagos, from our kitchen in Ajao Estate, Ikeja, to the Island, Lekki, Ajah, and across the mainland.",
  },
  {
    q: "How fast is delivery?",
    a: "In-stock orders are delivered the same morning or the next morning, depending on what time you order.",
  },
  {
    q: "How much is delivery?",
    a: "The fee depends on your address and is shown at checkout before you pay. There are no surprise charges.",
  },
  {
    q: "Is the juice really fresh?",
    a: "Every bottle is cold-pressed from whole fruit and vegetables. There's no added sugar, water or preservatives. Keep it refrigerated and drink it fresh.",
  },
  {
    q: "Can I order juice in bulk for an office or event?",
    a: "Yes. We supply offices, parties, weddings and corporate events across Lagos. Request a quote on our bulk orders page.",
  },
];

export const Route = createFileRoute("/juice-delivery-lagos/")({
  loader: async () => {
    const products = await fetchProducts().catch(() => []); // page content is static; never 500 over the juice grid
    return { products: sortByStock650(products).slice(0, 8) };
  },
  head: () =>
    seo({
      title: "Fresh Juice Delivery in Lagos — Order Online | Mrs. Samuel",
      description:
        "Fresh fruit juice delivered cold across Lagos. Cold-pressed daily in Ikeja: zobo, pineapple, orange, green juice and more, with no added sugar. Order online or on WhatsApp.",
      path: PATH,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Fresh Juice Delivery in Lagos", path: PATH },
        ]),
        faqPageLd(FAQS),
      ],
    }),
  component: Page,
});

function Page() {
  const { products } = Route.useLoaderData();
  return (
    <LocalLanding
      eyebrow="Juice Delivery · Lagos"
      title={<>Fresh juice delivery <span className="text-[color:var(--brand-orange)]">in Lagos</span></>}
      subtitle="100% natural fruit juice, cold-pressed every morning in Ikeja and delivered cold to your door."
      decor={clusterTropical}
      intro={[
        "Mrs. Samuel makes fresh juice in Lagos the old-fashioned way. We use whole Nigerian fruit, press it cold and bottle it the same morning. There are no concentrates, no added sugar and no preservatives, which is why it has to be delivered cold and drunk fresh.",
        "Order online and we bring it from our kitchen in Ajao Estate, Ikeja, straight to your home or office. Choose a single bottle, a detox bundle, a gift box, or a few crates for a party.",
      ]}
      notes={[
        "The delivery fee is calculated from your address and shown at checkout before you pay.",
        "Not sure if we reach you? Send us a WhatsApp message with your area and we'll confirm before you order.",
        "Ordering for an office, wedding or event? Request a quote on our bulk orders page.",
      ]}
      products={products}
      faqs={FAQS}
      whatsappMessage="Hi Mrs. Samuel, do you deliver fresh juice to my area?"
    >
      {PUBLISHED_AREAS.length > 0 && (
        <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-12">
          <h2 className="font-display text-3xl font-semibold text-[color:var(--brand)]">Delivery areas</h2>
          <ul className="mt-4 flex flex-wrap gap-2.5 sm:gap-3">
            {PUBLISHED_AREAS.map((a) => (
              <li key={a.slug}>
                <Link
                  to="/juice-delivery-lagos/$area"
                  params={{ area: a.slug }}
                  className="inline-flex min-h-11 items-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-[color:var(--brand)] ring-1 ring-black/10 hover:bg-black/5"
                >
                  {/* Phone shows just the area so chips fit in rows; the full
                      phrase stays in the link text for screen readers and search. */}
                  <span className="sr-only sm:not-sr-only">Fresh juice in&nbsp;</span>
                  {a.name}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-[color:var(--brand)]/70">
            Don't see your area? <Link to="/delivery" className="underline">Read our delivery information</Link> or ask us on WhatsApp.
          </p>
        </section>
      )}
    </LocalLanding>
  );
}
