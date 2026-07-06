import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";

/** One block of policy prose: a heading followed by paragraphs and/or bullet points. */
export interface PolicySection {
  heading: string;
  /** Free paragraphs rendered above any bullets. */
  body?: string[];
  /** Optional bullet list rendered below the paragraphs. */
  bullets?: string[];
}

interface PolicyPageProps {
  eyebrow: string;
  title: React.ReactNode;
  subtitle: string;
  decor: string;
  accent: string;
  /** Human date the copy was last reviewed, e.g. "6 July 2026". */
  lastUpdated: string;
  sections: PolicySection[];
}

export function PolicyPage({ eyebrow, title, subtitle, decor, accent, lastUpdated, sections }: PolicyPageProps) {
  return (
    <SiteShell>
      <PageHero eyebrow={eyebrow} title={title} subtitle={subtitle} decor={decor} accent={accent} />

      <section className="px-5 sm:px-10 max-w-3xl mx-auto pb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--brand)]/50">
          Last updated · {lastUpdated}
        </p>

        <div className="mt-8 space-y-10">
          {sections.map((s, i) => (
            <motion.div
              key={s.heading}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-30px" }}
              transition={{ duration: 0.4, delay: Math.min(i, 4) * 0.03 }}
            >
              <h2 className="font-display text-2xl sm:text-3xl text-[color:var(--brand)]">
                <span className="text-[color:var(--brand-orange)]">{String(i + 1).padStart(2, "0")}.</span>{" "}
                {s.heading}
              </h2>
              {s.body?.map((p, j) => (
                <p key={j} className="mt-3 text-[15px] leading-relaxed text-[color:var(--brand)]/75">
                  {p}
                </p>
              ))}
              {s.bullets && s.bullets.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {s.bullets.map((b, j) => (
                    <li key={j} className="flex gap-3 text-[15px] leading-relaxed text-[color:var(--brand)]/75">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--brand-orange)]" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </motion.div>
          ))}
        </div>
      </section>

      {/* Questions / contact CTA */}
      <section className="px-5 sm:px-10 pb-20">
        <div className="mx-auto max-w-3xl rounded-[1.75rem] bg-[color:var(--brand)] text-white px-7 sm:px-12 py-10 text-center">
          <h2 className="font-display text-3xl">Still have a question?</h2>
          <p className="mt-3 max-w-xl mx-auto text-white/80 text-sm">
            We're a small kitchen and we answer personally. Message us and a real person will get back to you.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a
              href="https://wa.me/2349019512246"
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-3 text-sm font-semibold hover:opacity-90 transition"
            >
              WhatsApp · 0901 951 2246
            </a>
            <Link
              to="/contact"
              className="rounded-full bg-white/10 text-white px-6 py-3 text-sm font-semibold hover:bg-white/20 transition"
            >
              Contact us
            </Link>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
