import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { cart as cartApi, useCart } from "../store/cart.js";
import { ngn } from "../lib/api.js";
import { BRAND } from "../data/menu.js";
import { Button, Eyebrow } from "../components/ui/index.js";

export function CartPage(): JSX.Element {
  // Re-fetch on mount so a direct visit or back-button hit shows fresh state.
  useEffect(() => {
    void cartApi.refresh().catch(() => undefined);
  }, []);

  const items = useCart((s) => s.items);
  const setQuantity = useCart((s) => s.setQuantity);
  const remove = useCart((s) => s.remove);
  const clear = useCart((s) => s.clear);
  const subtotal = useCart((s) => s.subtotal());
  const totalItems = useCart((s) => s.totalItems());

  if (items.length === 0) {
    return (
      <div className="ms-shell">
        <div className="ms-container">
          <CartHeader />
          <main className="ms-cart">
            <div className="ms-cart__empty">
              <Eyebrow>Your cart</Eyebrow>
              <h1 className="ms-section-title">Nothing in your basket yet.</h1>
              <p className="ms-section-sub">
                Pick a flavour from the menu and we'll keep it cold for you.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link to="/" className="btn btn--primary">
                  Browse the menu
                </Link>
                <a
                  href={`https://wa.me/${BRAND.whatsapp}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--ghost"
                >
                  Order on WhatsApp
                </a>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="ms-shell">
      <div className="ms-container">
        <CartHeader />
        <main className="ms-cart">
          <header style={{ marginBottom: 22 }}>
            <Eyebrow>Your basket</Eyebrow>
            <h1 className="ms-section-title">
              {totalItems} {totalItems === 1 ? "bottle" : "bottles"} chilling.
            </h1>
            <p className="ms-section-sub">
              Review your order, then we'll take your delivery details on the next step.
            </p>
          </header>

          <div className="ms-cart__grid">
            <section className="ms-cart__lines">
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                {items.map((item) => (
                  <li key={item.product_id} className="ms-cart__line">
                    <div className="ms-cart__line-head">
                      <div>
                        <div className="ms-cart__line-name">{item.name}</div>
                        <div className="ms-cart__line-unit">{ngn(item.unit_price_ngn)} per bottle</div>
                      </div>
                      <div className="ms-cart__line-total">
                        {ngn(item.unit_price_ngn * item.quantity)}
                      </div>
                    </div>

                    <div className="ms-cart__qty">
                      <button
                        type="button"
                        className="ms-cart__qty-btn"
                        onClick={() => setQuantity(item.product_id, item.quantity - 1)}
                        aria-label={`Decrease ${item.name}`}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        className="ms-cart__qty-input"
                        value={item.quantity}
                        min={0}
                        onChange={(e) => setQuantity(item.product_id, Number(e.target.value))}
                      />
                      <button
                        type="button"
                        className="ms-cart__qty-btn"
                        onClick={() => setQuantity(item.product_id, item.quantity + 1)}
                        aria-label={`Increase ${item.name}`}
                      >
                        +
                      </button>
                      <div style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="ms-cart__remove"
                        onClick={() => remove(item.product_id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
                <Link to="/" style={{ color: "var(--accent)", fontWeight: 600, fontSize: 14 }}>
                  ← Add another flavour
                </Link>
                <button
                  type="button"
                  className="ms-cart__clear"
                  onClick={() => {
                    if (window.confirm("Empty your basket?")) clear();
                  }}
                >
                  Clear basket
                </button>
              </div>
            </section>

            <aside className="ms-cart__summary">
              <h2 className="ms-cart__summary-title">Order summary</h2>
              <Row label={`Subtotal (${totalItems} ${totalItems === 1 ? "bottle" : "bottles"})`} value={ngn(subtotal)} />
              <Row label="Delivery" value="Calculated at checkout" muted />
              <div className="ms-cart__divider" />
              <Row label="Order total" value={ngn(subtotal)} emphasis />

              <Link to="/checkout" style={{ display: "block", marginTop: 16 }}>
                <Button variant="primary" className="ms-cart__cta">
                  Continue to checkout →
                </Button>
              </Link>
              <p className="ms-cart__fineprint">
                Cold-pressed, 48-hour shelf life. We deliver same-day within Lagos.
              </p>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

function CartHeader(): JSX.Element {
  return (
    <nav className="ms-nav">
      <Link to="/" className="ms-brand">
        <span className="ms-brand__logo">
          <img src="/assets/brand-logo.png" alt={BRAND.name} />
        </span>
      </Link>
      <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
        Your basket
      </span>
      <div />
    </nav>
  );
}

function Row({
  label,
  value,
  muted,
  emphasis,
}: {
  label: string;
  value: string;
  muted?: boolean;
  emphasis?: boolean;
}): JSX.Element {
  return (
    <div className="ms-cart__row">
      <span style={{ color: muted ? "var(--ink-soft)" : "var(--ink)" }}>{label}</span>
      <span
        className="tabular-nums"
        style={{
          fontWeight: emphasis ? 800 : 600,
          fontSize: emphasis ? 22 : 15,
          color: muted ? "var(--ink-soft)" : "var(--ink)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
