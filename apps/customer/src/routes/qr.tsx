import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/components/SiteShell";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/qr")({
  head: () =>
    seo({
      title: "Mrs. Samuel QR Code — Scan or Download | Cold-Pressed Juice Lagos",
      description:
        "Scan or download the official Mrs. Samuel Fruit Juice QR code. It links to mrssamuel.com — order fresh, cold-pressed Nigerian juice delivered in Lagos.",
      path: "/qr",
      image: "/qr.png",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "QR Code", path: "/qr" }])],
    }),
  component: Page,
});

function Page() {
  return (
    <SiteShell>
      <section className="px-5 max-w-3xl mx-auto py-24 sm:py-32 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[color:var(--brand-orange)]">
          Scan • Share • Order
        </p>
        <h1 className="mt-3 font-display text-4xl sm:text-6xl font-semibold tracking-tight text-[color:var(--brand)] leading-[1.05]">
          Mrs. Samuel QR Code
        </h1>
        <p className="mt-4 text-[17px] leading-[1.7] text-[color:var(--brand)]/75 max-w-xl mx-auto">
          Point your phone camera at the code below and it opens{" "}
          <strong>mrssamuel.com</strong> — where you can order fresh, cold-pressed
          Nigerian juice for same-morning delivery in Lagos.
        </p>

        <div className="mt-10 inline-flex flex-col items-center rounded-3xl bg-white ring-1 ring-black/5 shadow-xl px-8 py-8">
          <img
            src="/qr.png"
            alt="Mrs. Samuel Fruit Juice QR code linking to mrssamuel.com"
            width={280}
            height={280}
            className="h-[280px] w-[280px] object-contain"
          />
          <a
            href="/qr.png"
            download="mrssamuel-qr.png"
            className="mt-6 inline-flex items-center justify-center rounded-full bg-[color:var(--brand)] px-7 py-3 text-sm font-semibold text-white transition hover:bg-[color:var(--brand-orange)]"
          >
            Download QR code (PNG)
          </a>
          <span className="mt-3 text-xs text-[color:var(--brand)]/55">
            Print it, share it, or stick it anywhere — it always points to mrssamuel.com
          </span>
        </div>
      </section>
    </SiteShell>
  );
}
