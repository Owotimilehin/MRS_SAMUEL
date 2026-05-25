import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  MENU,
  bottleFor,
  priceFor,
  type MenuItem,
  type Size,
} from "../data/menu.js";
import { useCart } from "../store/cart.js";
import { useCatalog } from "../store/catalog.js";
import { ngn } from "../lib/api.js";
import { SiteLayout } from "../components/SiteLayout.js";
import { Eyebrow, SizeToggle } from "../components/ui/index.js";

const FILTERS = [
  { id: "all", label: "All 17" },
  { id: "regular", label: "Regulars" },
  { id: "special", label: "Specials" },
  { id: "punch", label: "Punch" },
] as const;

export function ShopPage(): JSX.Element {
  const [filter, setFilter] = useState<typeof FILTERS[number]["id"]>("all");
  const loadCatalog = useCatalog((s) => s.load);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const visible = useMemo(
    () => (filter === "all" ? MENU : MENU.filter((m) => m.category === filter)),
    [filter],
  );

  return (
    <SiteLayout
      active="menu"
      meta={{
        title: "Shop · Mrs. Samuel",
        description: "Cold-pressed juices delivered same-day in Lagos.",
      }}
    >
      <main className="ms-shop ms-container">
        <header className="ms-shop__head">
          <Eyebrow>The full menu</Eyebrow>
          <h1 className="ms-section-title">17 cold-pressed juices</h1>
          <p className="ms-section-sub">
            ₦2,500 – ₦3,500 · Bottled fresh every morning · No sugar · No preservatives
          </p>
        </header>

        <div className="ms-full__tabs" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={filter === f.id ? "is-active" : ""}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="ms-cart__empty" style={{ padding: "60px 0" }}>
            <Eyebrow>Empty category</Eyebrow>
            <h2 className="ms-section-title">No juices in this category yet.</h2>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setFilter("all")}
            >
              Show everything
            </button>
          </div>
        ) : (
          <div className="ms-full__grid">
            {visible.map((item) => (
              <ShopCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </main>
    </SiteLayout>
  );
}

function ShopCard({ item }: { item: MenuItem }): JSX.Element {
  const [size, setSize] = useState<Size>(650);
  const variantFor = useCatalog((s) => s.variantFor);
  const live = variantFor(item.name, size);
  const price = live?.price_ngn ?? priceFor(item, size);
  const addToCart = useCart((s) => s.add);
  const productPath = String(item.id);

  return (
    <article className="menu-card">
      <Link
        to="/shop/$productId"
        params={{ productId: productPath }}
        className="menu-card__media"
        aria-label={`See ${item.name}`}
      >
        <img
          src={bottleFor(item)}
          alt={item.name}
          onError={(e) => {
            const img = e.currentTarget;
            if (img.src.endsWith("/assets/bottle-hero.png")) return;
            img.src = "/assets/bottle-hero.png";
          }}
        />
      </Link>
      <div className="menu-card__body">
        <div className="menu-card__head">
          <Link
            to="/shop/$productId"
            params={{ productId: productPath }}
            className="menu-card__name"
            style={{ textDecoration: "none", color: "inherit" }}
          >
            {item.name}
          </Link>
          <span className="menu-card__price">{ngn(price)}</span>
        </div>
        <p className="menu-card__ings">{item.ingredients.join(" · ")}</p>
        <div className="menu-card__foot">
          <SizeToggle size={size} onChange={setSize} />
          <button
            type="button"
            className="menu-card__add"
            aria-label={`Add ${item.name} ${size}ml to cart`}
            onClick={() =>
              addToCart({
                product_id: live?.id ?? `${item.id}-${size}`,
                ...(live?.id ? { variant_id: live.id } : {}),
                name: `${item.name} (${size}ml)`,
                unit_price_ngn: price,
              })
            }
          >
            Add
          </button>
        </div>
        {item.category !== "regular" && (
          <span
            className={`menu-card__tag menu-card__tag--${item.category} menu-card__tag--floating`}
          >
            {item.category === "special" ? "Special" : "Punch"}
          </span>
        )}
      </div>
    </article>
  );
}
