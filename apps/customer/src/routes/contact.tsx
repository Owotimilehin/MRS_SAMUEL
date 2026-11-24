import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { motion } from "framer-motion";
import { Phone, Mail, MapPin, Clock, Instagram, MessageCircle, Send, ChevronDown } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import { sendContactMessage } from "@/lib/api/server-fns";
import leafMint from "@/assets/decor/leaf-mint.webp";
import { seo, breadcrumbLd, EMAIL } from "@/lib/seo";

export const Route = createFileRoute("/contact")({
  head: () =>
    seo({
      title: "Contact Mrs. Samuel — Order, Partner or Say Hello",
      description:
        "Order, partner, or just say hello. WhatsApp Mrs. Samuel on 0901 951 2246, visit us at 30 Asa Afariogun Street, Ajao Estate, Lagos, or send a message.",
      path: "/contact",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Contact", path: "/contact" }])],
    }),
  component: Page,
});

function Page() {
  const [sent, setSent] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", subject: "", message: "" });
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((p) => ({ ...p, [k]: v }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setErr(null);
    try {
      await sendContactMessage({
        data: {
          name: form.name,
          email: form.email,
          phone: form.phone || undefined,
          subject: form.subject,
          message: form.message,
        },
      });
      setSent(true);
    } catch {
      setErr("Could not send your message. Please WhatsApp us instead.");
    } finally {
      setSending(false);
    }
  }

  return (
    <SiteShell>
      <PageHero
        eyebrow="Get In Touch"
        title={<>Say hello. Order direct.<br /><span className="text-[color:var(--brand-orange)]">Or just ask.</span></>}
        subtitle="Whether it's a single bottle or a wholesale enquiry — the person who replies is on the team that pressed your juice this morning."
        decor={leafMint}
        accent="#a8d27a"
      />

      <section className="px-5 sm:px-10 max-w-7xl mx-auto pb-20 grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-10">
        {/* Form */}
        <motion.form
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          onSubmit={onSubmit}
          className="rounded-[2rem] bg-white p-8 sm:p-10 ring-1 ring-black/5"
        >
          {sent ? (
            <div className="py-16 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[color:var(--brand-orange)]/15 text-[color:var(--brand-orange)]">
                <Send className="h-6 w-6" />
              </div>
              <h3 className="mt-4 font-display text-2xl text-[color:var(--brand)]">Thank you — we'll be in touch.</h3>
              <p className="mt-2 text-[color:var(--brand)]/70 text-sm">Mrs. Samuel reads every message personally. Allow up to 24 hours, usually faster.</p>
            </div>
          ) : (
            <>
              <h2 className="font-display text-3xl text-[color:var(--brand)]">Send a message</h2>
              <p className="mt-2 text-sm text-[color:var(--brand)]/70">Form goes straight to the kitchen.</p>
              <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Your name" required><input required value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="Adekunle" /></Field>
                <Field label="Email" required><input required type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className={inputCls} placeholder="you@email.com" /></Field>
                <Field label="Phone (WhatsApp preferred)"><input value={form.phone} onChange={(e) => set("phone", e.target.value)} className={inputCls} placeholder="+234..." /></Field>
                <Field label="Subject" required>
                  <div className="relative">
                  <select required value={form.subject} onChange={(e) => set("subject", e.target.value)} className={inputCls + " appearance-none pr-10" + (form.subject ? "" : " text-[color:var(--brand)]/40")}>
                    <option value="" disabled>Choose...</option>
                    <option>Order enquiry</option>
                    <option>Events & parties</option>
                    <option>Corporate / office</option>
                    <option>Wholesale / B2B</option>
                    <option>Press / partnership</option>
                    <option>Just saying hi</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--brand)]/50" aria-hidden />
                  </div>
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Message" required>
                  <textarea required rows={5} value={form.message} onChange={(e) => set("message", e.target.value)} className={inputCls + " resize-none"} placeholder="Tell us what you need..." />
                </Field>
              </div>
              {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
              <button type="submit" disabled={sending} className="mt-6 inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold hover:bg-[color:var(--brand-orange)] transition disabled:opacity-50">
                {sending ? "Sending…" : "Send message"} <Send className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </motion.form>

        {/* Contact details */}
        <div className="space-y-4">
          <a href="https://wa.me/2349019512246" target="_blank" rel="noreferrer" className="block rounded-2xl bg-[color:var(--brand-orange)] text-white p-6 hover:opacity-95 transition">
            <div className="flex items-center gap-3">
              <MessageCircle className="h-5 w-5" />
              <div className="text-xs font-bold uppercase tracking-[0.22em] text-white/80">Fastest</div>
            </div>
            <h3 className="mt-2 font-display text-2xl">WhatsApp Mrs. Samuel</h3>
            <p className="mt-1 text-white/85 text-sm">0901 951 2246 — replies usually within the hour during business hours.</p>
          </a>

          <Detail Icon={Phone} title="Phone" body="0901 951 2246" link="tel:+2349019512246" />
          <Detail Icon={Mail} title="Email" body={EMAIL} link={`mailto:${EMAIL}`} />
          <Detail Icon={MapPin} title="Lagos kitchen" body="30 Asa Afariogun Street, opposite Access Bank, Ajao Estate, Lagos" />
          <Detail Icon={Instagram} title="Instagram" body="@Mrs_samuelfruitjuice" link="https://instagram.com/Mrs_samuelfruitjuice" />
          <Detail Icon={Clock} title="Hours" body={<>Mon–Sat · 8am–8pm<br />Sun · 10am–8pm</>} />
        </div>
      </section>

      {/* FAQ teaser */}
      <section className="px-5 sm:px-10 pb-20">
        <div className="mx-auto max-w-4xl rounded-[2rem] bg-[color:var(--brand)] text-white p-10 text-center">
          <h2 className="font-display text-3xl">Quick questions?</h2>
          <p className="mt-2 text-white/80 text-sm max-w-lg mx-auto">Delivery zones, shelf life, returning glass bottles — most answers live in the{" "}
            <Link to="/" hash="faq" className="font-semibold text-white underline underline-offset-2 hover:text-[color:var(--brand-orange)]">FAQ on our home page</Link>.
          </p>
        </div>
      </section>
    </SiteShell>
  );
}

const inputCls =
  "w-full rounded-xl border border-black/10 bg-[color:var(--cream)]/40 px-4 py-3 text-base sm:text-sm text-[color:var(--brand)] placeholder:text-[color:var(--brand)]/40 focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-orange)]/40";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-[color:var(--brand)]/70">
        {label}{required && <span className="text-[color:var(--brand-orange)]"> *</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Detail({ Icon, title, body, link }: { Icon: typeof Phone; title: string; body: React.ReactNode; link?: string }) {
  const inner = (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-black/5 hover:shadow-md transition flex items-start gap-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[color:var(--brand-orange)]/10 text-[color:var(--brand-orange)]">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/60">{title}</div>
        <div className="mt-1 text-[color:var(--brand)] font-semibold break-words">{body}</div>
      </div>
    </div>
  );
  if (!link) return inner;
  const external = /^https?:/i.test(link);
  return (
    <a href={link} className="block" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {inner}
    </a>
  );
}
