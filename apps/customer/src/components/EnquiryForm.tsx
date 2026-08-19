import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { submitEnquiry } from "@/lib/api/server-fns";
import { whatsappLink } from "@/lib/whatsapp";

interface Props {
  enquiryType: "white_label" | "bulk_order";
  /** Pre-filled first WhatsApp message. */
  template: string;
  cta: string;
}

/**
 * Name + phone, then straight to WhatsApp.
 *
 * The button is a real `<a href>` pointing at wa.me, so it works the instant
 * the HTML paints — before React hydrates, and with JS disabled entirely. This
 * is the same lesson the checkout learned: a CTA that only works after
 * hydration is a dead tap for exactly the visitors on the worst connections.
 *
 * When JS *is* available we intercept, record the enquiry so the owner has a
 * record even if the visitor never sends the message, then continue to
 * WhatsApp. The recording is best-effort and never blocks the hand-off.
 */
export function EnquiryForm({ enquiryType, template, cta }: Props) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);

  const message = template + (name ? `\n\nMy name is ${name}.` : "");
  const href = whatsappLink(message);

  async function handle(e: React.MouseEvent<HTMLAnchorElement>) {
    // No details entered: let the plain link through untouched.
    if (!name.trim() || !phone.trim()) return;
    e.preventDefault();
    setSending(true);
    try {
      await submitEnquiry({ data: { name: name.trim(), phone: phone.trim(), enquiry_type: enquiryType } });
    } catch {
      /* never block the hand-off */
    }
    window.open(href, "_blank", "noopener");
    setSending(false);
  }

  return (
    <div className="rounded-[1.5rem] bg-white ring-1 ring-black/5 p-6 sm:p-8">
      <h3 className="font-display text-2xl text-[color:var(--brand)]">Let's talk</h3>
      <p className="mt-2 text-sm text-[color:var(--brand)]/70">
        Leave your name and number and we'll pick it up on WhatsApp — usually within the hour.
      </p>
      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55 mb-1.5">
            Your name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Adaeze Okeke"
            autoComplete="name"
            className="w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm text-[color:var(--brand)] ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55 mb-1.5">
            Phone
          </span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="0800 000 0000"
            autoComplete="tel"
            inputMode="tel"
            className="w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm text-[color:var(--brand)] ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none"
          />
        </label>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={handle}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-4 text-sm font-semibold hover:opacity-95 transition"
      >
        <MessageCircle className="h-4 w-4" />
        {sending ? "Opening WhatsApp…" : cta}
      </a>
      <p className="mt-3 text-center text-xs text-[color:var(--brand)]/50">
        Opens WhatsApp. No account or payment needed to ask.
      </p>
    </div>
  );
}
