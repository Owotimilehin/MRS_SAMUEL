import { createFileRoute, Link } from "@tanstack/react-router";
import { MapPin, ExternalLink, Store } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { EnquiryForm } from "@/components/EnquiryForm";
import { seo, breadcrumbLd } from "@/lib/seo";
import { STOCKISTS, STOCKISTS_PATH, STOCKIST_LABEL, stockistsLd } from "@/lib/stockists";
import clusterCitrus from "@/assets/decor/cluster-citrus.webp";

// TODO(owner): add the gyms, salons, offices and hotels that stock us to
// src/lib/stockists.json (instructions are inside the file). The page joins
// the sitemap and becomes indexable once the list has one entry.

export const Route = createFileRoute("/stockists")({
  head: () =>
    seo({
      title: "Stockists: Where to Buy Our Juice in Lagos | Mrs. Samuel",
      description:
        "Find Mrs. Samuel cold-pressed juice at gyms, salons, offices and hotels across Lagos, or visit our kitchen in Ajao Estate, Ikeja. Want to stock us? Ask.",
      path: STOCKISTS_PATH,
      // An empty list is a thin page: keep it out of Google until it has entries.
      noIndex: STOCKISTS.length === 0,
      jsonLd: [
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Stockists", path: STOCKISTS_PATH },
        ]),
        ...(STOCKISTS.length > 0 ? [stockistsLd()] : []),
      ],
    }),
  component: Page,
});

const linkCls = "font-semibold underline underline-offset-2 hover:text-[color:var(--brand-orange)]";
const h2 = "font-display text-3xl font-semibold text-[color:var(--brand)]";

function Page() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Stockists"
        title={
          <>
            Where to buy{" "}
            <span className="text-[color:var(--brand-orange)]">Mrs. Samuel juice.</span>
          </>
        }
        subtitle="Gyms, salons, offices and hotels across Lagos that keep our cold-pressed juice in the fridge."
        decor={clusterCitrus}
        accent="#fdc651"
      />

      <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-12">
        {STOCKISTS.length > 0 ? (
          <>
            <h2 className={h2}>Our stockists</h2>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {STOCKISTS.map((s) => (
                <li
                  key={`${s.name}|${s.address}`}
                  className="rounded-2xl bg-white p-5 ring-1 ring-black/5"
                >
                  <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/60">
                    {STOCKIST_LABEL[s.type]} · {s.area}
                  </div>
                  <h3 className="mt-1 text-lg font-semibold text-[color:var(--brand)]">{s.name}</h3>
                  <p className="mt-2 flex gap-2 text-sm text-[color:var(--brand)]/75">
                    <MapPin className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
                    {s.address}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-4 text-sm">
                    {s.url && (
                      <a href={s.url} target="_blank" rel="noreferrer" className={linkCls}>
                        Visit {s.name} <ExternalLink className="inline h-3.5 w-3.5" aria-hidden />
                      </a>
                    )}
                    {s.mapsUrl && (
                      <a href={s.mapsUrl} target="_blank" rel="noreferrer" className={linkCls}>
                        Directions
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="rounded-2xl bg-white p-6 sm:p-8 ring-1 ring-black/5">
            <Store className="h-8 w-8 text-[color:var(--brand-orange)]" aria-hidden />
            <h2 className={`mt-3 ${h2}`}>Our stockist list is coming soon</h2>
            <p className="mt-3 text-[16px] leading-relaxed text-[color:var(--brand)]/80">
              We are putting together the list of places around Lagos where you can pick up a
              bottle. Until then, the freshest way to get our juice is straight from us: order{" "}
              <Link to="/juices" className={linkCls}>
                any of our juices
              </Link>{" "}
              online for{" "}
              <Link to="/juice-delivery-lagos" className={linkCls}>
                cold delivery across Lagos
              </Link>
              , or walk in to our kitchen at 30 Asa Afariogun Street, Ajao Estate, Ikeja, Monday to
              Saturday 8am–8pm and Sunday 10am–8pm.
            </p>
          </div>
        )}
      </section>

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-12">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start">
          <div className="rounded-[1.5rem] bg-[color:var(--brand)] text-white p-8">
            <h2 className="font-display text-3xl">Want to stock Mrs. Samuel?</h2>
            <p className="mt-4 text-sm text-white/85 leading-relaxed">
              Gyms, salons, cafés, offices and hotels: give your customers real cold-pressed juice
              with no added sugar and no preservatives. We deliver chilled on a schedule that suits
              you, and you get a listing on this page with a link back to your business.
            </p>
            <p className="mt-4 text-sm text-white/70 leading-relaxed">
              Prefer your own label on the bottle? See{" "}
              <Link to="/white-label" className="underline underline-offset-2">
                white label juice
              </Link>
              .
            </p>
          </div>
          <EnquiryForm
            enquiryType="stockist"
            cta="Ask about stocking our juice"
            heading="Become a stockist"
            template="Hi Mrs. Samuel — I'd like to stock your juice at my business."
            leadSource="stockists"
          />
        </div>
      </section>
    </SiteShell>
  );
}
