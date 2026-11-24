import type { ReactNode } from "react";
import type { EnquiryType } from "@/lib/api/server-fns";
import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, type LucideIcon } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { EnquiryForm } from "@/components/EnquiryForm";
import { LinkedText } from "@/components/LinkedText";

export interface ServiceFaq {
  q: string;
  a: string;
}

export interface ServiceCard {
  Icon: LucideIcon;
  title: string;
  desc: string;
}

export interface ServiceSection {
  heading: string;
  /** Paragraphs. May contain <Link>s. */
  body: ReactNode[];
  bullets?: string[];
}

type InternalPath =
  | "/juices"
  | "/juice-delivery-lagos"
  | "/bulk-orders"
  | "/white-label"
  | "/events-juice-lagos"
  | "/corporate"
  | "/gifts"
  | "/delivery"
  | "/shop"
  | "/contact"
  | "/about";

export interface RelatedLink {
  to: InternalPath;
  label: string;
}

/** Every service page links to the juices and the Lagos delivery page. */
const ALWAYS_RELATED: RelatedLink[] = [
  { to: "/juices", label: "Browse all our juices" },
  { to: "/juice-delivery-lagos", label: "Fresh juice delivery in Lagos" },
];

interface Props {
  eyebrow: string;
  title: ReactNode;
  subtitle: string;
  decor?: string;
  accent?: string;
  intro: ReactNode[];
  cardsHeading?: string;
  cards?: ServiceCard[];
  sections: ServiceSection[];
  checklistHeading: string;
  checklist: string[];
  checklistNote: string;
  enquiry: {
    type: EnquiryType;
    cta: string;
    template: string;
    leadSource: string;
    heading?: string;
  };
  faqs: ServiceFaq[];
  related?: RelatedLink[];
  /** Extra section rendered before the FAQ (e.g. a gallery). */
  children?: ReactNode;
}

const h2 = "font-display text-3xl font-semibold text-[color:var(--brand)]";
const prose = "space-y-4 text-[16px] leading-relaxed text-[color:var(--brand)]/80";

/**
 * Shared layout for service pages (events, corporate, gifts, bulk orders,
 * white label). All copy, FAQ answers included, is plain server-rendered
 * HTML, so it matches the FAQPage JSON-LD each route emits.
 */
export function ServiceLanding({
  eyebrow,
  title,
  subtitle,
  decor,
  accent,
  intro,
  cardsHeading,
  cards = [],
  sections,
  checklistHeading,
  checklist,
  checklistNote,
  enquiry,
  faqs,
  related = [],
  children,
}: Props) {
  const links = [...ALWAYS_RELATED, ...related];
  return (
    <SiteShell>
      <PageHero eyebrow={eyebrow} title={title} subtitle={subtitle} decor={decor} accent={accent} />

      <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-12">
        <div className={prose}>
          {intro.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </section>

      {cards.length > 0 && (
        <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-16">
          {cardsHeading && <h2 className={`${h2} mb-6`}>{cardsHeading}</h2>}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {cards.map((c, i) => (
              <motion.div
                key={c.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.06 }}
                className="rounded-[1.25rem] bg-white ring-1 ring-black/5 p-6"
              >
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-[color:var(--brand-orange)]/10">
                  <c.Icon className="h-5 w-5 text-[color:var(--brand-orange)]" aria-hidden />
                </div>
                <h3 className="mt-4 font-semibold text-[color:var(--brand)]">{c.title}</h3>
                <p className="mt-1.5 text-sm text-[color:var(--brand)]/70 leading-relaxed">
                  {c.desc}
                </p>
              </motion.div>
            ))}
          </div>
        </section>
      )}

      <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-8 space-y-12">
        {sections.map((s) => (
          <div key={s.heading}>
            <h2 className={h2}>{s.heading}</h2>
            <div className={`mt-4 ${prose}`}>
              {s.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            {s.bullets && s.bullets.length > 0 && (
              <ul className="mt-4 list-disc pl-5 space-y-2 text-[15px] leading-relaxed text-[color:var(--brand)]/80">
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      <section
        id="quote"
        className="px-5 sm:px-10 max-w-7xl mx-auto py-12 scroll-mt-28"
        aria-label="Request a quote"
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start">
          <div className="rounded-[1.5rem] bg-[color:var(--brand)] text-white p-8">
            <h2 className="font-display text-3xl">{checklistHeading}</h2>
            <ul className="mt-6 space-y-3">
              {checklist.map((s) => (
                <li key={s} className="flex items-start gap-3 text-sm text-white/85">
                  <Check className="h-4 w-4 shrink-0 mt-0.5 text-[color:var(--brand-orange)]" />
                  {s}
                </li>
              ))}
            </ul>
            <p className="mt-8 text-sm text-white/70 leading-relaxed">{checklistNote}</p>
          </div>

          <EnquiryForm
            enquiryType={enquiry.type}
            cta={enquiry.cta}
            template={enquiry.template}
            leadSource={enquiry.leadSource}
            heading={enquiry.heading}
          />
        </div>
      </section>

      {children}

      {faqs.length > 0 && (
        <section className="px-5 sm:px-10 max-w-5xl mx-auto py-12">
          <h2 className={h2}>Frequently asked questions</h2>
          <dl className="mt-6 divide-y divide-black/10 rounded-2xl bg-white ring-1 ring-black/5">
            {faqs.map((f) => (
              <div key={f.q} className="px-5 py-4">
                <dt className="font-semibold text-[color:var(--brand)]">{f.q}</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-[color:var(--brand)]/75">
                  <LinkedText text={f.a} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <nav aria-label="Related pages" className="px-5 sm:px-10 max-w-5xl mx-auto pb-20">
        <h2 className={h2}>Keep exploring</h2>
        <ul className="mt-4 flex flex-wrap gap-3">
          {links.map((l) => (
            <li key={l.to}>
              <Link
                to={l.to}
                className="inline-flex min-h-11 items-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[color:var(--brand)] ring-1 ring-black/10 hover:bg-black/5"
              >
                {l.label} →
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </SiteShell>
  );
}
