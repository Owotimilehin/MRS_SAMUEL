import { useEffect, useMemo, useState } from "react";
import {
  bottleFor,
  findMenuItemById,
  FRUIT_NUTRITION,
  ingredientToFruit,
  priceFor,
  type Size,
} from "../data/menu.js";
import { useCart } from "../store/cart.js";
import { useCatalog } from "../store/catalog.js";
import { ngn } from "../lib/api.js";
import { SiteLayout } from "../components/SiteLayout.js";
import { Button, Eyebrow, SizeToggle } from "../components/ui/index.js";

export function ProductDetailPage({ productId }: { productId: string }): JSX.Element {
  const item = findMenuItemById(productId);
  const loadCatalog = useCatalog((s) => s.load);
  const variantFor = useCatalog((s) => s.variantFor);
  const addToCart = useCart((s) => s.add);
  const [size, setSize] = useState<Size>(650);
  const [qty, setQty] = useState(1);
  const [justAdded, setJustAdded] = useState(false);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const benefits = useMemo(() => {
    if (!item) return [];
    const fruits = item.ingredients
      .map(ingredientToFruit)
      .filter((f): f is NonNullable<typeof f> => Boolean(f));
    const all = fruits.flatMap((f) => FRUIT_NUTRITION[f]?.benefits ?? []);
    return Array.from(new Set(all)).slice(0, 4);
  }, [item]);

  if (!item) {
    return (
      <SiteLayout>
        <main className="ms-pdp ms-container">
          <Eyebrow>Product</Eyebrow>
          <h1 className="ms-section-title">We couldn't find that juice.</h1>
          <a href="/#menu" className="btn btn--primary">
            Back to the menu
          </a>
        </main>
      </SiteLayout>
    );
  }

  const live = variantFor(item.name, size);
  const unitPrice = live?.price_ngn ?? priceFor(item, size);
  const total = unitPrice * qty;

  function handleAdd(): void {
    if (!item) return;
    for (let i = 0; i < qty; i++) {
      addToCart({
        product_id: live?.id ?? `${item.id}-${size}`,
        ...(live?.id ? { variant_id: live.id } : {}),
        name: `${item.name} (${size}ml)`,
        unit_price_ngn: unitPrice,
      });
    }
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1500);
  }

  return (
    <SiteLayout
      meta={{
        title: `${item.name} · Mrs. Samuel`,
        description: item.ingredients.join(", "),
      }}
    >
      <main className="ms-pdp ms-container">
        <nav className="ms-pdp__crumbs">
          <a href="/#menu">← All juices</a>
        </nav>

        <div className="ms-pdp__grid">
          <div className="ms-pdp__media">
            <img
              src={bottleFor(item)}
              alt={item.name}
              onError={(e) => {
                const img = e.currentTarget;
                if (img.src.endsWith("/assets/bottle-hero.png")) return;
                img.src = "/assets/bottle-hero.png";
              }}
            />
          </div>

          <div className="ms-pdp__body">
            {item.category !== "regular" && (
              <span className={`menu-card__tag menu-card__tag--${item.category}`}>
                {item.category === "special" ? "Special" : "Punch"}
              </span>
            )}
            <Eyebrow>Cold-pressed juice</Eyebrow>
            <h1 className="ms-pdp__name">{item.name}</h1>
            <div className="ms-pdp__price tabular-nums">{ngn(unitPrice)}</div>

            <h2 className="ms-pdp__sub">Ingredients</h2>
            <div className="ms-pdp__ings">
              {item.ingredients.map((ing) => (
                <span key={ing} className="ms-pdp__chip">
                  {ing}
                </span>
              ))}
            </div>

            {benefits.length > 0 && (
              <>
                <h2 className="ms-pdp__sub">What it does</h2>
                <ul className="ms-pdp__benefits">
                  {benefits.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </>
            )}

            <h2 className="ms-pdp__sub">Size</h2>
            <SizeToggle size={size} onChange={setSize} />

            <h2 className="ms-pdp__sub">Quantity</h2>
            <div className="ms-pdp__qty">
              <button
                type="button"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                aria-label="Decrease"
              >
                −
              </button>
              <span>{qty}</span>
              <button
                type="button"
                onClick={() => setQty((q) => q + 1)}
                aria-label="Increase"
              >
                +
              </button>
            </div>

            <Button
              variant="primary"
              onClick={handleAdd}
              style={{ marginTop: 22, width: "100%", justifyContent: "center" }}
            >
              {justAdded ? "✓ Added" : `Add to cart · ${ngn(total)}`}
            </Button>
          </div>
        </div>
      </main>
    </SiteLayout>
  );
}
