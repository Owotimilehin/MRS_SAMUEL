import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import {
  local,
  localAvailableForProduct,
  localAvailableForVariant,
  type ProductRow,
  type VariantRow,
  type PriceRow,
} from "../../db/local.js";
import { createLocalSale } from "../../sync/local-sale.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { Modal } from "../../components/Modal.js";
import { SaleSuccessModal } from "../../components/SaleSuccessModal.js";
import { useAuthUser } from "../../lib/auth.js";
import { buildReceiptFromCart, type ReceiptData } from "../../lib/receipt-data.js";
import { getReceiptStyle } from "../../lib/receipt-settings.js";
import { getFlavourVisual } from "../../lib/flavour-visuals.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";

interface BagMaterial {
  id: string;
  name: string;
  kind: "bag" | "straw";
  balance: number;
}

interface BagStockRow {
  material_id: string;
  name: string;
  kind: "bag" | "straw";
  balance: number;
}

type Channel = "walkup" | "whatsapp" | "chowdeck_pickup";
type PaymentMethod = "cash" | "card" | "transfer";

interface CartLine {
  product_id: string;
  variant_id: string;
  size_ml: number;
  quantity: number;
  unit_price_ngn: number;
  // This size is sold as a made-to-order preorder: payment is taken now, stock
  // is not checked or consumed, and the order waits for manual fulfilment.
  is_preorder: boolean;
}

// A single sellable line on the till: one can size of one flavour, priced.
interface Sellable {
  product: ProductRow;
  variant: VariantRow;
  price: number;
}

// One flavour grouping its sellable sizes — the unit the POS grid now shows.
interface Flavour {
  product: ProductRow;
  sizes: Sellable[];
}

const sizeLabel = (ml: number): string => (ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`);

export function SellPage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], [] as ProductRow[]);
  const variants = useLiveQuery(() => local.variants.toArray(), [], [] as VariantRow[]);
  const prices = useLiveQuery(() => local.prices.toArray(), [], [] as PriceRow[]);

  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [channel, setChannel] = useState<Channel>("walkup");
  // Payment is always taken by bank transfer — the cashier no longer picks it.
  const paymentMethod: PaymentMethod = "transfer";
  // Optional customer — phone is the identity (server merges returning customers
  // by phone); name is just for readability. Both blank = anonymous walk-up.
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Target fulfilment day, required when the cart is a preorder.
  const [fulfillBy, setFulfillBy] = useState("");
  // Order-level preorder choice. The cashier flips this in the cashout section
  // to take the whole order as a made-to-order preorder. A 330ml (preorder_only)
  // size in the cart forces it on — you can't complete that as an instant sale.
  const [preorderChoice, setPreorderChoice] = useState(false);

  // The just-completed sale, surfaced as a success modal with a Print option.
  const [successSale, setSuccessSale] = useState<{ receipt: ReceiptData; itemCount: number } | null>(
    null,
  );
  // Who is serving (for "Served by" on the receipt). admin_user has no name
  // field yet, so fall back to the email prefix then the role.
  const authUser = useAuthUser();
  const servedBy = (authUser.email.split("@")[0] || authUser.role).replace(/[._]/g, " ");
  // Stock-consuming sales need pos.sell (owner + branch_staff). Manager/admin
  // have only pos.preorder — they can take orders but never draw down stock.
  const canSellStock = authUser.capabilities.includes("pos.sell");
  const canPreorder = authUser.capabilities.includes("pos.preorder");
  // Is there an open shift on this device? null = still loading (no flash).
  // The gate is UNIVERSAL: all roles (owner included) must have an open shift
  // before the till accepts sales.
  const [hasShift, setHasShift] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hasOpenShift } = await import("../../sync/local-shift-open.js");
      const v = await hasOpenShift(branchId);
      if (!cancelled) setHasShift(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);
  // Defensive: a user with neither selling capability can't check out at all.
  const checkoutDisabled = !canSellStock && !canPreorder;
  // Branch header for the receipt, fetched best-effort (works online; offline we
  // still print with just the branch id-derived fallbacks).
  const [branchInfo, setBranchInfo] = useState<{ name: string; address: string | null; phone: string | null }>({
    name: "Mrs. Samuel",
    address: null,
    phone: null,
  });
  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ data: { name: string; address: string | null; phone: string | null } }>(
          `/branches/${branchId}`,
        );
        setBranchInfo({ name: res.data.name, address: res.data.address, phone: res.data.phone });
      } catch {
        /* offline or no access — keep fallback header */
      }
    })();
  }, [branchId]);

  // Bags + straws are tracked-only POS consumables. Optional: the cashier adds a
  // count only when handing them out; leaving them at zero is always fine.
  const [bagMaterials, setBagMaterials] = useState<BagMaterial[]>([]);
  const [strawMaterials, setStrawMaterials] = useState<BagMaterial[]>([]);
  const [bagCart, setBagCart] = useState<Record<string, number>>({});
  const [strawCart, setStrawCart] = useState<Record<string, number>>({});
  const [bagsSet, setBagsSet] = useState(false);
  const [strawsSet, setStrawsSet] = useState(false);
  // Bags + straws are optional. Many customers buy without either, so a sale can
  // always complete with zero of each — the empty carts default to zero and
  // produce no packaging lines. Counts are only added when handed out.
  async function loadBags(): Promise<void> {
    try {
      const res = await api<{ data: BagStockRow[] }>(`/branches/${branchId}/sales/bags`);
      const rows = res.data.map((m) => ({ id: m.material_id, name: m.name, kind: m.kind, balance: m.balance }));
      setBagMaterials(rows.filter((m) => m.kind === "bag"));
      setStrawMaterials(rows.filter((m) => m.kind === "straw"));
    } catch {
      setBagMaterials([]); // offline or no access — consumable pickers stay hidden
      setStrawMaterials([]);
    }
  }
  useEffect(() => {
    void loadBags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);
  function setBagQty(id: string, qty: number): void {
    setBagsSet(true);
    setBagCart((b) => {
      const next = { ...b };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
  }
  function setStrawQty(id: string, qty: number): void {
    setStrawsSet(true);
    setStrawCart((b) => {
      const next = { ...b };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
  }

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

  // Collapse sellables into one entry per flavour, each carrying its sizes
  // (sorted small→large, the way priceForVariant already ordered them).
  const flavours = useMemo<Flavour[]>(() => {
    const byProduct = new Map<string, Flavour>();
    for (const s of sellables) {
      const existing = byProduct.get(s.product.id);
      if (existing) existing.sizes.push(s);
      else byProduct.set(s.product.id, { product: s.product, sizes: [s] });
    }
    return [...byProduct.values()];
  }, [sellables]);

  const filtered = useMemo(() => {
    if (!search) return flavours;
    const q = search.toLowerCase();
    return flavours.filter(
      (f) => f.product.name.toLowerCase().includes(q) || f.product.slug.includes(q),
    );
  }, [flavours, search]);

  // Flavour whose size picker is open (null = no modal).
  const [picking, setPicking] = useState<Flavour | null>(null);

  // Pick a flavour: single-size flavours skip straight to the cart; multi-size
  // flavours open the size picker so the cashier chooses the can.
  function pickFlavour(f: Flavour): void {
    if (f.sizes.length === 1) addToCart(f.sizes[0]!);
    else setPicking(f);
  }

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
          is_preorder: false,
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

  // Live per-variant availability for everything in the cart, so we can tell
  // when a line can't be covered from stock and the order must become a preorder.
  const cartVariantIds = cart.map((l) => l.variant_id).join(",");
  const availByVariant = useLiveQuery(
    async () => {
      const entries = await Promise.all(
        cart.map(
          async (l) =>
            [l.variant_id, await localAvailableForVariant(branchId, l.product_id, l.variant_id)] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
    [branchId, cartVariantIds],
    {} as Record<string, number>,
  );

  // A line the branch can't cover from stock forces the whole ticket to a
  // preorder (made to order — paid now, fulfilled later). The cashier can also
  // opt any in-stock order in via the cashout toggle. preorder_only is no longer
  // a till trigger: an in-stock 330ml sells instantly (see sales.ts).
  // Managers/admins have no pos.sell — every order they place is a preorder
  // (no stock consumed), regardless of availability. Otherwise a line the branch
  // can't cover from stock forces the whole ticket to a preorder.
  const forcedPreorder =
    !canSellStock || cart.some((l) => (availByVariant[l.variant_id] ?? Infinity) < l.quantity);
  const orderIsPreorder = forcedPreorder || preorderChoice;

  async function checkout(): Promise<void> {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // The whole order is a preorder when a line can't be covered from stock
      // (shortfall) OR the cashier opted in. Payment is taken now, no stock is
      // reserved or consumed, and the order waits in the Preorders queue for
      // manual fulfilment.
      // A preorder must be registered to a fulfilment day — that's when staff
      // make it, fulfil it from the queue, and deduct stock.
      if (orderIsPreorder && !fulfillBy) {
        throw new Error("Pick a delivery date for this preorder.");
      }
      // Pre-flight per size: each cart line is one (flavour × can size); check
      // that exact variant's availability (size-tagged stock + the flavour's
      // untyped pool). Selling a 650ml is blocked when only 330ml is on hand.
      // Skipped entirely for a preorder — there's nothing to hand over now.
      if (!orderIsPreorder) {
        for (const l of cart) {
          const have = await localAvailableForVariant(branchId, l.product_id, l.variant_id);
          if (have < l.quantity) {
            const p = products.find((x) => x.id === l.product_id);
            throw new Error(
              `Insufficient stock for ${p?.name ?? l.product_id} ${sizeLabel(l.size_ml)} (${have} available)`,
            );
          }
        }
      }
      const itemCount = cart.reduce((n, l) => n + l.quantity, 0);
      const trimmedPhone = customerPhone.trim();
      const trimmedName = customerName.trim();
      const bagLines = Object.entries(bagCart).map(([packaging_material_id, quantity]) => ({
        packaging_material_id,
        quantity,
      }));
      const strawLines = Object.entries(strawCart).map(([packaging_material_id, quantity]) => ({
        packaging_material_id,
        quantity,
      }));
      const packagingLines = [...bagLines, ...strawLines];
      const sale = await createLocalSale({
        branchId,
        channel,
        items: cart,
        payment_method: paymentMethod,
        ...(orderIsPreorder
          ? { is_preorder: true, fulfill_by: new Date(`${fulfillBy}T12:00:00`).toISOString() }
          : {}),
        ...(packagingLines.length > 0 ? { packaging: packagingLines } : {}),
        ...(trimmedPhone || trimmedName
          ? {
              customer: {
                ...(trimmedName ? { name: trimmedName } : {}),
                ...(trimmedPhone ? { phone: trimmedPhone } : {}),
              },
            }
          : {}),
      });
      // Build the receipt from the live cart BEFORE we clear it, then surface a
      // success modal with a Print option (replaces the old green flash banner).
      const receipt = buildReceiptFromCart({
        style: getReceiptStyle(),
        receiptNo: sale.orderNumber,
        whenIso: new Date().toISOString(),
        branch: branchInfo,
        servedBy,
        channel,
        payment: paymentMethod,
        items: cart.map((l) => ({
          name: products.find((p) => p.id === l.product_id)?.name ?? "Item",
          sizeMl: l.size_ml,
          qty: l.quantity,
          unitNgn: l.unit_price_ngn,
        })),
        ...(orderIsPreorder
          ? { isPreorder: true, fulfilIso: new Date(`${fulfillBy}T12:00:00`).toISOString() }
          : {}),
      });
      setSuccessSale({ receipt, itemCount });
      setCart([]);
      setBagCart({});
      setStrawCart({});
      setBagsSet(false);
      setStrawsSet(false);
      setFulfillBy("");
      setPreorderChoice(false);
      setCustomerPhone("");
      setCustomerName("");
      // Optimistically reflect the bags just handed out. The server decrements
      // branch bag stock when this queued sale syncs (at /pay), so refetching
      // now would read the pre-sale balance and snap the count back to the
      // transferred amount. Subtract locally instead; the next full load (on
      // remount) reconciles with the server. Preorders defer the hand-over, so
      // skip them — the server doesn't decrement their bags until fulfilment.
      if (!orderIsPreorder && bagLines.length > 0) {
        setBagMaterials((prev) =>
          prev.map((m) => {
            const sold = bagLines.find((b) => b.packaging_material_id === m.id)?.quantity ?? 0;
            return sold > 0 ? { ...m, balance: m.balance - sold } : m;
          }),
        );
      }
      if (!orderIsPreorder && strawLines.length > 0) {
        setStrawMaterials((prev) =>
          prev.map((m) => {
            const sold = strawLines.find((s) => s.packaging_material_id === m.id)?.quantity ?? 0;
            return sold > 0 ? { ...m, balance: m.balance - sold } : m;
          }),
        );
      }
      setTimeout(() => setFlash(null), 4000);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  function ConsumableSection(props: {
    title: string;
    emoji: string;
    materials: BagMaterial[];
    cart: Record<string, number>;
    setQty: (id: string, qty: number) => void;
    isSet: boolean;
    markNone: () => void;
  }): JSX.Element {
    const { title, emoji, materials, cart, setQty, isSet, markNone } = props;
    return (
      <div className="card card--soft" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <strong style={{ fontSize: 13 }}>{title}</strong>
          <span style={{ fontSize: 11, color: isSet ? "var(--success)" : "var(--ink-soft)" }}>
            {isSet ? "✓ set" : "optional · leave at 0 if none"}
          </span>
        </div>
        {materials.map((m) => {
          const qty = cart[m.id] ?? 0;
          const remaining = m.balance - qty;
          const low = remaining <= 0;
          return (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {emoji} {m.name}
                <span className="tabular-nums" style={{ marginLeft: 6, fontSize: 12, color: low ? "var(--danger)" : "var(--ink-soft)" }}>
                  {remaining} left
                </span>
              </span>
              <button type="button" className="btn btn--subtle btn--sm" style={{ width: 28, padding: 0, height: 26 }} onClick={() => setQty(m.id, qty - 1)}>−</button>
              <span className="tabular-nums" style={{ width: 22, textAlign: "center" }}>{qty}</span>
              <button type="button" className="btn btn--subtle btn--sm" style={{ width: 28, padding: 0, height: 26 }} onClick={() => setQty(m.id, qty + 1)}>+</button>
            </div>
          );
        })}
        <button type="button" className="btn btn--subtle btn--sm" onClick={markNone} disabled={isSet}>
          None (0)
        </button>
        <span className="field__hint">Counts down as you add. Not added to the total; may go below zero.</span>
      </div>
    );
  }

  // Universal shift gate — show "open a shift" panel while loading (null) or
  // when no open shift exists (false). Checkout is also disabled within the full
  // page when hasShift===false so there's no race between the gate render and
  // a fast user tapping the checkout button.
  if (hasShift !== true) {
    return (
      <BranchShell branchId={branchId} title="Sell">
        <section className="card" style={{ textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🌅</div>
          <h2 className="t-h2">
            {hasShift === null ? "Loading…" : "Open a shift to start selling"}
          </h2>
          <p style={{ color: "var(--ink-soft)", margin: "8px 0 20px" }}>
            {hasShift === null
              ? "Checking shift status…"
              : "Count the opening stock to unlock the till for everyone."}
          </p>
          {hasShift === false && (
            <a className="btn btn--primary btn--lg" href="/branch/shift-start">
              Count opening stock
            </a>
          )}
        </section>
      </BranchShell>
    );
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

      <div className="l-split l-split--pos">
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
              {filtered.map((f) => (
                <FlavourTile
                  key={f.product.id}
                  flavour={f}
                  branchId={branchId}
                  onPick={() => pickFlavour(f)}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="card pos-cart">
          <header className="till-cart__head">
            <span className="till-cart__count">
              <b>Cart</b>
              {cart.length > 0 && (
                <span className="till-cart__pill">{cart.reduce((n, l) => n + l.quantity, 0)} items</span>
              )}
            </span>
            {cart.length > 0 && (
              <button type="button" className="till-cart__clear" onClick={clearCart}>
                Clear
              </button>
            )}
          </header>

          {cart.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              Tap a flavour to add it to the cart.
            </div>
          ) : (
            <ul className="till-lines">
              {cart.map((l) => {
                const p = products.find((x) => x.id === l.product_id);
                const vis = getFlavourVisual({ slug: p?.slug, image_url: p?.image_url });
                return (
                  <li key={l.variant_id} className="till-line" style={{ ["--fl-accent" as string]: vis.accent } as React.CSSProperties}>
                    <FlavourMedia className="till-line__media" size="chip" product={{ slug: p?.slug, image_url: p?.image_url }} />
                    <div style={{ minWidth: 0 }}>
                      <div className="till-line__name">
                        {p?.name ?? l.product_id.slice(0, 8)}
                        <span className="sz"> · {sizeLabel(l.size_ml)}</span>
                      </div>
                      <div className="till-line__unit">{ngn(l.unit_price_ngn)} each</div>
                    </div>
                    <div className="till-line__total tabular-nums">{ngn(l.unit_price_ngn * l.quantity)}</div>
                    <div className="till-line__controls">
                      <div className="qty-step">
                        <button type="button" aria-label="Decrease" onClick={() => updateQty(l.variant_id, l.quantity - 1)}>−</button>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={l.quantity}
                          onChange={(e) => updateQty(l.variant_id, Number(e.target.value))}
                          aria-label="Quantity"
                        />
                        <button type="button" aria-label="Increase" onClick={() => updateQty(l.variant_id, l.quantity + 1)}>+</button>
                      </div>
                      <button type="button" className="till-line__rm" onClick={() => removeLine(l.variant_id)} aria-label="Remove">×</button>
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
            {/* Order-level preorder. A 330ml in the cart forces it on. */}
            <div
              className="card card--soft"
              style={{
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                borderColor: orderIsPreorder ? "rgba(245,158,11,0.45)" : "var(--line)",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: forcedPreorder ? "not-allowed" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={orderIsPreorder}
                  disabled={forcedPreorder}
                  onChange={(e) => setPreorderChoice(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: "var(--accent, #d97706)" }}
                />
                <span style={{ fontWeight: 700, fontSize: 14 }}>📅 Preorder — made to order</span>
              </label>
              {forcedPreorder && (
                <span className="field__hint">
                  An item in the cart is out of stock — this order must be taken as a preorder.
                </span>
              )}
              {orderIsPreorder && (
                <>
                  <div className="field">
                    <label className="field__label">Delivery date *</label>
                    <input
                      className="input"
                      type="date"
                      value={fulfillBy}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setFulfillBy(e.target.value)}
                    />
                  </div>
                  <span className="field__hint">
                    Paid now, made to order. No stock leaves the branch — it waits in{" "}
                    <strong>Preorders</strong> and is deducted when you fulfil it on this day.
                  </span>
                </>
              )}
            </div>
            {bagMaterials.length > 0 && (
              <ConsumableSection
                title="Bags on hand" emoji="🛍" materials={bagMaterials}
                cart={bagCart} setQty={setBagQty} isSet={bagsSet}
                markNone={() => setBagsSet(true)}
              />
            )}
            {strawMaterials.length > 0 && (
              <ConsumableSection
                title="Straws on hand" emoji="🥤" materials={strawMaterials}
                cart={strawCart} setQty={setStrawQty} isSet={strawsSet}
                markNone={() => setStrawsSet(true)}
              />
            )}
            <div className="till-total">
              <span className="till-total__label">{orderIsPreorder ? "Preorder total" : "Total"}</span>
              <span className="till-total__value tabular-nums">{ngn(total)}</span>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--block btn--cta"
              disabled={submitting || cart.length === 0 || checkoutDisabled}
              onClick={() => void checkout()}
            >
              {submitting
                ? "Recording…"
                : orderIsPreorder
                  ? `Take preorder · ${ngn(total)}`
                  : `Charge ${ngn(total)}`}
            </button>
            <p style={{ fontSize: 11, color: "var(--ink-soft)", textAlign: "center", margin: 0 }}>
              Saved locally — syncs to the server when online.
            </p>
          </div>
        </aside>
      </div>

      {picking && (
        <SizePicker
          flavour={picking}
          branchId={branchId}
          onPick={(s) => {
            addToCart(s);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {successSale && (
        <SaleSuccessModal
          receipt={successSale.receipt}
          itemCount={successSale.itemCount}
          onNewSale={() => setSuccessSale(null)}
        />
      )}
    </BranchShell>
  );
}

// Size picker — lists every can size of the chosen flavour with its price so the
// cashier taps the exact variant to add. Stock is per-flavour, shown once up top.
function SizePicker({
  flavour,
  branchId,
  onPick,
  onClose,
}: {
  flavour: Flavour;
  branchId: string;
  onPick: (s: Sellable) => void;
  onClose: () => void;
}): JSX.Element {
  const { product, sizes } = flavour;
  // Per-size availability: each can size has its own on-hand count now.
  const availBySize = useLiveQuery(
    async () => {
      const entries = await Promise.all(
        sizes.map(
          async (s) =>
            [s.variant.id, await localAvailableForVariant(branchId, product.id, s.variant.id)] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
    [branchId, product.id, sizes.map((s) => s.variant.id).join(",")],
    null as Record<string, number> | null,
  );
  return (
    <Modal title={product.name} onClose={onClose} maxWidth={420}>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 12 }}>
        Choose a size — stock is shown per size
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sizes.map((s) => {
          const avail = availBySize?.[s.variant.id] ?? null;
          // A preorder size is always made-to-order — never blocked on stock.
          const isPreorder = s.variant.preorder_only ?? false;
          const sizeOos = !isPreorder && avail !== null && avail <= 0;
          // Every size stays tappable: an out-of-stock can can still be added
          // and taken as a preorder from the cashout section.
          const statusText = isPreorder
            ? "Preorder · made to order"
            : avail === null
              ? ""
              : sizeOos
                ? "out of stock · preorder"
                : `${avail} left`;
          return (
            <button
              key={s.variant.id}
              type="button"
              className="card card--hoverable"
              onClick={() => onPick(s)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "12px 14px",
                borderRadius: 12,
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 15 }}>
                {sizeLabel(s.variant.size_ml)}
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 12,
                    fontWeight: 500,
                    color: isPreorder
                      ? "var(--warning, #d97706)"
                      : sizeOos
                        ? "var(--danger)"
                        : "var(--ink-soft)",
                  }}
                >
                  {statusText}
                </span>
              </span>
              <span className="text-grad tabular-nums" style={{ fontWeight: 800, fontSize: 17 }}>
                {ngn(s.price)}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

// Bottle image with a graceful fallback (soft gradient + the flavour's initial)
// when a product has no image or the URL fails to load.
function BottleImage({ src, name, float }: { src: string | null | undefined; name: string; float?: boolean }): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: "100%",
          height: "100%",
          background: "linear-gradient(160deg, var(--surface-soft), #fff)",
          color: "var(--accent, #16794b)",
          fontWeight: 800,
          fontSize: 34,
          opacity: 0.8,
        }}
      >
        {name.trim().charAt(0).toUpperCase() || "🍶"}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setBroken(true)}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        padding: 8,
        filter: "drop-shadow(0 10px 10px rgba(0,0,0,0.18))",
        animation: float ? "js-floaty 5.5s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function FlavourTile({
  flavour,
  branchId,
  onPick,
}: {
  flavour: Flavour;
  branchId: string;
  onPick: () => void;
}): JSX.Element {
  const { product, sizes } = flavour;
  // Bottle + palette for this flavour: the assigned image wins, else a slug-mapped
  // bottle on the flavour's tint — so every tile is instantly recognisable.
  const vis = getFlavourVisual({ slug: product.slug, image_url: product.image_url });
  // Stock is tracked per flavour, not per size — every size draws from the same
  // on-hand pool, so the count lives on the flavour tile.
  const available = useLiveQuery(
    () => localAvailableForProduct(branchId, product.id),
    [branchId, product.id],
    null as number | null,
  );
  const oos = available !== null && available <= 0;
  const multi = sizes.length > 1;
  // Preorder-only flavours (e.g. 330ml-only) read "Preorder" instead of stock.
  const allPreorder = sizes.every((s) => s.variant.preorder_only ?? false);
  // Cheapest size up front; "from ₦x" signals more sizes sit behind the tap.
  // Tiles stay tappable even at zero stock so any can is reachable as a preorder.
  const minPrice = Math.min(...sizes.map((s) => s.price));
  const statusColor = allPreorder
    ? "var(--accent, #16794b)"
    : oos
      ? "var(--danger)"
      : "var(--ink-soft)";
  const statusText = allPreorder
    ? "Preorder"
    : available === null
      ? ""
      : oos
        ? "Out of stock"
        : `${available} in stock`;
  return (
    <button
      type="button"
      onClick={onPick}
      className="card card--hoverable"
      style={{
        textAlign: "left",
        cursor: "pointer",
        padding: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: 0,
        borderRadius: 16,
      }}
    >
      <div
        style={{
          position: "relative",
          height: 124,
          borderBottom: "1px solid var(--line)",
          background: vis.surface,
        }}
      >
        <BottleImage src={vis.bottle} name={product.name} float />
        <img
          src={vis.fruit}
          alt=""
          aria-hidden
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
          style={{ position: "absolute", left: 8, top: 8, width: 24, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.3))" }}
        />
        {allPreorder && (
          <span
            className="pill"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              fontSize: 10,
              fontWeight: 700,
              background: "rgba(245,158,11,0.15)",
              color: "var(--accent, #b45309)",
            }}
          >
            Preorder
          </span>
        )}
      </div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.25 }}>{product.name}</span>
        {statusText && (
          <span style={{ fontSize: 11, fontWeight: 600, color: statusColor }}>{statusText}</span>
        )}
        <div className="text-grad tabular-nums" style={{ fontWeight: 800, fontSize: 18, marginTop: 2 }}>
          {multi ? `from ${ngn(minPrice)}` : ngn(sizes[0]!.price)}
        </div>
      </div>
    </button>
  );
}
