import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { ConfirmModal } from "../../components/ConfirmModal.js";
import { DeliveryStatusPanel } from "../../components/DeliveryStatusPanel.js";
import { OrderJourney } from "../../components/OrderJourney.js";
import { deriveOrderJourney } from "../../lib/order-journey.js";
import { deriveOrderActions, type OrderActionId } from "../../lib/order-actions.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { useCan, useAuthUser } from "../../lib/auth.js";
import { buildReceiptFromOrder } from "../../lib/receipt-data.js";
import { getReceiptStyle } from "../../lib/receipt-settings.js";
import { fetchBranchInfo, printAndToast } from "../../lib/reprint.js";
import { toast } from "../../lib/toast.js";

interface SaleItem {
  id: string;
  productId: string;
  quantity: number;
  unitPriceNgn: number;
  lineTotalNgn: number;
  sizeMl?: number | null;
}

interface DeliveryRow {
  provider: "manual" | "shipbubble";
  status: string;
  externalRef?: string | null;
  riderName: string | null;
  riderPhone: string | null;
  riderVehicle: string | null;
  etaMinutes: number | null;
  trackingUrl: string | null;
  quotedFeeNgn?: number | null;
  actualFeeNgn?: number | null;
  assignedAt?: string | null;
  pickedUpAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  failedAt?: string | null;
  failReason?: string | null;
}

interface Sale {
  id: string;
  orderNumber: string;
  branchId: string;
  channel: string;
  status: string;
  scheduledDeliveryAt?: string | null;
  deliveryState?: string | null;
  isPreorder?: boolean;
  producedAt?: string | null;
  paymentMethod: string;
  subtotalNgn: number;
  deliveryFeeNgn: number;
  totalNgn: number;
  customerId: string | null;
  deliveryAddressFormatted?: string | null;
  notes: string | null;
  createdAtLocal: string;
  customerName?: string | null;
  customerPhone?: string | null;
  altPhone?: string | null;
  customerEmail?: string | null;
  customerAddress?: string | null;
  items: SaleItem[];
  delivery?: DeliveryRow | null;
  grossNgn?: number | null;
  feeNgn?: number | null;
  netNgn?: number | null;
  feeShortfallNgn?: number | null;
}

export function BranchOnlineOrderDetailPage({
  branchId,
  orderId,
}: {
  branchId: string;
  orderId: string;
}): JSX.Element {
  const can = useCan();
  const authUser = useAuthUser();

  const [data, setData] = useState<Sale | null>(null);
  const [products, setProducts] = useState<Record<string, { name: string; slug: string }>>({});
  const [loading, setLoading] = useState(true);
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  // Payment follow-up (awaiting-payment orders): re-check Payaza, record an
  // offline transfer/cash payment, or cancel as unpaid.
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payNote, setPayNote] = useState<string | null>(null);
  const [confirmCancelUnpaid, setConfirmCancelUnpaid] = useState(false);

  // Inline delivery-address editor
  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");
  const [stateDraft, setStateDraft] = useState("");
  const [savingAddress, setSavingAddress] = useState(false);

  interface CourierOption {
    id: string;
    courier_name: string;
    fee_ngn: number;
    eta_minutes: number | null;
  }
  const [options, setOptions] = useState<CourierOption[] | null>(null);
  const [receiverCode, setReceiverCode] = useState<number | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [picked, setPicked] = useState<CourierOption | null>(null);
  const [booking, setBooking] = useState(false);

  async function loadOrder(): Promise<void> {
    try {
      const res = await api<{ data: Sale }>(`/branches/${branchId}/sales/${orderId}`);
      setData(res.data);
    } catch (err) {
      toast.error(humanizeError(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [orderRes, prodRes] = await Promise.all([
          api<{ data: Sale }>(`/branches/${branchId}/sales/${orderId}`),
          api<{ data: Array<{ id: string; name: string; slug: string }> }>("/products"),
        ]);
        if (!cancelled) {
          setData(orderRes.data);
          setProducts(Object.fromEntries(prodRes.data.map((p) => [p.id, { name: p.name, slug: p.slug }])));
        }
      } catch (err) {
        if (!cancelled) toast.error(humanizeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, orderId]);

  async function advance(): Promise<void> {
    if (!data) return;
    setAdvanceBusy(true);
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${orderId}/advance`, { method: "PATCH", body: "{}" });
      await loadOrder();
    } catch (err) {
      setDeliveryError(humanizeError(err));
    } finally {
      setAdvanceBusy(false);
    }
  }

  async function produce(): Promise<void> {
    if (!data) return;
    setAdvanceBusy(true);
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/preorders/${orderId}/fulfil`, { method: "PATCH" }, { silentError: true });
      await loadOrder();
    } catch (err) {
      const msg = humanizeError(err);
      setDeliveryError(/unfulfillable|not enough stock/i.test(msg)
        ? "Not enough stock to produce this preorder yet — produce/transfer more first."
        : msg);
    } finally {
      setAdvanceBusy(false);
    }
  }

  async function recheckPayment(): Promise<void> {
    setPayBusy(true);
    setPayError(null);
    setPayNote(null);
    try {
      const res = await api<{ data: { status: string; outcome: { kind: string } } }>(
        `/online-orders/${orderId}/recheck`,
        { method: "POST", body: "{}" },
      );
      await loadOrder();
      if (res.data.status === "paid") setPayNote("Payment confirmed — order is now paid.");
      else setPayNote("Payaza still shows no completed payment for this order.");
    } catch (err) {
      setPayError(humanizeError(err));
    } finally {
      setPayBusy(false);
    }
  }

  async function recordPayment(method: "transfer" | "cash"): Promise<void> {
    setPayBusy(true);
    setPayError(null);
    setPayNote(null);
    try {
      await api(`/online-orders/${orderId}/record-payment`, {
        method: "POST",
        body: JSON.stringify({ method }),
      });
      await loadOrder();
      setPayNote(`Recorded ${method} payment — order is now paid.`);
    } catch (err) {
      setPayError(humanizeError(err));
    } finally {
      setPayBusy(false);
    }
  }

  async function cancelUnpaid(): Promise<void> {
    setConfirmCancelUnpaid(false);
    setPayBusy(true);
    setPayError(null);
    setPayNote(null);
    try {
      await api(`/online-orders/${orderId}/cancel-unpaid`, { method: "POST", body: "{}" });
      await loadOrder();
      setPayNote("Order cancelled as unpaid.");
    } catch (err) {
      setPayError(humanizeError(err));
    } finally {
      setPayBusy(false);
    }
  }

  function runAction(id: OrderActionId): void {
    switch (id) {
      case "produce": void produce(); break;
      case "advance":
      case "force_delivered": void advance(); break;
      case "book_rider":
      case "rebook_rider": bookRide(); break;
      default: break; // payment/refund/cancel: owner-only, not shown here
    }
  }
  function actionAllowed(id: OrderActionId): boolean {
    if (id === "accept_paid" || id === "mark_refunded" || id === "cancel_refund" || id === "recheck_payment") return false;
    return can("pos.sell");
  }

  async function getOptions(): Promise<void> {
    setLoadingOptions(true);
    setDeliveryError(null);
    try {
      const res = await api<{ data: { receiver_address_code: number | null; options: CourierOption[] } }>(
        `/branches/${branchId}/sales/${orderId}/delivery/options`,
      );
      setOptions(res.data.options);
      setReceiverCode(res.data.receiver_address_code);
    } catch (err) {
      setDeliveryError(humanizeError(err));
    } finally {
      setLoadingOptions(false);
    }
  }

  function bookRide(): void {
    setOptions(null);
    setPicked(null);
    void getOptions();
  }

  async function confirmBook(): Promise<void> {
    if (!picked) return;
    setBooking(true);
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${orderId}/delivery/book`, {
        method: "POST",
        body: JSON.stringify({
          option_id: picked.id,
          fee_ngn: picked.fee_ngn,
          ...(receiverCode != null ? { receiver_address_code: receiverCode } : {}),
        }),
      });
      setPicked(null);
      setOptions(null);
      await loadOrder();
    } catch (err) {
      setDeliveryError(humanizeError(err));
    } finally {
      setBooking(false);
    }
  }

  async function cancelRide(): Promise<void> {
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${orderId}/delivery/cancel`, { method: "POST", body: "{}" });
      await loadOrder();
    } catch (err) {
      setDeliveryError(humanizeError(err));
    }
  }

  function startEditAddress(): void {
    if (!data) return;
    setAddressDraft(data.deliveryAddressFormatted ?? data.customerAddress ?? "");
    setStateDraft(data.deliveryState ?? "");
    setDeliveryError(null);
    setEditingAddress(true);
  }

  async function saveAddress(): Promise<void> {
    if (!data || !addressDraft.trim()) return;
    setSavingAddress(true);
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${orderId}/delivery-address`, {
        method: "PATCH",
        body: JSON.stringify({ address: addressDraft.trim(), state: stateDraft.trim() || null }),
      });
      setEditingAddress(false);
      await loadOrder();
    } catch (err) {
      setDeliveryError(humanizeError(err));
    } finally {
      setSavingAddress(false);
    }
  }

  async function printReceipt(): Promise<void> {
    if (!data) return;
    setPrinting(true);
    try {
      const branch = await fetchBranchInfo(branchId);
      const receipt = buildReceiptFromOrder({
        style: getReceiptStyle(),
        orderNumber: data.orderNumber,
        createdAtIso: data.createdAtLocal,
        branch,
        servedBy: (authUser.email.split("@")[0] || authUser.role).replace(/[._]/g, " "),
        channel: data.channel,
        payment: data.paymentMethod,
        items: data.items.map((it) => ({
          name: products[it.productId]?.name ?? "Item",
          sizeMl: it.sizeMl ?? null,
          quantity: it.quantity,
          unitPriceNgn: it.unitPriceNgn,
          lineTotalNgn: it.lineTotalNgn,
        })),
        subtotalNgn: data.subtotalNgn,
        totalNgn: data.totalNgn,
      });
      await printAndToast(receipt);
    } finally {
      setPrinting(false);
    }
  }

  function waLink(phone: string): string {
    const digits = phone.replace(/\D/g, "").replace(/^0/, "234");
    const d = data?.delivery;
    const msg = encodeURIComponent(
      `Hi${data?.customerName ? " " + data.customerName : ""}, your Mrs. Samuel order ${data?.orderNumber} is on the way.` +
        (d?.riderName ? ` Rider: ${d.riderName}.` : "") +
        (d?.riderPhone ? ` Number: ${d.riderPhone}.` : "") +
        (d?.trackingUrl ? ` Track: ${d.trackingUrl}` : ""),
    );
    return `https://wa.me/${digits}?text=${msg}`;
  }

  const journey = data ? deriveOrderJourney(data) : null;
  const actions = data ? deriveOrderActions(data) : null;
  const lastRiderUpdate = data?.delivery
    ? [data.delivery.pickedUpAt, data.delivery.assignedAt].find(Boolean) ?? null
    : null;
  const deliveryStalled =
    data?.status === "out_for_delivery" &&
    !!lastRiderUpdate &&
    Date.now() - new Date(lastRiderUpdate).getTime() > 2 * 3600_000;

  const chips: StatChip[] = [
    { label: "Items", value: data ? data.items.length : "—" },
    { label: "Total", value: data ? ngn(data.totalNgn) : "—" },
    { label: "Status", value: journey?.currentLabel ?? "—" },
    { label: "Channel", value: data?.channel ?? "—" },
  ];

  return (
    <BranchShell
      branchId={branchId}
      title={data ? `Order ${data.orderNumber}` : "Order"}
      actions={
        <>
          {data && (
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              disabled={printing}
              onClick={() => void printReceipt()}
            >
              {printing ? "Printing…" : "🖨 Print receipt"}
            </button>
          )}
          <Link to="/branch/online-orders" className="btn btn--subtle btn--sm">
            ← Online orders
          </Link>
        </>
      }
    >
      <StatHero
        eyebrow="Branch"
        title={data ? `Order ${data.orderNumber}` : "Order"}
        sub={data ? `Placed ${formatDateTime(data.createdAtLocal)} · ${data.channel.replace(/_/g, " ")}` : "Loading…"}
        loading={loading}
        chips={chips}
      />

      {loading || !data ? (
        <InlineLoader />
      ) : (
        <div
          className="ed-rise"
          style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18, alignItems: "start" }}
        >
          {/* Left column: items + totals + notes */}
          <section className="card">
            <header className="card__head" style={{ alignItems: "flex-start" }}>
              <div>
                <div className="t-eyebrow" style={{ marginBottom: 4 }}>
                  {data.channel} · order
                </div>
                <h2 className="t-h2">{data.orderNumber}</h2>
                <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
                  Placed {formatDateTime(data.createdAtLocal)}
                </div>
                {data.scheduledDeliveryAt && (
                  <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 2 }}>
                    Scheduled for {formatDateTime(data.scheduledDeliveryAt)}
                  </div>
                )}
              </div>
              {data.isPreorder && (
                <div style={{ textAlign: "right" }}>
                  <span className="pill pill--warning">Preorder</span>
                </div>
              )}
            </header>

            <h3 style={{ fontSize: 14, fontWeight: 700, margin: "16px 0 8px" }}>Items</h3>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Size</th>
                    <th className="table__num">Qty</th>
                    <th className="table__num">Unit</th>
                    <th className="table__num">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((it) => {
                    const p = products[it.productId];
                    return (
                      <tr key={it.id}>
                        <td>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                            <FlavourMedia size="chip" product={{ slug: p?.slug }} />
                            <span style={{ fontWeight: 600 }}>
                              {p?.name ?? `${it.productId.slice(0, 8)}…`}
                            </span>
                          </span>
                        </td>
                        <td>{it.sizeMl ? `${it.sizeMl}ml` : "—"}</td>
                        <td className="table__num">{it.quantity}</td>
                        <td className="table__num">{ngn(it.unitPriceNgn)}</td>
                        <td className="table__num" style={{ fontWeight: 700 }}>
                          {ngn(it.lineTotalNgn)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: 18,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                maxWidth: 320,
                marginLeft: "auto",
              }}
            >
              <span style={{ color: "var(--ink-soft)" }}>Subtotal</span>
              <span className="tabular-nums" style={{ textAlign: "right" }}>
                {ngn(data.subtotalNgn)}
              </span>
              <span style={{ color: "var(--ink-soft)" }}>Delivery</span>
              <span className="tabular-nums" style={{ textAlign: "right" }}>
                {ngn(data.deliveryFeeNgn)}
              </span>
              <span style={{ fontWeight: 700 }}>Total</span>
              <span
                className="tabular-nums"
                style={{ textAlign: "right", fontWeight: 800, fontSize: 18 }}
              >
                {ngn(data.totalNgn)}
              </span>
              {data.paymentMethod === "card" && data.grossNgn != null && (
                <>
                  <span style={{ color: "var(--ink-soft)" }}>Payaza fee</span>
                  <span className="tabular-nums" style={{ textAlign: "right" }}>
                    {data.feeNgn != null ? ngn(data.feeNgn) : "—"}
                  </span>
                  <span style={{ color: "var(--ink-soft)" }}>Customer paid</span>
                  <span className="tabular-nums" style={{ textAlign: "right" }}>
                    {ngn(data.grossNgn)}
                  </span>
                  <span style={{ color: "var(--ink-soft)" }}>Net settled to you</span>
                  <span className="tabular-nums" style={{ textAlign: "right" }}>
                    {data.netNgn != null ? ngn(data.netNgn) : "—"}
                  </span>
                  {data.feeShortfallNgn != null && data.feeShortfallNgn > 0 && (
                    <>
                      <span style={{ color: "var(--danger)", fontWeight: 700 }}>Shortfall (loss)</span>
                      <span className="tabular-nums" style={{ textAlign: "right", color: "var(--danger)", fontWeight: 700 }}>
                        -{ngn(data.feeShortfallNgn)}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>

            {data.notes && (
              <div style={{ marginTop: 18 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Notes</h3>
                <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>{data.notes}</p>
              </div>
            )}
          </section>

          {/* Right sidebar */}
          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* 1. Status & fulfilment */}
            {journey && (
              <section
                className="card"
                style={{
                  border:
                    journey.special === "reconcile"
                      ? "1.5px solid var(--danger)"
                      : journey.special === "payment_hold"
                        ? "1.5px solid var(--warning)"
                        : undefined,
                }}
              >
                <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 700 }}>Status</h3>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: journey.special === "cancelled" ? "var(--ink-soft)" : "var(--accent)",
                    }}
                  >
                    {journey.currentLabel}
                  </span>
                </header>

                {journey.special === "payment_hold" && (
                  <p style={{ fontSize: 13, color: "var(--warning)", marginBottom: 12 }}>
                    Payment not confirmed yet — on hold until Payaza settles.
                  </p>
                )}
                {journey.special === "reconcile" && (
                  <p style={{ fontSize: 13, color: "var(--danger)", marginBottom: 12 }}>
                    Payment needs review before fulfilling.
                  </p>
                )}
                {journey.special === "cancelled" && (
                  <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 12 }}>
                    This order was cancelled.
                  </p>
                )}

                <OrderJourney journey={journey} />

                {data.scheduledDeliveryAt && (
                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--ink-soft)",
                      marginTop: 12,
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <span>⏰</span> Scheduled for {formatDateTime(data.scheduledDeliveryAt)}
                  </div>
                )}

                <div style={{ marginTop: 14 }}>
                  {deliveryStalled && (
                    <p style={{ fontSize: 13, color: "var(--warning)", marginBottom: 10 }}>
                      ⚠ Delivery may be stalled — no rider update in over 2h.
                    </p>
                  )}
                  {actions?.primary && actionAllowed(actions.primary.id) && (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={advanceBusy}
                      onClick={() => runAction(actions.primary!.id)}
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      {advanceBusy ? "Saving…" : actions.primary.label}
                    </button>
                  )}
                  {actions?.secondary
                    .filter((b) => (b.id === "advance" || b.id === "force_delivered") && actionAllowed(b.id))
                    .map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className="btn btn--subtle btn--sm"
                        disabled={advanceBusy}
                        onClick={() => runAction(b.id)}
                        style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 8 }}
                      >
                        {advanceBusy ? "Saving…" : b.label}
                      </button>
                    ))}
                  {deliveryError && !editingAddress && (
                    <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{deliveryError}</p>
                  )}
                  <DeliveryStatusPanel delivery={data.delivery ?? null} onRebook={bookRide} />
                </div>
              </section>
            )}

            {/* 2. Payment — read-only, plus follow-up actions when awaiting payment. */}
            <section className="card">
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Payment</h3>
              <div style={{ fontSize: 14, textTransform: "capitalize" }}>{data.paymentMethod}</div>

              {(data.status === "confirmed" || data.status === "reconcile_needed") &&
                can("orders.manage") && (
                  <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                    <p style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                      Not paid yet. Re-check Payaza, or record a payment the customer sent by
                      transfer or cash. Cancel as unpaid only if no money came at all.
                    </p>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={payBusy}
                      onClick={() => void recheckPayment()}
                      style={{ justifyContent: "center" }}
                    >
                      {payBusy ? "Working…" : "Re-check payment"}
                    </button>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={payBusy}
                        onClick={() => void recordPayment("transfer")}
                        style={{ flex: 1, justifyContent: "center" }}
                      >
                        Paid by transfer
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={payBusy}
                        onClick={() => void recordPayment("cash")}
                        style={{ flex: 1, justifyContent: "center" }}
                      >
                        Paid by cash
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={payBusy}
                      onClick={() => setConfirmCancelUnpaid(true)}
                      style={{ justifyContent: "center", color: "var(--danger)" }}
                    >
                      Cancel — unpaid
                    </button>
                    {payNote && (
                      <p style={{ fontSize: 13, color: "var(--accent)" }}>{payNote}</p>
                    )}
                    {payError && (
                      <p style={{ fontSize: 13, color: "var(--danger)" }}>{payError}</p>
                    )}
                  </div>
                )}
            </section>

            {/* 3. Customer */}
            {(data.customerName ||
              data.customerPhone ||
              data.customerEmail ||
              data.customerAddress ||
              data.deliveryAddressFormatted) && (
              <section className="card">
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Customer</h3>
                <div style={{ fontSize: 14, display: "grid", gap: 4 }}>
                  <div style={{ fontWeight: 600 }}>{data.customerName ?? "—"}</div>
                  {data.customerPhone && (
                    <div>
                      <a href={`tel:${data.customerPhone}`} style={{ color: "var(--accent)" }}>
                        {data.customerPhone}
                      </a>
                    </div>
                  )}
                  {data.altPhone && (
                    <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                      Alt phone: <a href={`tel:${data.altPhone}`} style={{ color: "var(--accent)" }}>{data.altPhone}</a>
                    </div>
                  )}
                  {data.customerEmail && (
                    <div style={{ color: "var(--ink-soft)" }}>
                      <a href={`mailto:${data.customerEmail}`} style={{ color: "var(--ink-soft)" }}>
                        {data.customerEmail}
                      </a>
                    </div>
                  )}
                </div>
                {data.customerPhone && (
                  <a
                    className="btn btn--primary btn--sm"
                    style={{ marginTop: 10 }}
                    href={waLink(data.customerPhone)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WhatsApp customer
                  </a>
                )}
              </section>
            )}

            {/* 4. Delivery — editable address + Shipbubble booking */}
            {data.channel !== "walkup" &&
              (data.deliveryAddressFormatted || data.customerAddress || data.deliveryState || can("pos.sell")) && (
                <section className="card">
                  <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <h3 style={{ fontSize: 13, fontWeight: 700 }}>Delivery</h3>
                    {can("pos.sell") && !editingAddress && data.status !== "delivered" && data.status !== "cancelled" && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={startEditAddress}
                        style={{ fontSize: 12 }}
                      >
                        ✎ {data.deliveryAddressFormatted || data.customerAddress || data.deliveryState ? "Edit" : "Add address"}
                      </button>
                    )}
                  </header>

                  {editingAddress ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      <textarea
                        className="input"
                        rows={3}
                        placeholder="Full delivery address (street, area, landmark)"
                        value={addressDraft}
                        onChange={(e) => setAddressDraft(e.target.value)}
                        style={{ width: "100%", resize: "vertical", fontSize: 14 }}
                      />
                      <input
                        className="input"
                        placeholder="State (e.g. Lagos)"
                        value={stateDraft}
                        onChange={(e) => setStateDraft(e.target.value)}
                        style={{ width: "100%", fontSize: 14 }}
                      />
                      {deliveryError && (
                        <p style={{ color: "var(--danger)", fontSize: 13 }}>{deliveryError}</p>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={savingAddress || !addressDraft.trim()}
                          onClick={() => void saveAddress()}
                        >
                          {savingAddress ? "Saving…" : "Save address"}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={savingAddress}
                          onClick={() => setEditingAddress(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 14 }}>
                        {data.deliveryAddressFormatted ?? data.customerAddress ?? "No delivery address yet"}
                      </div>
                      {data.deliveryState && (
                        <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 2 }}>
                          {data.deliveryState}
                        </div>
                      )}
                      {data.customerPhone && (
                        <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
                          {data.customerName ?? "Customer"} · {data.customerPhone}
                        </div>
                      )}
                    </>
                  )}

                  {!editingAddress && can("pos.sell") && (data.delivery && data.delivery.status !== "cancelled" ? (
                    <div style={{ marginTop: 10, fontSize: 13 }}>
                      <div style={{ color: "var(--ink-soft)" }}>
                        {data.delivery.provider} · {data.delivery.status}
                        {data.delivery.quotedFeeNgn != null && <> · {ngn(data.delivery.quotedFeeNgn)}</>}
                      </div>
                      {data.delivery.riderName && (
                        <div style={{ marginTop: 4 }}>Rider: {data.delivery.riderName}</div>
                      )}
                      {data.delivery.riderPhone && (
                        <div>Rider phone: {data.delivery.riderPhone}</div>
                      )}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        {data.delivery.trackingUrl && (
                          <a
                            className="btn btn--subtle btn--sm"
                            href={data.delivery.trackingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Track →
                          </a>
                        )}
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => void cancelRide()}
                        >
                          Cancel ride
                        </button>
                      </div>
                    </div>
                  ) : !data.customerPhone ? (
                    <p style={{ fontSize: 13, color: "var(--warning)", marginTop: 10 }}>
                      No customer phone on this order — arrange delivery manually.
                    </p>
                  ) : options ? (
                    <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                      {options.length === 0 && (
                        <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                          No couriers available for this route right now.
                        </p>
                      )}
                      {options.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => setPicked(o)}
                          className="btn btn--subtle btn--sm"
                          style={{ justifyContent: "space-between", textAlign: "left" }}
                        >
                          <span>
                            {o.courier_name}
                            {o.eta_minutes != null ? ` · ~${o.eta_minutes}m` : ""}
                          </span>
                          <strong>{ngn(o.fee_ngn)}</strong>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      style={{ marginTop: 10 }}
                      disabled={loadingOptions}
                      onClick={() => void getOptions()}
                    >
                      {loadingOptions ? "Getting options…" : "Get delivery options"}
                    </button>
                  ))}
                </section>
              )}
          </aside>
        </div>
      )}

      {picked && (
        <ConfirmModal
          title="Book this ride?"
          confirmLabel="Book ride"
          busyLabel="Booking…"
          busy={booking}
          onCancel={() => setPicked(null)}
          onConfirm={() => void confirmBook()}
        >
          <p style={{ fontSize: 14 }}>
            Book <strong>{picked.courier_name}</strong> for <strong>{ngn(picked.fee_ngn)}</strong>. This debits
            the Shipbubble wallet. Tell the customer this amount on WhatsApp.
          </p>
        </ConfirmModal>
      )}

      {confirmCancelUnpaid && (
        <ConfirmModal
          title="Cancel this order as unpaid?"
          confirmLabel="Cancel — unpaid"
          busyLabel="Cancelling…"
          busy={payBusy}
          onCancel={() => setConfirmCancelUnpaid(false)}
          onConfirm={() => void cancelUnpaid()}
        >
          <p style={{ fontSize: 14 }}>
            Only do this if <strong>no money came at all</strong> — not on Payaza and not by
            transfer. This cancels the order and owes the customer nothing. If they actually paid
            by transfer, use “Paid by transfer” instead.
          </p>
        </ConfirmModal>
      )}
    </BranchShell>
  );
}
