import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import {
  local,
  localAvailableForProduct,
  type ProductRow,
  type VariantRow,
  type PriceRow,
} from "../../db/local.js";
import { createLocalSale } from "../../sync/local-sale.js";
import { ngn } from "../../lib/format.js";

type Channel = "walkup" | "whatsapp" | "chowdeck_pickup";
type PaymentMethod = "cash" | "card" | "transfer";

interface CartLine {
  product_id: string;
  variant_id: string;
  size_ml: number;
  quantity: number;
  unit_price_ngn: number;
}

// A single sellable line on the till: one can size of one flavour, priced.
interface Sellable {
  product: ProductRow;
  variant: VariantRow;
  price: number;
}

const sizeLabel = (ml: number): string => (ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`);

export function SellPage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], [] as ProductRow[]);
  const variants = useLiveQuery(() => local.variants.toArray(), [], [] as VariantRow[]);
  const prices = useLiveQuery(() => local.prices.toArray(), [], [] as PriceRow[]);

  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [channel, setChannel] = useState<Channel>("walkup");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  // Optional customer — phone is the identity (server merges returning customers
  // by phone); name is just for readability. Both blank = anonymous walk-up.
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Price for an exact can size: most recent open price for that variant,
  // falling back to a product-level (variant-less) price for legacy rows.
  const priceForVariant = (productId: string, variantId: string): number => {
    const open = prices.filter((p) => !p.valid_to);
    const byNewest = (a: PriceRow, b: PriceRow): number =>
      a.valid_from > b.valid_from ? -1 : 1;
    const exact = open.filter((p) => p.variant_id === variantId).sort(byNewest);
    if (exact[0]) return exact[0].price_ngn;
    const fallback = open
      .filter((p) => p.product_id === productId && p.variant_id == null)
      .sort(byNewest);
    return fallback[0]?.price_ngn ?? 0;
  };

  // Expand the catalog into one sellable per (active flavour × active size).
  const sellables = useMemo<Sellable[]>(() => {
    const byProduct = new Map(products.map((p) => [p.id, p]));
    return variants
      .filter((v) => v.is_active)
      .map((v) => {
        const product = byProduct.get(v.product_id);
        if (!product || !product.is_active) return null;
        return { product, variant: v, price: priceForVariant(product.id, v.id) };
      })
      .filter((s): s is Sellable => s !== null)
      .sort(
        (a, b) =>
          a.product.name.localeCompare(b.product.name) || a.variant.size_ml - b.variant.size_ml,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, variants, prices]);

  const filtered = useMemo(() => {
    if (!search) return sellables;
    const q = search.toLowerCase();
    return sellables.filter(
      (s) => s.product.name.toLowerCase().includes(q) || s.product.slug.includes(q),
    );
  }, [sellables, search]);

  function addToCart(s: Sellable): void {
    setCart((c) => {
      const existing = c.find((l) => l.variant_id === s.variant.id);
      if (existing) {
        return c.map((l) =>
          l.variant_id === s.variant.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [
        ...c,
        {
          product_id: s.product.id,
          variant_id: s.variant.id,
          size_ml: s.variant.size_ml,
          quantity: 1,
          unit_price_ngn: s.price,
        },
      ];
    });
  }
  function updateQty(variantId: string, qty: number): void {
    setCart((c) =>
      qty <= 0
        ? c.filter((l) => l.variant_id !== variantId)
        : c.map((l) => (l.variant_id === variantId ? { ...l, quantity: qty } : l)),
    );
  }
  function removeLine(variantId: string): void {
    setCart((c) => c.filter((l) => l.variant_id !== variantId));
  }
  function clearCart(): void {
    setCart([]);
  }

  const total = cart.reduce((sum, l) => sum + l.quantity * l.unit_price_ngn, 0);

  async function checkout(): Promise<void> {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Pre-flight: branch stock is tracked per flavour (not per size), so sum
      // the quantities of every size of the same flavour before comparing.
      const wantByProduct = new Map<string, number>();
      for (const l of cart) {
        wantByProduct.set(l.product_id, (wantByProduct.get(l.product_id) ?? 0) + l.quantity);
      }
      for (const [productId, want] of wantByProduct) {
        const have = await localAvailableForProduct(branchId, productId);
        if (have < want) {
          const p = products.find((x) => x.id === productId);
          throw new Error(`Insufficient stock for ${p?.name ?? productId} (${have} available)`);
        }
      }
      const itemCount = cart.reduce((n, l) => n + l.quantity, 0);
      const trimmedPhone = customerPhone.trim();
      const trimmedName = customerName.trim();
      const sale = await createLocalSale({
        branchId,
        channel,
        items: cart,
        payment_method: paymentMethod,
        ...(trimmedPhone || trimmedName
          ? {
              customer: {
                ...(trimmedName ? { name: trimmedName } : {}),
                ...(trimmedPhone ? { phone: trimmedPhone } : {}),
              },
            }
          : {}),
      });
      setFlash(
        `Sale recorded ✓ · ${itemCount} ${itemCount === 1 ? "item" : "items"} · ${ngn(sale.subtotal)}`,
      );
      setCart([]);
      setCustomerPhone("");
      setCustomerName("");
      setTimeout(() => setFlash(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BranchShell branchId={branchId} title="Sell">
      {flash && (
        <div
          className="card"
          style={{
            background: "rgba(16,185,129,0.10)",
            borderColor: "rgba(16,185,129,0.25)",
            color: "#047857",
            marginBottom: 16,
          }}
        >
          {flash}
        </div>
      )}
      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 18 }}>
        <section>
          <input
            className="input"
            placeholder="Search products…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 14 }}
          />
          {filtered.length === 0 ? (
            <div className="empty">
              <div className="empty__title">No products in catalog</div>
              Open while online to sync products from the API.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
                gap: 12,
              }}
            >
              {filtered.map((s) => (
                <ProductTile
                  key={s.variant.id}
                  sellable={s}
                  branchId={branchId}
                  onPick={() => addToCart(s)}
                />
              ))}
            </div>
          )}
        </section>

        <aside
          className="card"
          style={{ position: "sticky", top: 96, alignSelf: "start" }}
        >
          <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 className="t-h2">Cart</h2>
            {cart.length > 0 && (
              <button
                type="button"
                onClick={clearCart}
                style={{ background: "transparent", border: 0, cursor: "pointer", fontSize: 13, color: "var(--ink-soft)" }}
              >
                Clear
              </button>
            )}
          </header>

          {cart.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>
              Tap a product to add it.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
              {cart.map((l) => {
                const p = products.find((x) => x.id === l.product_id);
                return (
                  <li
                    key={l.variant_id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 6,
                      padding: 10,
                      background: "var(--surface-soft)",
                      borderRadius: 12,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p?.name ?? l.product_id.slice(0, 8)}
                        <span style={{ color: "var(--ink-soft)", fontWeight: 500 }}>
                          {" · "}
                          {sizeLabel(l.size_ml)}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                        {ngn(l.unit_price_ngn)} × {l.quantity}
                      </div>
                    </div>
                    <div className="tabular-nums" style={{ fontWeight: 700, textAlign: "right" }}>
                      {ngn(l.unit_price_ngn * l.quantity)}
                    </div>
                    <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        style={{ width: 30, padding: 0, height: 28 }}
                        onClick={() => updateQty(l.variant_id, l.quantity - 1)}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        className="input"
                        style={{ width: 56, height: 28, textAlign: "center" }}
                        value={l.quantity}
                        onChange={(e) => updateQty(l.variant_id, Number(e.target.value))}
                      />
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        style={{ width: 30, padding: 0, height: 28 }}
                        onClick={() => updateQty(l.variant_id, l.quantity + 1)}
                      >
                        +
                      </button>
                      <div style={{ flex: 1 }} />
                      <button
                        type="button"
                        onClick={() => removeLine(l.variant_id)}
                        style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--ink-soft)", fontSize: 18 }}
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="field">
              <label className="field__label">Customer phone (optional)</label>
              <input
                className="input"
                inputMode="tel"
                autoComplete="off"
                placeholder="e.g. 0803…"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label">Customer name (optional)</label>
              <input
                className="input"
                autoComplete="off"
                placeholder="e.g. Bisi"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="sell-channel">Channel</label>
              <select
                id="sell-channel"
                className="select"
                value={channel}
                onChange={(e) => setChannel(e.target.value as Channel)}
              >
                <option value="walkup">Walk-up</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="chowdeck_pickup">Chowdeck pickup</option>
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="sell-payment">Payment</label>
              <select
                id="sell-payment"
                className="select"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              >
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="transfer">Transfer</option>
              </select>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                padding: "10px 0",
                borderTop: "1px solid var(--line)",
              }}
            >
              <span style={{ fontWeight: 600 }}>Total</span>
              <span className="tabular-nums" style={{ fontWeight: 800, fontSize: 22 }}>
                {ngn(total)}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--block btn--lg"
              disabled={submitting || cart.length === 0}
              onClick={() => void checkout()}
            >
              {submitting ? "Recording…" : `Charge ${ngn(total)}`}
            </button>
            <p style={{ fontSize: 11, color: "var(--ink-soft)", textAlign: "center", margin: 0 }}>
              Saved locally — syncs to the server when online.
            </p>
          </div>
        </aside>
      </div>
    </BranchShell>
  );
}

function ProductTile({
  sellable,
  branchId,
  onPick,
}: {
  sellable: Sellable;
  branchId: string;
  onPick: () => void;
}): JSX.Element {
  const { product, variant, price } = sellable;
  // Stock is tracked per flavour, not per size — every size of a flavour draws
  // from the same on-hand pool, so all its tiles show the same count.
  const available = useLiveQuery(
    () => localAvailableForProduct(branchId, product.id),
    [branchId, product.id],
    null as number | null,
  );
  const oos = available !== null && available <= 0;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={oos}
      className="card card--hoverable"
      style={{
        textAlign: "left",
        cursor: oos ? "not-allowed" : "pointer",
        opacity: oos ? 0.55 : 1,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        borderRadius: 14,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.25 }}>{product.name}</span>
        <span
          className="pill"
          style={{ flexShrink: 0, fontSize: 11, fontWeight: 700 }}
        >
          {sizeLabel(variant.size_ml)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
        {product.category}
        {available !== null && (
          <>
            {" · "}
            <span style={{ color: oos ? "var(--danger)" : "var(--ink-soft)" }}>
              {oos ? "Out of stock" : `${available} in stock`}
            </span>
          </>
        )}
      </div>
      <div className="text-grad tabular-nums" style={{ fontWeight: 800, fontSize: 18, marginTop: 4 }}>
        {ngn(price)}
      </div>
    </button>
  );
}
