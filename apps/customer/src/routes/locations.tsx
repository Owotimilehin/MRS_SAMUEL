import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SiteLayout } from "../components/SiteLayout.js";
import { api, ngn } from "../lib/api.js";
import { BRAND } from "../data/menu.js";
import { Eyebrow } from "../components/ui/index.js";

interface DeliveryZone {
  name: string;
  fee_ngn: number;
}
interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  delivery_zones: DeliveryZone[];
  opens_at: string | null;
  closes_at: string | null;
}

function formatHours(opens: string | null, closes: string | null): string {
  if (!opens || !closes) return "Hours by appointment";
  return `${opens.slice(0, 5)} – ${closes.slice(0, 5)}`;
}

function mapsLink(address: string | null, name: string): string {
  const q = encodeURIComponent(address ? `${name}, ${address}` : name);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export function LocationsPage(): JSX.Element {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: Branch[] }>("/catalog/branches");
        if (!cancelled) setBranches(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SiteLayout
      active="locations"
      meta={{
        title: "Visit us — Mrs. Samuel Fruit Juice locations in Lagos",
        description:
          "Find Mrs. Samuel Fruit Juice in Ajao Estate, Lagos. Same-day cold-pressed juice delivery across the city. See our locations, hours, and delivery zones.",
      }}
    >
      <section className="ms-container ms-locations__hero">
        <Eyebrow>Find us</Eyebrow>
        <h1 className="ms-h1">
          We're in <span className="text-grad">Lagos</span>, and we deliver same-day.
        </h1>
        <p className="ms-sub" style={{ maxWidth: 560, marginTop: 14 }}>
          Each Mrs. Samuel branch presses, bottles and dispatches its own juice — so what
          you order arrives within hours of being made. Come in, or stay home and we'll bring
          it.
        </p>
      </section>

      <section className="ms-container" style={{ paddingBottom: 56 }}>
        {error && (
          <div
            className="ms-checkout__error"
            style={{ maxWidth: 520, marginBottom: 18 }}
            role="alert"
          >
            Couldn't load locations — {error}.
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--ink-soft)" }}>
            Loading locations…
          </div>
        ) : branches.length === 0 ? (
          <div className="ms-specials__empty">
            <Eyebrow>Opening soon</Eyebrow>
            <h2 className="ms-section-title" style={{ marginBottom: 10 }}>
              No branches configured yet.
            </h2>
            <p className="ms-section-sub" style={{ marginBottom: 22 }}>
              Message us on WhatsApp — we'll let you know the moment we're live in your
              neighbourhood.
            </p>
            <a
              href={`https://wa.me/${BRAND.whatsapp}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn--primary"
            >
              Message us
            </a>
          </div>
        ) : (
          <div className="ms-locations__grid">
            {branches.map((b) => (
              <article key={b.id} className="ms-locations__card">
                <header className="ms-locations__head">
                  <h2 className="ms-locations__name">{b.name}</h2>
                  <span className="ms-locations__hours">
                    🕒 {formatHours(b.opens_at, b.closes_at)}
                  </span>
                </header>

                {b.address && (
                  <a
                    href={mapsLink(b.address, b.name)}
                    target="_blank"
                    rel="noreferrer"
                    className="ms-locations__addr"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                    <span>{b.address}</span>
                  </a>
                )}

                {b.phone && (
                  <a
                    href={`tel:${b.phone.replace(/\s/g, "")}`}
                    className="ms-locations__phone"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
                    </svg>
                    <span>{b.phone}</span>
                  </a>
                )}

                {b.delivery_zones.length > 0 && (
                  <div className="ms-locations__zones">
                    <div className="ms-locations__zones-head">Delivery zones</div>
                    <ul>
                      {b.delivery_zones.map((z) => (
                        <li key={z.name}>
                          <span>{z.name}</span>
                          <span className="tabular-nums">{ngn(z.fee_ngn)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="ms-locations__actions">
                  <a
                    href={`https://wa.me/${BRAND.whatsapp}?text=${encodeURIComponent(
                      `Hi! I'd like to order from ${b.name}.`,
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn--primary"
                    style={{ flex: 1, justifyContent: "center" }}
                  >
                    Order on WhatsApp
                  </a>
                  <Link to="/" className="btn btn--ghost">
                    See menu
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="ms-container" style={{ paddingBottom: 48 }}>
        <div className="ms-about__cta-card">
          <Eyebrow>Don't see your area?</Eyebrow>
          <h2 className="ms-section-title" style={{ marginBottom: 10 }}>
            We're expanding across Lagos.
          </h2>
          <p className="ms-section-sub" style={{ maxWidth: 480, margin: "0 auto 22px" }}>
            Drop us a message and tell us where you're based — every new request helps us
            decide where to open next.
          </p>
          <a
            href={`https://wa.me/${BRAND.whatsapp}?text=${encodeURIComponent(
              "Hi! Please bring Mrs. Samuel to my area: ",
            )}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn--primary"
          >
            Suggest a location
          </a>
        </div>
      </section>
    </SiteLayout>
  );
}
