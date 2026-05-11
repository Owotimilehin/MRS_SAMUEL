import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { api, ngn } from "../lib/api.js";
import { useCart } from "../store/cart.js";

interface Product {
  id: string;
  name: string;
  slug: string;
  category: "regular" | "special" | "punch";
  ingredients: string[];
  price_ngn: number;
}

export function MenuPage(): JSX.Element {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [filter, setFilter] = useState<"all" | "regular" | "special" | "punch">("all");
  const cart = useCart();

  useEffect(() => {
    void api<{ data: Product[] }>("/catalog/products").then((r) => setProducts(r.data));
  }, []);

  const filtered = (products ?? []).filter((p) => filter === "all" || p.category === filter);
  const cartTotal = cart.subtotal();
  const cartCount = cart.totalItems();

  return (
    <div className="min-h-screen">
      <Nav cartCount={cartCount} cartTotal={cartTotal} />
      <Hero />

      <section className="py-12 px-6 max-w-7xl mx-auto">
        <div className="flex items-end justify-between mb-8 flex-wrap gap-4">
          <div>
            <div
              className="text-xs uppercase tracking-widest mb-2"
              style={{ color: "var(--ms-orange)" }}
            >
              The menu
            </div>
            <h2 className="font-display text-4xl font-bold">
              17 flavors. <span className="italic" style={{ color: "var(--ms-green-700)" }}>
                Cold-pressed today.
              </span>
            </h2>
          </div>
          <div className="flex gap-2">
            {(["all", "regular", "special", "punch"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className="px-4 py-2 rounded-full text-sm font-semibold capitalize"
                style={{
                  background: filter === c ? "var(--ms-ink)" : "transparent",
                  color: filter === c ? "white" : "var(--ms-ink-2)",
                  border: filter === c ? "1px solid var(--ms-ink)" : "1px solid var(--ms-border)",
                }}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {!products ? (
          <p style={{ color: "var(--ms-ink-3)" }}>Loading menu…</p>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {filtered.map((p) => (
              <article
                key={p.id}
                className="p-5 rounded-2xl transition hover:-translate-y-1"
                style={{
                  background: "white",
                  border: "1px solid var(--ms-border)",
                }}
              >
                <div
                  className="rounded-xl mb-4 aspect-square grid place-items-center text-5xl"
                  style={{
                    background:
                      p.category === "special"
                        ? "linear-gradient(135deg, var(--ms-pink), var(--ms-orange))"
                        : p.category === "punch"
                          ? "linear-gradient(135deg, var(--ms-yellow), var(--ms-orange))"
                          : "linear-gradient(135deg, var(--ms-orange), var(--ms-yellow))",
                  }}
                >
                  🥤
                </div>
                <div className="font-display text-lg font-bold mb-1">{p.name}</div>
                <div className="text-xs mb-3 line-clamp-2" style={{ color: "var(--ms-ink-3)" }}>
                  {p.ingredients.join(" · ")}
                </div>
                <div className="flex items-center justify-between">
                  <div className="font-display text-xl font-bold">{ngn(p.price_ngn)}</div>
                  <button
                    onClick={() =>
                      cart.add({
                        product_id: p.id,
                        name: p.name,
                        unit_price_ngn: p.price_ngn,
                      })
                    }
                    className="px-4 py-2 rounded-full text-white text-sm font-semibold"
                    style={{ background: "var(--ms-green-500)" }}
                  >
                    + Add
                  </button>
                </div>
                {p.category === "special" && (
                  <span
                    className="inline-block mt-2 text-xs font-bold px-2 py-0.5 rounded-full"
                    style={{ background: "var(--ms-pink)", color: "white" }}
                  >
                    Limited
                  </span>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {cartCount > 0 && (
        <Link
          to="/cart"
          className="fixed bottom-6 right-6 px-6 py-4 rounded-full text-white font-bold shadow-2xl"
          style={{ background: "var(--ms-ink)" }}
        >
          🛒 {cartCount} · {ngn(cartTotal)} →
        </Link>
      )}
    </div>
  );
}

function Nav({ cartCount, cartTotal }: { cartCount: number; cartTotal: number }) {
  return (
    <nav
      className="flex items-center px-6 py-4 sticky top-0 z-20"
      style={{ background: "var(--ms-bg)", borderBottom: "1px solid var(--ms-border)" }}
    >
      <Link to="/" className="font-display text-xl font-bold no-underline" style={{ color: "var(--ms-ink)" }}>
        SMUEL
      </Link>
      <div className="flex-1" />
      <Link
        to="/cart"
        className="text-sm font-semibold no-underline"
        style={{ color: "var(--ms-ink)" }}
      >
        🛒 Cart {cartCount > 0 && `· ${cartCount}`} {cartCount > 0 && `· ${ngn(cartTotal)}`}
      </Link>
    </nav>
  );
}

function Hero() {
  return (
    <section
      className="px-6 py-20"
      style={{
        background:
          "linear-gradient(135deg, rgba(78,168,58,0.15), rgba(255,196,52,0.12), rgba(240,138,26,0.08))",
      }}
    >
      <div className="max-w-7xl mx-auto">
        <div
          className="text-xs uppercase tracking-widest mb-4 font-semibold"
          style={{ color: "var(--ms-orange)" }}
        >
          Cold-pressed daily · Lagos
        </div>
        <h1 className="font-display text-6xl md:text-7xl font-bold leading-none mb-6">
          Good health,
          <br />
          <span className="italic" style={{ color: "var(--ms-green-700)" }}>
            bottled fresh.
          </span>
        </h1>
        <p className="text-lg max-w-xl" style={{ color: "var(--ms-ink-2)" }}>
          Seventeen flavors of cold-pressed fruit juice made every morning from
          market-fresh fruit. No added sugar. No preservatives.
        </p>
      </div>
    </section>
  );
}
