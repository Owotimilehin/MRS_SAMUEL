import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { local, type ProductRow, localAvailableForProduct } from "../../db/local.js";
import { createLocalSale } from "../../sync/local-sale.js";
import { ngn } from "../../lib/format.js";

interface SellPageProps {
  branchId: string;
}

interface CartItem {
  productId: string;
  name: string;
  unitPriceNgn: number;
  quantity: number;
  available: number;
}

type PaymentMethod = "cash" | "card" | "transfer";

export function SellPage({ branchId }: SellPageProps): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), []);
  const prices = useLiveQuery(() => local.prices.toArray(), []);
  const [cart, setCart] = useState<Map<string, CartItem>>(new Map());
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [lastOrder, setLastOrder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Build a price index: latest valid_to=null per product.
  const currentPriceFor = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of prices ?? []) {
      if (p.valid_to === null) map.set(p.product_id, p.price_ngn);
    }
    return map;
  }, [prices]);

  // Refresh "available" for cart items whenever the cart changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = new Map(cart);
      for (const item of next.values()) {
        const avail = await localAvailableForProduct(branchId, item.productId);
        if (!cancelled) item.available = avail;
      }
      if (!cancelled) setCart(next);
    })();
    return () => {
      cancelled = true;
    };
    // We don't depend on cart contents directly here to avoid render loop;
    // we recompute available on add/remove via the addToCart handler instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const subtotal = Array.from(cart.values()).reduce(
    (sum, c) => sum + c.unitPriceNgn * c.quantity,
    0,
  );
  const itemCount = Array.from(cart.values()).reduce((sum, c) => sum + c.quantity, 0);

  async function addToCart(product: ProductRow): Promise<void> {
    const price = currentPriceFor.get(product.id);
    if (!price) {
      setError(`No price for ${product.name}`);
      return;
    }
    const avail = await localAvailableForProduct(branchId, product.id);
    const existing = cart.get(product.id);
    const newQty = (existing?.quantity ?? 0) + 1;
    if (avail < newQty) {
      setError(`${product.name}: only ${avail} available`);
      return;
    }
    setError(null);
    const next = new Map(cart);
    next.set(product.id, {
      productId: product.id,
      name: product.name,
      unitPriceNgn: price,
      quantity: newQty,
      available: avail,
    });
    setCart(next);
  }

  function updateQuantity(productId: string, delta: number): void {
    const next = new Map(cart);
    const item = next.get(productId);
    if (!item) return;
    const newQty = item.quantity + delta;
    if (newQty <= 0) {
      next.delete(productId);
    } else if (newQty > item.available) {
      setError(`Only ${item.available} available`);
      return;
    } else {
      next.set(productId, { ...item, quantity: newQty });
    }
    setError(null);
    setCart(next);
  }

  async function charge(): Promise<void> {
    if (cart.size === 0) return;
    try {
      const items = Array.from(cart.values()).map((c) => ({
        product_id: c.productId,
        quantity: c.quantity,
        unit_price_ngn: c.unitPriceNgn,
      }));
      const result = await createLocalSale({
        branchId,
        items,
        payment_method: payment,
        channel: "walkup",
      });
      setLastOrder(result.orderNumber);
      setCart(new Map());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const sortedProducts = useMemo(() => {
    return (products ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  return (
    <BranchShell branchId={branchId} title="Sell">
      <div className="grid gap-6" style={{ gridTemplateColumns: "1fr 380px" }}>
        {/* Product grid */}
        <div>
          {lastOrder && (
            <div
              className="mb-4 p-3 rounded-md text-sm"
              style={{ background: "var(--ms-green-100)", color: "var(--ms-green-900)" }}
            >
              ✓ Sale recorded ({lastOrder}). It'll sync to the server when online.
            </div>
          )}
          {error && (
            <div
              className="mb-4 p-3 rounded-md text-sm"
              style={{ background: "#ffe1de", color: "#8a2018" }}
            >
              {error}
            </div>
          )}

          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
          >
            {sortedProducts.map((p) => {
              const price = currentPriceFor.get(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => void addToCart(p)}
                  disabled={!price}
                  className="text-left p-4 rounded-xl transition disabled:opacity-50"
                  style={{
                    background: "var(--ms-surface)",
                    border: "1px solid var(--ms-border)",
                  }}
                >
                  <div className="font-display text-base font-bold mb-1">{p.name}</div>
                  <div
                    className="text-xs mb-3 line-clamp-2"
                    style={{ color: "var(--ms-ink-3)" }}
                  >
                    {p.ingredients.slice(0, 3).join(" · ")}
                  </div>
                  <div className="font-display text-lg font-bold">
                    {price ? ngn(price) : "—"}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Cart */}
        <aside
          className="rounded-xl flex flex-col"
          style={{
            background: "var(--ms-surface)",
            border: "1px solid var(--ms-border)",
            position: "sticky",
            top: 80,
            alignSelf: "start",
          }}
        >
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{ borderBottom: "1px solid var(--ms-divider)" }}
          >
            <h2 className="font-display text-lg font-bold">
              Order {itemCount > 0 ? `· ${itemCount}` : ""}
            </h2>
            {cart.size > 0 && (
              <button
                onClick={() => setCart(new Map())}
                className="text-xs"
                style={{ color: "var(--ms-ink-3)" }}
              >
                Clear
              </button>
            )}
          </div>

          <div className="px-4 py-3 flex-1 overflow-y-auto">
            {cart.size === 0 ? (
              <p
                className="text-sm text-center py-8"
                style={{ color: "var(--ms-ink-3)" }}
              >
                Tap a juice to start the order.
              </p>
            ) : (
              Array.from(cart.values()).map((item) => (
                <div
                  key={item.productId}
                  className="flex items-center gap-2 py-2"
                  style={{ borderBottom: "1px solid var(--ms-divider)" }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">{item.name}</div>
                    <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
                      {ngn(item.unitPriceNgn)} each
                    </div>
                  </div>
                  <div
                    className="flex items-center gap-2 rounded-full px-1"
                    style={{ background: "var(--ms-surface-alt)" }}
                  >
                    <button
                      onClick={() => updateQuantity(item.productId, -1)}
                      className="w-7 h-7 grid place-items-center rounded-full bg-white"
                    >
                      −
                    </button>
                    <span className="w-5 text-center text-sm font-semibold tabular-nums">
                      {item.quantity}
                    </span>
                    <button
                      onClick={() => updateQuantity(item.productId, 1)}
                      className="w-7 h-7 grid place-items-center rounded-full bg-white"
                    >
                      +
                    </button>
                  </div>
                  <div className="w-20 text-right text-sm font-semibold tabular-nums">
                    {ngn(item.unitPriceNgn * item.quantity)}
                  </div>
                </div>
              ))
            )}
          </div>

          <div
            className="px-4 py-3"
            style={{
              background: "var(--ms-surface-alt)",
              borderTop: "1px solid var(--ms-divider)",
            }}
          >
            <div className="flex justify-between text-sm mb-1">
              <span style={{ color: "var(--ms-ink-3)" }}>Subtotal</span>
              <span className="tabular-nums">{ngn(subtotal)}</span>
            </div>
            <div className="flex justify-between font-display text-2xl font-bold mt-2 pt-2 border-t border-dashed">
              <span>Total</span>
              <span className="tabular-nums">{ngn(subtotal)}</span>
            </div>
          </div>

          <div
            className="grid grid-cols-3 gap-1.5 px-4 py-3"
            style={{ borderTop: "1px solid var(--ms-divider)" }}
          >
            {(["cash", "card", "transfer"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setPayment(m)}
                className="p-2 rounded-md text-sm font-semibold capitalize"
                style={{
                  background:
                    payment === m ? "var(--ms-green-100)" : "var(--ms-surface-alt)",
                  color:
                    payment === m ? "var(--ms-green-900)" : "var(--ms-ink-2)",
                  border:
                    payment === m
                      ? "1px solid var(--ms-green-500)"
                      : "1px solid var(--ms-border)",
                }}
              >
                {m === "cash" ? "💵" : m === "card" ? "💳" : "📱"} {m}
              </button>
            ))}
          </div>

          <div className="px-4 py-3">
            <button
              onClick={() => void charge()}
              disabled={cart.size === 0}
              className="w-full py-4 rounded-full text-white font-bold disabled:opacity-50"
              style={{ background: "var(--ms-green-500)" }}
            >
              Charge {ngn(subtotal)} →
            </button>
          </div>
        </aside>
      </div>
    </BranchShell>
  );
}
