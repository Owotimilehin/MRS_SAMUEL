import { createFileRoute, notFound, Link } from "@tanstack/react-router";
import { fetchProducts } from "@/lib/api/server-fns";
import { sortByStock650 } from "@/lib/stock-summary";
import { LocalLanding } from "@/components/LocalLanding";
import { SiteShell } from "@/components/SiteShell";
import { findArea, type DeliveryArea } from "@/lib/areas";
import {
  areaFaqs,
  areaHeadings,
  areaPath,
  areaServiceLd,
  areaSubtitle,
  areaTitle,
  nearbyAreas,
} from "@/lib/area-page";
import { seo, breadcrumbLd, faqPageLd } from "@/lib/seo";
import clusterCitrus from "@/assets/decor/cluster-citrus.webp";

export const Route = createFileRoute("/juice-delivery-lagos/$area")({
  loader: async ({ params }) => {
    const area = findArea(params.area);
    if (!area) throw notFound();
    const products = await fetchProducts().catch(() => []); // page content is static; never 500 over the juice grid
    return { area, products: sortByStock650(products).slice(0, 8) };
  },
  head: ({ loaderData }) => {
    const a = loaderData?.area;
    if (!a)
      return seo({
        title: "Area not found | Mrs. Samuel",
        path: "/juice-delivery-lagos",
        noIndex: true,
      });
    const path = areaPath(a);
    return seo({
      title: areaTitle(a),
      description: a.description,
      path,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Fresh Juice Delivery in Lagos", path: "/juice-delivery-lagos" },
          { name: a.name, path },
        ]),
        areaServiceLd(a),
        // Same Q&As the page renders below — FAQPage only for visible answers.
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
        <p className="mt-3 text-[color:var(--brand)]/70">
          We may still deliver to you. Check our Lagos delivery page or ask on WhatsApp.
        </p>
        <Link
          to="/juice-delivery-lagos"
          className="mt-6 inline-flex rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold"
        >
          Lagos delivery
        </Link>
      </div>
    </SiteShell>
  );
}

const h2 = "mt-12 font-display text-3xl font-semibold text-[color:var(--brand)]";
const body = "text-[15px] leading-relaxed text-[color:var(--brand)]/80";

/** Area-specific sections: places, route, occasions. Text comes from lib/area-page. */
function AreaDetails({ area: a }: { area: DeliveryArea }) {
  const h = areaHeadings(a);
  return (
    <>
      <h2 className={h2}>{h.places}</h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {a.places.map((p) => (
          <li key={p.name} className="rounded-2xl bg-white p-4 ring-1 ring-black/5">
            <h3 className="font-semibold text-[color:var(--brand)]">{p.name}</h3>
            <p className={`mt-1 ${body}`}>{p.note}</p>
          </li>
        ))}
      </ul>

      <h2 className={h2}>{h.route}</h2>
      <div className={`mt-4 space-y-3 ${body}`}>
        {a.route.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      <h2 className={h2}>{h.occasions}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {a.occasions.map((o) => (
          <div key={o.title}>
            <h3 className="font-semibold text-[color:var(--brand)]">{o.title}</h3>
            <p className={`mt-1 ${body}`}>{o.text}</p>
          </div>
        ))}
      </div>
    </>
  );
}

function NearbyAreas({ area: a }: { area: DeliveryArea }) {
  const nearby = nearbyAreas(a);
  if (!nearby.length) return null;
  return (
    <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-12">
      <h2 className="font-display text-3xl font-semibold text-[color:var(--brand)]">
        {areaHeadings(a).nearby}
      </h2>
      <ul className="mt-4 flex flex-wrap gap-2.5 sm:gap-3">
        {nearby.map((n) => (
          <li key={n.slug}>
            <Link
              to="/juice-delivery-lagos/$area"
              params={{ area: n.slug }}
              className="inline-flex min-h-11 items-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-[color:var(--brand)] ring-1 ring-black/10 hover:bg-black/5"
            >
              Fresh juice in {n.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Page() {
  const { area: a, products } = Route.useLoaderData();
  return (
    <LocalLanding
      eyebrow={`Juice Delivery · ${a.name}`}
      title={
        <>
          Fresh juice in <span className="text-[color:var(--brand-orange)]">{a.name}</span>
        </>
      }
      subtitle={areaSubtitle(a)}
      decor={clusterCitrus}
      intro={[a.intro, ...a.about]}
      details={<AreaDetails area={a} />}
      notes={a.localNotes}
      products={products}
      faqs={areaFaqs(a)}
      whatsappMessage={`Hi Mrs. Samuel, I'd like fresh juice delivered in ${a.name}.`}
    >
      <NearbyAreas area={a} />
    </LocalLanding>
  );
}
