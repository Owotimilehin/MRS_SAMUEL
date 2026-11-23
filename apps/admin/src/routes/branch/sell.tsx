import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronDown, Search, Sunrise } from "lucide-react";
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
import { buildSellables, type Sellable } from "../../lib/sellables.js";
import { FailedSalesBanner } from "../../components/FailedSalesBanner.js";
import { QUICK_PICK_DAYS, QUICK_PICK_LIMIT, rankQuickPicks } from "../../lib/quick-picks.js";
import "../../components/till-extras.css";

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

type Channel = "walkup" | "whatsapp";
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

// One flavour grouping its sellable sizes — the unit the POS grid now shows.
interface Flavour {
  product: ProductRow;
  sizes: Sellable[];
}

const sizeLabel = (ml: number): string => (ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`);

// Most of one flavour + size a single cart line can hold. Stops a slipped
// finger (or a held-down key) turning 2 into 222.
const MAX_LINE_QTY = 99;

/** True when focus sits in something that takes typing (so shortcuts stay off). */
function isTypingTarget(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Only autofocus the search on devices with a real pointer (mouse/trackpad,
// which usually means a keyboard too). On a tablet or phone, focusing an input
// pops the on-screen keyboard over half the till.
function hasFinePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
}

// Below this width the till stacks into one column (the same 860px breakpoint
// `.l-split--pos` uses in index.css), so the cart sits under every product.
const NARROW_TILL = "(max-width: 860px)";

function useNarrowTill(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_TILL).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_TILL);
    const onChange = (): void => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

// Touch-sized square button for the bag / straw steppers.
const STEP_BTN: React.CSSProperties = {
  width: 40,
  height: 40,
  padding: 0,
  fontSize: 20,
  flex: "none",
  borderRadius: 12,
  background: "#fff",
  border: "1px solid var(--line)",
};

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
  const [successSale, setSuccessSale] = useState<
    { receipt: ReceiptData; itemCount: number; saleId: string } | null
  >(null);
  // Who is serving (for "Served by" on the receipt). admin_user has no name
  // field yet, so fall back to the email prefix then the role.
  const authUser = useAuthUser();
  const servedBy = (authUser.email.split("@")[0] || authUser.role).replace(/[._]/g, " ");
  // Stock-consuming sales need pos.sell (owner + branch_staff). Manager/admin
  // have only pos.preorder — they can take orders but never draw down stock.
  const canSellStock = authUser.capabilities.includes("pos.sell");
  const canPreorder = authUser.capabilities.includes("pos.preorder");
  // Is there an open shift on this device? null = still loading (no flash).
  // The gate applies to every role EXCEPT the owner: the owner may sell without
  // first opening a shift (the server enforces the same exemption). For the
  // owner we skip the check entirely and treat the shift as satisfied.
  const isOwner = authUser.role === "owner";
  const [hasShift, setHasShift] = useState<boolean | null>(isOwner ? true : null);
  useEffect(() => {
    if (isOwner) {
      setHasShift(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { hasOpenShift } = await import("../../sync/local-shift-open.js");
      const v = await hasOpenShift(branchId);
      if (!cancelled) setHasShift(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, isOwner]);
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

  // Expand the catalog into one sellable per (flavour × size). Retired sizes
  // are intentionally INCLUDED — retire is a storefront-only rule; the till
  // still sells them (see buildSellables).
  const sellables = useMemo<Sellable[]>(
    () => buildSellables(products, variants, prices),
    [products, variants, prices],
  );

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

  // ── Layout only (nothing below changes what a sale sends) ──
  // Narrow screens stack the cart under the products, so a bar pinned to the
  // bottom of the screen keeps the item count, total and a jump to the cart in
  // reach. Wide screens keep the cart beside the products with Total + Charge
  // pinned to the bottom of the cart card.
  const narrow = useNarrowTill();
  const cartFootRef = useRef<HTMLDivElement | null>(null);
  // True while Total + Charge are on screen (the bar then offers the way back).
  const [cartInView, setCartInView] = useState(false);
  // The floating call pill (owner shell) sits bottom-right; if it is on this
  // page, lift the bar above it rather than sliding underneath.
  const [barLift, setBarLift] = useState(0);
  // Bags + straws stay folded away until the cashier needs them.
  const [extrasOpen, setExtrasOpen] = useState(false);
  useEffect(() => {
    if (!narrow) return;
    setBarLift(document.querySelector(".callbar") ? 72 : 0);
    const el = cartFootRef.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    // Bottom margin discounts the strip of screen the bar itself covers.
    const io = new IntersectionObserver(
      (entries) => setCartInView(entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.6)),
      { rootMargin: "0px 0px -72px 0px", threshold: [0, 0.6, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
    // hasShift: the cart only mounts once the shift gate has cleared.
  }, [narrow, hasShift]);
  useEffect(() => {
    if (successSale) setExtrasOpen(false);
  }, [successSale]);
  // A preorder with no date is the one checkout error whose fix can be scrolled
  // out of sight inside the cart, so bring the date field back into view.
  useEffect(() => {
    if (!error || fulfillBy) return;
    const el = document.getElementById("sell-fulfil-by");
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [error, fulfillBy]);
  // Land with Total + Charge sitting just above the bar, the cart lines above them.
  function jumpToCart(): void {
    cartFootRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }
  function jumpToProducts(): void {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

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
          l.variant_id === s.variant.id ? { ...l, quantity: Math.min(MAX_LINE_QTY, l.quantity + 1) } : l,
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
  // An explicit 0 (typed, or − from 1) removes the line. Callers never pass a
  // cleared box here: QtyInput holds an empty draft without touching the cart.
  function updateQty(variantId: string, qty: number): void {
    if (!Number.isFinite(qty)) return;
    const next = Math.min(MAX_LINE_QTY, Math.floor(qty));
    setCart((c) =>
      next <= 0
        ? c.filter((l) => l.variant_id !== variantId)
        : c.map((l) => (l.variant_id === variantId ? { ...l, quantity: next } : l)),
    );
  }
  function removeLine(variantId: string): void {
    setCart((c) => c.filter((l) => l.variant_id !== variantId));
  }
  function clearCart(): void {
    setCart([]);
  }

  const total = cart.reduce((sum, l) => sum + l.quantity * l.unit_price_ngn, 0);
  const cartItemCount = cart.reduce((n, l) => n + l.quantity, 0);
  const bagsAdded = Object.values(bagCart).reduce((n, q) => n + q, 0);
  const strawsAdded = Object.values(strawCart).reduce((n, q) => n + q, 0);
  const extrasTitle =
    bagMaterials.length > 0 && strawMaterials.length > 0 ? "Bags and straws" : bagMaterials.length > 0 ? "Bags" : "Straws";
  const extrasSummary =
    [
      bagsAdded > 0 ? `${bagsAdded} ${bagsAdded === 1 ? "bag" : "bags"}` : null,
      strawsAdded > 0 ? `${strawsAdded} ${strawsAdded === 1 ? "straw" : "straws"}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "None added";

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

  // Synchronous guard against a double charge (e.g. Enter pressed twice before
  // React re-renders with submitting=true).
  const submittingRef = useRef(false);
  async function checkout(): Promise<void> {
    if (cart.length === 0 || submitting || submittingRef.current) return;
    submittingRef.current = true;
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
      setSuccessSale({ receipt, itemCount, saleId: sale.saleId });
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
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // ── Quick picks: this device's best sellers over the last week ──
  // Read from the local outbox (every till sale's Confirm row keeps its items),
  // so it works offline and needs no server call. Empty on a fresh device.
  const quickPickIds = useLiveQuery(
    async () => {
      const since = Date.now() - QUICK_PICK_DAYS * 86_400_000;
      const rows = await local.outbox.where("created_at_local").aboveOrEqual(since).toArray();
      return rankQuickPicks(rows, { branchId, sinceMs: since });
    },
    [branchId],
    [] as string[],
  );
  const quickPicks = useMemo<Sellable[]>(() => {
    const byVariant = new Map(sellables.map((s) => [s.variant.id, s]));
    return (quickPickIds ?? [])
      .map((id) => byVariant.get(id))
      .filter((s): s is Sellable => s != null)
      .slice(0, QUICK_PICK_LIMIT);
  }, [quickPickIds, sellables]);

  // ── Keyboard (USB / Bluetooth keyboard at the counter) ──
  //   Enter  → Charge, when the cart has items and nothing that takes typing
  //            (or a button, which Enter already presses) has focus
  //   1–8    → add quick pick N, when no input has focus
  //   Escape → closes the success modal (Modal handles that itself)
  const searchRef = useRef<HTMLInputElement | null>(null);
  const keyState = useRef({ checkout, addToCart, quickPicks, cartLength: cart.length, blocked: false });
  keyState.current = {
    checkout,
    addToCart,
    // Quick picks are hidden while a search is typed, so their keys are too.
    quickPicks: search ? [] : quickPicks,
    cartLength: cart.length,
    blocked: picking != null || successSale != null || checkoutDisabled || hasShift !== true,
  };
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const k = keyState.current;
      // Any open dialog (size picker, success modal, confirm) owns the keyboard.
      if (k.blocked || document.querySelector("[role='dialog']")) return;
      const active = document.activeElement;
      if (isTypingTarget(active)) return;
      if (e.key === "Enter") {
        // A focused button/link already acts on Enter; don't charge on top.
        if (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement) return;
        if (k.cartLength === 0) return;
        e.preventDefault();
        void k.checkout();
        return;
      }
      if (/^[1-8]$/.test(e.key)) {
        const pick = k.quickPicks[Number(e.key) - 1];
        if (!pick) return;
        e.preventDefault();
        k.addToCart(pick);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Put the cursor in the flavour search once the till is ready, on keyboard
  // devices only (see hasFinePointer).
  useEffect(() => {
    if (hasShift === true && hasFinePointer()) searchRef.current?.focus();
  }, [hasShift]);

  function ConsumableSection(props: {
    title: string;
    noun: string;
    emoji: string;
    materials: BagMaterial[];
    cart: Record<string, number>;
    setQty: (id: string, qty: number) => void;
    isSet: boolean;
    markNone: () => void;
  }): JSX.Element {
    const { title, noun, emoji, materials, cart, setQty, isSet, markNone } = props;
    const added = materials.reduce((n, m) => n + (cart[m.id] ?? 0), 0);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>{title}</strong>
          <span style={{ fontSize: 12, color: isSet ? "var(--success-ink, #047857)" : "var(--ink-soft)" }}>
            {isSet ? (added > 0 ? `✓ ${added} added` : "✓ None this sale") : "Optional"}
          </span>
        </div>
        {materials.map((m) => {
          const qty = cart[m.id] ?? 0;
          const remaining = m.balance - qty;
          // Red only when more are being handed out than the stock record holds.
          const short = remaining < 0;
          return (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
                <span>{emoji} {m.name}</span>
                <span className="tabular-nums" style={{ fontSize: 12, color: short ? "var(--danger)" : "var(--ink-soft)" }}>
                  {short
                    ? `${-remaining} more than the stock record shows`
                    : remaining === 0
                      ? "None left"
                      : `${remaining} left`}
                </span>
              </span>
              <button type="button" className="btn btn--subtle" style={STEP_BTN} aria-label={`One less ${m.name}`} onClick={() => setQty(m.id, qty - 1)}>−</button>
              <span className="tabular-nums" style={{ width: 24, textAlign: "center", fontWeight: 700 }}>{qty}</span>
              <button type="button" className="btn btn--subtle" style={STEP_BTN} aria-label={`One more ${m.name}`} onClick={() => setQty(m.id, qty + 1)}>+</button>
            </div>
          );
        })}
        {!isSet && (
          <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start", height: 40 }} onClick={markNone}>
            No {noun} this sale
          </button>
        )}
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
        <FailedSalesBanner />
        <section className="card" style={{ textAlign: "center", padding: 32 }}>
          <span className="empty__icon" aria-hidden>
            <Sunrise />
          </span>
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
      <FailedSalesBanner />
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
      <div className="l-split l-split--pos">
        <section>
          <div className="toolbar__search" style={{ marginBottom: 14 }}>
            <Search aria-hidden />
            <input
              ref={searchRef}
              className="input"
              type="search"
              aria-label="Search products"
              placeholder="Search products…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Keyboard flow from the search box: Enter picks the only
                // matching flavour (or charges when the box is empty and the
                // cart isn't); Escape clears and leaves the box so 1–8 work.
                if (e.key === "Enter") {
                  if (search && filtered.length === 1) {
                    e.preventDefault();
                    pickFlavour(filtered[0]!);
                    setSearch("");
                  } else if (!search && cart.length > 0 && !checkoutDisabled) {
                    e.preventDefault();
                    void checkout();
                  }
                } else if (e.key === "Escape") {
                  setSearch("");
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
          <p className="till-keys-hint">
            Keyboard: <kbd>Enter</kbd> charge · <kbd>1</kbd>–<kbd>8</kbd> quick picks · <kbd>Esc</kbd> leave
            the search box or close the receipt
          </p>
          {quickPicks.length > 0 && !search && (
            <div className="quick-picks">
              <div className="quick-picks__label">Quick picks · your best sellers this week</div>
              <div className="quick-picks__row">
                {quickPicks.map((s, i) => {
                  const vis = getFlavourVisual({ slug: s.product.slug, image_url: s.product.image_url });
                  return (
                    <button
                      key={s.variant.id}
                      type="button"
                      className="quick-pick"
                      style={{ ["--fl-accent" as string]: vis.accent } as React.CSSProperties}
                      aria-label={`Add one ${s.product.name} ${sizeLabel(s.variant.size_ml)}`}
                      onClick={(e) => {
                        // A tap/click shouldn't leave focus here, or the next
                        // Enter would add another instead of charging.
                        if (e.detail > 0) e.currentTarget.blur();
                        addToCart(s);
                      }}
                    >
                      <span className="quick-pick__key" aria-hidden>
                        {i + 1}
                      </span>
                      <span className="quick-pick__name">{s.product.name}</span>
                      <span className="quick-pick__meta tabular-nums">
                        {sizeLabel(s.variant.size_ml)} · {ngn(s.price)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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
                  onPick={(e) => {
                    // Don't leave focus on a tapped tile: the next Enter should
                    // charge, not add the same flavour again.
                    if (e.detail > 0) e.currentTarget.blur();
                    pickFlavour(f);
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {/* Wide screens: the cart sticks beside the products, lines up with the
            search box (header 61px + 24px page padding), never grows taller
            than the window, and keeps Total + Charge pinned at its foot while
            the lines and options scroll inside it. Narrow screens: it stacks
            under the products at full height and the bottom bar jumps to it. */}
        <aside
          className="card pos-cart"
          style={
            narrow
              ? undefined
              : { top: 85, maxHeight: "calc(100vh - 101px)", display: "flex", flexDirection: "column" }
          }
        >
          <header className="till-cart__head" style={{ flex: "none" }}>
            <span className="till-cart__count">
              <b>Cart</b>
              {cart.length > 0 && (
                <span className="till-cart__pill">{cartItemCount} {cartItemCount === 1 ? "item" : "items"}</span>
              )}
            </span>
            {cart.length > 0 && (
              <button type="button" className="till-cart__clear" style={{ minHeight: 32, padding: "0 6px" }} onClick={clearCart}>
                Clear
              </button>
            )}
          </header>

          <div
            style={
              narrow
                ? undefined
                : { flex: "1 1 auto", minHeight: 0, overflowY: "auto", margin: "0 -6px", padding: "0 6px 4px" }
            }
          >
          {cart.length === 0 ? (
            <div className="empty" style={{ padding: 16 }}>
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
                        <button type="button" aria-label="Decrease" style={{ width: 40, height: 40 }} onClick={() => updateQty(l.variant_id, l.quantity - 1)}>−</button>
                        <QtyInput
                          quantity={l.quantity}
                          onCommit={(q) => updateQty(l.variant_id, q)}
                        />
                        <button type="button" aria-label="Increase" style={{ width: 40, height: 40 }} onClick={() => updateQty(l.variant_id, l.quantity + 1)}>+</button>
                      </div>
                      <button type="button" className="till-line__rm" style={{ width: 40, height: 40, fontSize: 22 }} onClick={() => removeLine(l.variant_id)} aria-label="Remove">×</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="field" style={{ minWidth: 0 }}>
                <label className="field__label" htmlFor="sell-customer-phone">Customer phone</label>
                <input
                  id="sell-customer-phone"
                  className="input"
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="Optional"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </div>
              <div className="field" style={{ minWidth: 0 }}>
                <label className="field__label" htmlFor="sell-customer-name">Customer name</label>
                <input
                  id="sell-customer-name"
                  className="input"
                  autoComplete="off"
                  placeholder="Optional"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>
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
                    <label className="field__label" htmlFor="sell-fulfil-by">Delivery date *</label>
                    <input
                      id="sell-fulfil-by"
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
            {(bagMaterials.length > 0 || strawMaterials.length > 0) && (
              <div className="card card--soft" style={{ padding: 0, borderColor: "var(--line)", overflow: "hidden" }}>
                <button
                  type="button"
                  aria-expanded={extrasOpen}
                  onClick={() => setExtrasOpen((o) => !o)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    minHeight: 44,
                    padding: "0 12px",
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                    font: "inherit",
                    color: "inherit",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>🛍 {extrasTitle}</span>
                  <span className="tabular-nums" style={{ fontSize: 12, color: "var(--ink-soft)" }}>{extrasSummary}</span>
                  <ChevronDown
                    aria-hidden
                    size={18}
                    style={{ flex: "none", transition: "transform 160ms ease", transform: extrasOpen ? "rotate(180deg)" : undefined }}
                  />
                </button>
                {extrasOpen && (
                  <div style={{ padding: "4px 12px 12px", display: "flex", flexDirection: "column", gap: 14 }}>
                    {bagMaterials.length > 0 && (
                      <ConsumableSection
                        title="Bags" noun="bags" emoji="🛍" materials={bagMaterials}
                        cart={bagCart} setQty={setBagQty} isSet={bagsSet}
                        markNone={() => setBagsSet(true)}
                      />
                    )}
                    {strawMaterials.length > 0 && (
                      <ConsumableSection
                        title="Straws" noun="straws" emoji="🥤" materials={strawMaterials}
                        cart={strawCart} setQty={setStrawQty} isSet={strawsSet}
                        markNone={() => setStrawsSet(true)}
                      />
                    )}
                    <span className="field__hint">
                      Free with the sale. Adding them here only keeps the count of what is left correct.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          </div>

          <div
            ref={cartFootRef}
            style={{ flex: "none", display: "flex", flexDirection: "column", gap: 10, scrollMarginBottom: 96 + barLift }}
          >
            <div className="till-total" style={{ margin: "12px 0 0", paddingTop: 12 }}>
              <span className="till-total__label">{orderIsPreorder ? "Preorder total" : "Total"}</span>
              <span className="till-total__value tabular-nums">{ngn(total)}</span>
            </div>
            {error && (
              <div
                role="alert"
                style={{
                  border: "1px solid rgba(220,38,38,0.25)",
                  background: "rgba(220,38,38,0.06)",
                  color: "var(--danger)",
                  borderRadius: 12,
                  padding: "8px 12px",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {error}
              </div>
            )}
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

      {/* Narrow screens only: item count + total pinned to the bottom of the
          screen, with one button to jump to the cart (or back to the products).
          The spacer keeps the end of the page from hiding behind the bar. */}
      {narrow && (
        <>
          <div aria-hidden style={{ height: 16 + barLift }} />
          <div
            style={{
              position: "fixed",
              left: 0,
              right: 0,
              bottom: barLift,
              zIndex: 40,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px calc(10px + env(safe-area-inset-bottom, 0px))",
              background: "#fff",
              borderTop: "1px solid var(--line)",
              boxShadow: "0 -8px 24px -14px rgba(20,24,31,0.28)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0, lineHeight: 1.2 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-soft)" }}>
                {cartItemCount === 0
                  ? "Cart is empty"
                  : `${cartItemCount} ${cartItemCount === 1 ? "item" : "items"} in cart`}
              </div>
              <div className="tabular-nums" style={{ fontSize: 20, fontWeight: 800, color: "var(--brand)" }}>
                {ngn(total)}
              </div>
            </div>
            {cartInView ? (
              <button type="button" className="btn btn--subtle btn--lg" onClick={jumpToProducts}>
                ↑ Add more
              </button>
            ) : (
              <button
                type="button"
                className={`btn btn--lg ${cartItemCount > 0 ? "btn--primary" : "btn--subtle"}`}
                onClick={jumpToCart}
              >
                View cart ↓
              </button>
            )}
          </div>
        </>
      )}

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
          saleId={successSale.saleId}
          onNewSale={() => setSuccessSale(null)}
        />
      )}
    </BranchShell>
  );
}

// Cart-line quantity box. Clearing it (to type a new number) keeps the line:
// the empty box is held as a draft and snaps back to the current quantity if
// left empty. Only an explicit 0 removes the line; anything above 99 is capped.
function QtyInput({ quantity, onCommit }: { quantity: number; onCommit: (q: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(quantity));
  useEffect(() => setDraft(String(quantity)), [quantity]);
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={MAX_LINE_QTY}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9]/g, "");
        if (raw === "") {
          setDraft("");
          return;
        }
        const n = Math.min(MAX_LINE_QTY, parseInt(raw, 10));
        setDraft(String(n));
        onCommit(n);
      }}
      onBlur={() => {
        if (draft === "") setDraft(String(quantity));
      }}
      aria-label="Quantity"
      style={{ height: 40, width: 48 }}
    />
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
  onPick: (e: React.MouseEvent<HTMLButtonElement>) => void;
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
        ? "Out of stock · preorder only"
        : `${available} in stock`;
  // Out-of-stock tiles stay tappable (the order becomes a preorder) but are
  // dimmed so they no longer look the same as something on the shelf.
  const dim = oos && !allPreorder;
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
        <div style={{ width: "100%", height: "100%", opacity: dim ? 0.4 : 1, filter: dim ? "grayscale(0.6)" : undefined }}>
          <BottleImage src={vis.bottle} name={product.name} float={!dim} />
        </div>
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
        <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.25, color: dim ? "var(--ink-soft)" : undefined }}>{product.name}</span>
        {statusText && (
          <span style={{ fontSize: 11, fontWeight: 600, color: statusColor }}>{statusText}</span>
        )}
        {/* Same shape on every tile: a small lead-in ("from" when there are
            several sizes, the size itself when there is only one), then the price. */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-soft)" }}>
            {multi ? "from" : sizeLabel(sizes[0]!.variant.size_ml)}
          </span>
          <span
            className={dim ? "tabular-nums" : "text-grad tabular-nums"}
            style={{ fontWeight: 800, fontSize: 18, color: dim ? "var(--ink-soft)" : undefined }}
          >
            {multi ? ngn(minPrice) : ngn(sizes[0]!.price)}
          </span>
        </div>
      </div>
    </button>
  );
}
