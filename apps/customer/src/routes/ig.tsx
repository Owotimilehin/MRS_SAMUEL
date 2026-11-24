import { createFileRoute, Link } from "@tanstack/react-router";
import { ShoppingBag, Truck, Users, BookOpen, MessageCircle, Instagram, Star } from "lucide-react";
import { seo } from "@/lib/seo";
import { whatsappLink } from "@/lib/whatsapp";
import { INSTAGRAM_PROFILE } from "@/lib/instagram-fallback";
import logoDark from "@/assets/logo-dark.webp";

/**
 * Instagram bio link: mrssamuel.com/ig. Replaces Linktree-style tools so
 * Instagram traffic lands on our own domain (and every visit is ours to
 * measure). noindex: it's a link hub, not a page we want ranking.
 *
 * GOOGLE_REVIEW_URL: paste the short link from Google Business Profile →
 * "Ask for reviews". The button is hidden while it's empty.
 */
const GOOGLE_REVIEW_URL = "";

export const Route = createFileRoute("/ig")({
  head: () =>
    seo({
      title: "Mrs. Samuel Fruit Juice — Order Fresh Juice in Lagos",
      description: "Order fresh, cold-pressed juice delivered across Lagos. Shop, bulk orders, WhatsApp and more.",
      path: "/ig",
      noIndex: true,
    }),
  component: Page,
});

type Item = { label: string; sub: string; icon: typeof ShoppingBag } & ({ to: string } | { href: string });

function Page() {
  const items: Item[] = [
    { label: "Order fresh juice", sub: "Every flavour, delivered cold", icon: ShoppingBag, to: "/shop" },
    { label: "Delivery across Lagos", sub: "Lekki, VI, Ikeja, Yaba and more", icon: Truck, to: "/juice-delivery-lagos" },
    { label: "Parties, weddings & offices", sub: "Request a quote for bulk orders", icon: Users, to: "/bulk-orders" },
    { label: "Chat on WhatsApp", sub: "Questions, custom orders", icon: MessageCircle, href: whatsappLink("Hi Mrs. Samuel! I found you on Instagram.") },
    ...(GOOGLE_REVIEW_URL
      ? [{ label: "Leave us a Google review", sub: "It really helps a Lagos small business", icon: Star, href: GOOGLE_REVIEW_URL } as Item]
      : []),
    { label: "Juice & wellness journal", sub: "Zobo, tigernut, green juice guides", icon: BookOpen, to: "/blog" },
  ];
  return (
    <main className="min-h-screen bg-[color:var(--cream)] px-4 py-10">
      <div className="mx-auto max-w-md text-center">
        <img src={logoDark} alt="Mrs. Samuel Fruit Juice" className="mx-auto h-16 w-auto object-contain" />
        <h1 className="mt-4 font-display text-2xl font-semibold text-[color:var(--brand)]">Fresh juice, made in Lagos</h1>
        <p className="mt-1 text-sm text-[color:var(--brand)]/70">100% fruit · No added sugar · Delivered cold</p>
        <ul className="mt-8 space-y-3 text-left">
          {items.map((it) => {
            const Icon = it.icon;
            const inner = (
              <>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[color:var(--brand)] text-white">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span>
                  <span className="block font-semibold text-[color:var(--brand)]">{it.label}</span>
                  <span className="block text-xs text-[color:var(--brand)]/65">{it.sub}</span>
                </span>
              </>
            );
            const cls = "flex items-center gap-4 rounded-2xl bg-white p-4 ring-1 ring-black/5 shadow-sm hover:shadow-md transition";
            return (
              <li key={it.label}>
                {"to" in it ? (
                  <Link to={it.to} className={cls}>{inner}</Link>
                ) : (
                  <a href={it.href} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
                )}
              </li>
            );
          })}
        </ul>
        <a
          href={INSTAGRAM_PROFILE}
          className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-[color:var(--brand)]/70"
        >
          <Instagram className="h-4 w-4" aria-hidden /> @Mrs_samuelfruitjuice
        </a>
      </div>
    </main>
  );
}
