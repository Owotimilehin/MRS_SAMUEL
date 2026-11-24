import { useState } from "react";
import { motion } from "framer-motion";
import { Plus, Minus } from "lucide-react";
import { LinkedText } from "@/components/LinkedText";

/** Exported so the home route can emit matching FAQPage JSON-LD. */
export const faqs = [
  { q: "Where can I buy fresh juice in Lagos?", a: "Order online at mrssamuel.com for cold delivery, or walk in to our kitchen at 30 Asa Afariogun Street, Ajao Estate, Ikeja. We're open Monday to Saturday 8am–8pm and Sunday 10am–8pm." },
  { q: "How long does the juice last?", a: "About 48 hours from pressing, kept refrigerated. It's cold-pressed and unpasteurised, so keep it chilled the whole way." },
  { q: "Do you add sugar or sweeteners?", a: "Never. The only sweetness is from the fruit itself. No syrups, no concentrates, no preservatives." },
  { q: "Do you deliver nationwide?", a: "We deliver cold all round Lagos, the same morning or the next morning depending on when you order. Other cities by special arrangement: message us on WhatsApp." },
  { q: "Do you supply juice for events and offices?", a: "Yes. We deliver chilled crates for weddings, parties, office fridges and corporate gifts across Lagos. Request a quote on our office orders page." },
  { q: "Can I refrigerate the juice?", a: "Yes, please do. Store between 2–6°C from the moment it arrives and drink it within 48 hours for the best taste." },
];

export function FAQ() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="px-5 sm:px-10 py-16 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-10 items-start">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
            Frequently Asked Questions
          </div>
          <h2 className="mt-3 font-display text-4xl sm:text-5xl font-semibold tracking-tight text-[color:var(--brand)] leading-tight">
            Got Questions?
            <br />
            We've Got Answers.
          </h2>
          <a href="#contact" className="mt-6 inline-flex text-sm font-semibold text-[color:var(--brand-orange)]">
            View All FAQs →
          </a>
        </div>

        <div className="divide-y divide-black/10 rounded-2xl bg-white ring-1 ring-black/5">
          {faqs.map((f, i) => (
            <div key={i} className="px-5">
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center justify-between py-4 text-left"
              >
                <span className="text-[15px] font-semibold text-[color:var(--brand)]">{f.q}</span>
                <span className="grid h-8 w-8 place-items-center rounded-full bg-[color:var(--cream)] text-[color:var(--brand)]">
                  {open === i ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                </span>
              </button>
              {/* Always in the DOM (collapsed, not removed) so every answer is in
                  the server HTML Google reads and matches the FAQPage markup. */}
              <motion.div
                initial={false}
                animate={open === i ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 }}
                className="overflow-hidden"
                aria-hidden={open !== i}
              >
                <p inert={open !== i} className="pb-5 pr-10 text-sm text-[color:var(--brand)]/70 leading-relaxed"><LinkedText text={f.a} /></p>
              </motion.div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
