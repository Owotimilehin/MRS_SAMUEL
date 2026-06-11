import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Minus } from "lucide-react";

const faqs = [
  { q: "How long does the juice last?", a: "Up to 4 days refrigerated. Cold-pressed and unpasteurised, so the cold chain matters — keep it chilled the whole way." },
  { q: "Do you add sugar or sweeteners?", a: "Never. The only sweetness is from the fruit itself. No syrups, no concentrates, no preservatives." },
  { q: "Do you deliver nationwide?", a: "Same-day cold delivery across Lagos. Other cities by special arrangement — message us on WhatsApp." },
  { q: "Can I refrigerate the juice?", a: "Yes, please do. Store between 2–6°C from the moment it arrives and consume within 4 days for the best taste." },
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
              <AnimatePresence>
                {open === i && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <p className="pb-5 pr-10 text-sm text-[color:var(--brand)]/70 leading-relaxed">{f.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
