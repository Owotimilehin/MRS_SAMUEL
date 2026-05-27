import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SiteLayout } from "../components/SiteLayout.js";
import { api, ngn } from "../lib/api.js";
import { BRAND, bottleFor, MENU, type MenuItem } from "../data/menu.js";
import { useCart } from "../store/cart.js";
import { Button, Eyebrow } from "../components/ui/index.js";
import { InlineLoader } from "../components/Spinner.js";

interface CatalogProduct {
  id: string;
  name: string;
  slug: string;
  category: "regular" | "special" | "punch";
  ingredients: string[];
  price_ngn: number;
}

export function SpecialsPage(): JSX.Element {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const addToCart = useCart((s) => s.add);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: CatalogProduct[] }>("/catalog/products");
        if (cancelled) return;
        setProducts(res.data.filter((p) => p.category === "special"));
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

  function findMenuItem(slug: string): MenuItem | undefined {
    return MENU.find(
      (m) =>
        m.name
          .toLowerCase()
          .replace(/\./g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") === slug,
    );
  }

  function handleAdd(p: CatalogProduct): void {
    const menuItem = findMenuItem(p.slug);
    const variantId = menuItem ? `${menuItem.id}-650` : p.id;
    const variantName = menuItem ? `${menuItem.name} (650ml)` : p.name;
    addToCart({
      product_id: variantId,
      name: variantName,
      unit_price_ngn: p.price_ngn,
    });
    setFlashId(p.id);
    window.setTimeout(() => setFlashId(null), 1500);
  }

  return (
    <SiteLayout
      active="specials"
      meta={{
        title: "Our specials — Mrs. Samuel Fruit Juice",
        description:
          "Limited-edition cold-pressed juices from Mrs. Samuel: Pink Paradise, Guyabano Delight, and the rotating fruit punch. Same-day delivery in Lagos.",
      }}
    >
      {/* ───── Hero ───── */}
      <section className="ms-container ms-specials__hero">
        <div className="ms-specials__hero-text">
          <Eyebrow>Limited editions</Eyebrow>
          <h1 className="ms-h1">
            The bottles we make when something <span className="text-grad">extra</span> walks in
            the door.
          </h1>
          <p className="ms-sub" style={{ maxWidth: 540, marginTop: 18 }}>
            Specials are the seasonal, premium and small-batch blends — built around fruits we
            only get for a few weeks at a time, or recipes that take twice the work to do
            properly. Order them when you see them.
          </p>
        </div>
      </section>

      {/* ───── Grid ───── */}
      <section className="ms-container" style={{ paddingBottom: 56 }}>
        {error && (
          <div
            className="ms-checkout__error"
            style={{ maxWidth: 520, marginBottom: 18 }}
            role="alert"
          >
            Couldn't load the live catalog — {error}. Try a refresh, or order on WhatsApp.
          </div>
        )}

        {loading ? (
          <InlineLoader label="Loading specials…" />
        ) : products.length === 0 ? (
          <div className="ms-specials__empty">
            <Eyebrow>Coming back soon</Eyebrow>
            <h2 className="ms-section-title" style={{ marginBottom: 10 }}>
              No specials available right now.
            </h2>
            <p className="ms-section-sub" style={{ marginBottom: 22 }}>
              We only run them when the fruit is at its peak. Check the regular menu — every
              bottle on it is still cold-pressed the same morning.
            </p>
            <Link to="/" className="btn btn--primary">
              See the regular menu
            </Link>
          </div>
        ) : (
          <div className="ms-specials__grid">
            {products.map((p) => {
              const menuItem = findMenuItem(p.slug);
              const bottleSrc = menuItem
                ? bottleFor(menuItem)
                : `/assets/bottles/${p.slug}-tight.png`;
              return (
                <article key={p.id} className="ms-specials__card">
                  <div className="ms-specials__media">
                    <img
                      src={bottleSrc}
                      alt={p.name}
                      onError={(e) => {
                        const img = e.currentTarget;
                        if (img.src.endsWith("/assets/bottle-hero.png")) return;
                        img.src = "/assets/bottle-hero.png";
                      }}
                    />
                  </div>
                  <div className="ms-specials__body">
                    <Eyebrow>Special edition</Eyebrow>
                    <h2 className="ms-specials__name">{p.name}</h2>
                    <p className="ms-specials__ings">
                      {p.ingredients.length > 0
                        ? p.ingredients.join(" · ")
                        : "House blend"}
                    </p>
                    <div className="ms-specials__price-row">
                      <div className="ms-specials__price">{ngn(p.price_ngn)}</div>
                      <div className="ms-specials__size">650ml</div>
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => handleAdd(p)}
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      {flashId === p.id ? "✓ Added" : "Add to cart"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ───── Footer CTA ───── */}
      <section className="ms-container" style={{ paddingBottom: 48 }}>
        <div className="ms-about__cta-card">
          <Eyebrow>Want one made for you?</Eyebrow>
          <h2 className="ms-section-title" style={{ marginBottom: 10 }}>
            Custom-blend a special for an event.
          </h2>
          <p className="ms-section-sub" style={{ maxWidth: 480, margin: "0 auto 22px" }}>
            Birthdays, office parties, weddings — message us on WhatsApp with the date and
            the headcount, and we'll build a recipe for you.
          </p>
          <a
            href={`https://wa.me/${BRAND.whatsapp}?text=${encodeURIComponent(
              "Hi! I'd like to commission a custom Mrs. Samuel special for an event.",
            )}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn--primary"
          >
            Talk to us on WhatsApp
          </a>
        </div>
      </section>
    </SiteLayout>
  );
}
