import { createFileRoute, notFound, Link } from "@tanstack/react-router";
import { fetchProducts } from "@/lib/api/server-fns";
import { sortByStock650 } from "@/lib/stock-summary";
import { LocalLanding, type LocalFaq } from "@/components/LocalLanding";
import { SiteShell } from "@/components/SiteShell";
import { findArea, type DeliveryArea } from "@/lib/areas";
import { seo, breadcrumbLd, faqPageLd } from "@/lib/seo";
import clusterCitrus from "@/assets/decor/cluster-citrus.png";

function areaFaqs(a: DeliveryArea): LocalFaq[] {
  return [
    {
      q: `Do you deliver fresh juice to ${a.name}?`,
      a: `Yes. We deliver to ${a.neighbourhoods.join(", ")}. Add your address at checkout and the delivery fee is shown before you pay.`,
    },
    {
      q: `How soon will my juice arrive in ${a.name}?`,
      a: "In-stock orders are delivered the same morning or the next morning, depending on what time you order. Bottles travel cold.",
    },
    {
      q: "Is there added sugar?",
      a: "Never. Every bottle is 100% fruit and vegetables, cold-pressed, with no added sugar, water or preservatives.",
    },
  ];
}

export const Route = createFileRoute("/juice-delivery-lagos/$area")({
  loader: async ({ params }) => {
    const area = findArea(params.area);
    if (!area) throw notFound();
    const products = await fetchProducts();
    return { area, products: sortByStock650(products).slice(0, 8) };
  },
  head: ({ loaderData }) => {
    const a = loaderData?.area;
    if (!a) return seo({ title: "Area not found | Mrs. Samuel", path: "/juice-delivery-lagos", noIndex: true });
    const path = `/juice-delivery-lagos/${a.slug}`;
    return seo({
      title: `Fresh Juice Delivery in ${a.name}, Lagos | Mrs. Samuel`,
      description: `Fresh, cold-pressed fruit juice delivered in ${a.name}, Lagos. 100% fruit, no added sugar. Zobo, pineapple, orange, green juice and more, delivered cold.`,
      path,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Fresh Juice Delivery in Lagos", path: "/juice-delivery-lagos" },
          { name: a.name, path },
        ]),
        faqPageLd(areaFaqs(a)),
      ],
    });
  },
  component: Page,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <SiteShell>
      <div className="px-5 max-w-3xl mx-auto py-40 text-center">
        <h1 className="font-display text-5xl text-[color:var(--brand)]">Area not listed yet</h1>
        <p className="mt-3 text-[color:var(--brand)]/70">We may still deliver to you. Check our Lagos delivery page or ask on WhatsApp.</p>
        <Link to="/juice-delivery-lagos" className="mt-6 inline-flex rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold">Lagos delivery</Link>
      </div>
    </SiteShell>
  );
}

function Page() {
  const { area: a, products } = Route.useLoaderData();
  return (
    <LocalLanding
      eyebrow={`Juice Delivery · ${a.name}`}
      title={<>Fresh juice in <span className="text-[color:var(--brand-orange)]">{a.name}</span></>}
      subtitle={`Cold-pressed fruit juice, delivered cold across ${a.neighbourhoods.join(", ")}.`}
      decor={clusterCitrus}
      intro={[a.intro]}
      notes={a.localNotes}
      products={products}
      faqs={areaFaqs(a)}
      whatsappMessage={`Hi Mrs. Samuel, I'd like fresh juice delivered in ${a.name}.`}
    />
  );
}
