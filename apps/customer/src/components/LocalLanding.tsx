import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MapPin, Clock, Leaf, MessageCircle } from "lucide-react";
import type { Product } from "@/lib/api/mappers";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { formatNaira } from "@/lib/cart";
import { whatsappLink } from "@/lib/whatsapp";
import { LinkedText } from "@/components/LinkedText";
import { IMG_SIZE, webpSrc } from "@/lib/media";

export interface LocalFaq {
  q: string;
  a: string;
}

interface Props {
  eyebrow: string;
  title: ReactNode;
  subtitle: string;
  decor?: string;
  /** Plain-text paragraphs unique to this page. */
  intro: string[];
  notes: string[];
  products: Product[];
  faqs: LocalFaq[];
  whatsappMessage: string;
  /** Extra section rendered after the juice grid (e.g. the list of areas). */
  children?: ReactNode;
}

/**
 * Shared layout for local landing pages (/juice-delivery-lagos and
 * /juice-delivery-lagos/<area>). Everything is server-rendered plain HTML —
 * FAQ answers included — so Google can read the whole page.
 */
export function LocalLanding({
  eyebrow, title, subtitle, decor, intro, notes, products, faqs, whatsappMessage, children,
}: Props) {
  return (
    <SiteShell>
      <PageHero eyebrow={eyebrow} title={title} subtitle={subtitle} decor={decor} accent="#fdc651" />

      <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-12">
        <div className="space-y-4 text-[16px] leading-relaxed text-[color:var(--brand)]/80">
          {intro.map((p, i) => <p key={i}>{p}</p>)}
        </div>

        <ul className="mt-8 grid gap-4 sm:grid-cols-3">
          {[
            { icon: Leaf, text: "100% fruit. No added sugar, no water, no preservatives." },
            { icon: Clock, text: "Pressed in the morning, delivered cold." },
            { icon: MapPin, text: "Made in our kitchen at Ajao Estate, Ikeja." },
          ].map(({ icon: Icon, text }) => (
            <li key={text} className="flex gap-3 rounded-2xl bg-white p-4 ring-1 ring-black/5 text-sm text-[color:var(--brand)]">
              <Icon className="h-5 w-5 shrink-0 text-[color:var(--brand-orange)]" aria-hidden />
              {text}
            </li>
          ))}
        </ul>

        {notes.length > 0 && (
          <>
            <h2 className="mt-12 font-display text-3xl font-semibold text-[color:var(--brand)]">Good to know</h2>
            <ul className="mt-4 list-disc pl-5 space-y-2 text-[15px] leading-relaxed text-[color:var(--brand)]/80">
              {notes.map((n, i) => <li key={i}><LinkedText text={n} /></li>)}
            </ul>
          </>
        )}
      </section>

      {products.length > 0 && (
        <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-12">
          <h2 className="font-display text-3xl font-semibold text-[color:var(--brand)]">Popular fresh juices</h2>
          <ul className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map((p) => (
              <li key={p.id}>
                <Link
                  to="/juices/$id"
                  params={{ id: p.id }}
                  className="flex h-full flex-col items-center rounded-2xl bg-white p-4 text-center ring-1 ring-black/5 hover:shadow-lg transition"
                >
                  <img src={webpSrc(p.image)} alt={`${p.name} fresh juice bottle`} width={IMG_SIZE.bottle.width} height={IMG_SIZE.bottle.height} loading="lazy" className="h-32 w-auto object-contain" />
                  <span className="mt-3 font-semibold text-[color:var(--brand)]">{p.name}</span>
                  {p.prices["330ml"] > 0 && (
                    <span className="text-xs text-[color:var(--brand)]/60">from {formatNaira(p.prices["330ml"])}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {children}

      {faqs.length > 0 && (
        <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-12">
          <h2 className="font-display text-3xl font-semibold text-[color:var(--brand)]">Questions</h2>
          <dl className="mt-6 divide-y divide-black/10 rounded-2xl bg-white ring-1 ring-black/5">
            {faqs.map((f) => (
              <div key={f.q} className="px-5 py-4">
                <dt className="font-semibold text-[color:var(--brand)]">{f.q}</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-[color:var(--brand)]/75"><LinkedText text={f.a} /></dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-20">
        <div className="flex flex-wrap gap-4">
          <Link
            to="/shop"
            className="inline-flex rounded-full bg-[color:var(--brand)] px-6 py-3.5 text-sm font-semibold text-white hover:bg-[color:var(--brand-orange)] transition"
          >
            Order fresh juice
          </Link>
          <a
            href={whatsappLink(whatsappMessage)}
            className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-[color:var(--brand)] ring-1 ring-black/10 hover:bg-black/5 transition"
          >
            <MessageCircle className="h-4 w-4" aria-hidden /> Ask on WhatsApp
          </a>
        </div>
      </section>
    </SiteShell>
  );
}
