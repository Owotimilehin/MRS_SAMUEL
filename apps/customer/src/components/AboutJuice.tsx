import { Link } from "@tanstack/react-router";
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";
import { formatNaira } from "@/lib/cart";
import { productCopy } from "@/lib/product-copy";
import { renderMarkdown } from "@/lib/markdown";

const LINK = "font-semibold text-[color:var(--brand-orange)] underline underline-offset-2";
const H3 = "pt-4 font-display text-2xl text-[color:var(--brand)]";

/**
 * Long-form copy on /juices/<slug> (SEO roadmap Q3), from lib/product-copy.ts.
 * Prices and sizes come from live data. A juice without an entry gets a short
 * generic paragraph instead, so a new product never renders an empty section.
 */
export function AboutJuice({ p, sizes }: { p: Product; sizes: Size[] }) {
  const copy = productCopy(p.id);
  const priceLine = sizes.map((s) => `${s} ${formatNaira(p.prices[s])}`).join(" · ");
  return (
    <section className="px-5 sm:px-10 pb-20" aria-labelledby="about-juice">
      <div className="mx-auto max-w-3xl">
        <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
          Taste, storage and delivery
        </div>
        <h2
          id="about-juice"
          className="mt-3 font-display text-4xl font-semibold text-[color:var(--brand)]"
        >
          About {p.name}
        </h2>
        <div className="mt-6 space-y-5 text-[17px] leading-[1.75] text-[color:var(--brand)]/85">
          {copy ? (
            <>
              <p>{copy.intro}</p>
              {copy.sections.map((s) => (
                <div key={s.heading} className="space-y-4">
                  <h3 className={H3}>{s.heading}</h3>
                  {renderMarkdown(s.body)}
                </div>
              ))}
            </>
          ) : (
            <p>
              {p.name} is cold-pressed in Lagos from {p.ingredients.join(", ").toLowerCase()}, with
              no added sugar and no preservatives. Keep it in the fridge and drink it soon after
              delivery. We deliver across Lagos; see{" "}
              <Link to="/juice-delivery-lagos" className={LINK}>
                juice delivery in Lagos
              </Link>{" "}
              for areas, and read{" "}
              <a href="/blog/why-cold-pressed" className={LINK}>
                why cold-pressed juice is worth it
              </a>
              .
            </p>
          )}
          {priceLine && (
            <div className="space-y-4">
              <h3 className={H3}>Price and sizes</h3>
              <p>{priceLine}. Prices are per bottle; the delivery cost is shown at checkout.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
