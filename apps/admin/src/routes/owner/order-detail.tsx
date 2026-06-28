import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { ConfirmModal } from "../../components/ConfirmModal.js";
import { DeliveryStatusPanel } from "../../components/DeliveryStatusPanel.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { useAuthUser, useCan } from "../../lib/auth.js";
import { buildReceiptFromOrder } from "../../lib/receipt-data.js";
import { getReceiptStyle } from "../../lib/receipt-settings.js";
import { fetchBranchInfo, printAndToast } from "../../lib/reprint.js";

interface SaleItem {
  id: string;
  productId: string;
  quantity: number;
  unitPriceNgn: number;
  lineTotalNgn: number;
  sizeMl?: number | null;
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
  refundOwedNgn?: number | null;
  reportedNgn?: number | null;
  customerEmail?: string | null;
  customerAddress?: string | null;
  items: SaleItem[];
  delivery?: {
    provider: "bolt" | "manual" | "shipbubble";
    status: string;
    externalRef?: string | null;
    riderName: string | null;
    riderPhone: string | null;
    riderVehicle: string | null;
    etaMinutes: number | null;
    trackingUrl: string | null;
    quotedFeeNgn?: number | null;
    actualFeeNgn?: number | null;
  } | null;
}

function statusPill(status: string): JSX.Element {
  if (status === "paid") return <span className="pill pill--success">Paid</span>;
  if (status === "delivered") return <span className="pill pill--success">Delivered</span>;
  if (status === "confirmed") return <span className="pill pill--warning">Pending pay</span>;
  if (status === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  if (status === "reconcile_needed") return <span className="pill pill--danger">Reconcile needed</span>;
  return <span className="pill">{status}</span>;
}

export function OrderDetailPage({ saleId }: { saleId: string }): JSX.Element {
  const [data, setData] = useState<Sale | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [products, setProducts] = useState<Record<string, { name: string; slug: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const authUser = useAuthUser();
  const can = useCan();
  const [printing, setPrinting] = useState(false);
  const [branchId, setBranchId] = useState<string>("");

  // Payment action modal states
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [showAcceptModal, setShowAcceptModal] = useState(false);
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showMarkRefundedModal, setShowMarkRefundedModal] = useState(false);
  const [markRefundedBusy, setMarkRefundedBusy] = useState(false);

  const [advanceBusy, setAdvanceBusy] = useState(false);

  interface CourierOption { id: string; courier_name: string; fee_ngn: number; eta_minutes: number | null }
  const [options, setOptions] = useState<CourierOption[] | null>(null);
  const [receiverCode, setReceiverCode] = useState<number | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [picked, setPicked] = useState<CourierOption | null>(null);
  const [booking, setBooking] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  async function reloadOrder(): Promise<void> {
    if (!data) return;
    try {
      const res = await api<{ data: Sale }>(`/branches/${data.branchId}/sales/${saleId}`);
      setData(res.data);
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Advance the order one legal step (paid→out_for_delivery→delivered etc.) */
  async function advance(): Promise<void> {
    if (!data || !branchId) return;
    setAdvanceBusy(true);
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${saleId}/advance`, { method: "PATCH", body: "{}" });
      await reloadOrder();
    } catch (err) {
      setDeliveryError(humanizeError(err));
    } finally {
      setAdvanceBusy(false);
    }
  }

  async function getOptions(): Promise<void> {
    setLoadingOptions(true);
    setDeliveryError(null);
    try {
      const res = await api<{ data: { receiver_address_code: number | null; options: CourierOption[] } }>(
        `/branches/${branchId}/sales/${saleId}/delivery/options`,
      );
      setOptions(res.data.options);
      setReceiverCode(res.data.receiver_address_code);
    } catch (err) {
      setDeliveryError(humanizeError(err));
    } finally {
      setLoadingOptions(false);
    }
  }

  /** Open the courier options flow — used directly and as "Re-book rider" callback. */
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
      await api(`/branches/${branchId}/sales/${saleId}/delivery/book`, {
        method: "POST",
        body: JSON.stringify({
          option_id: picked.id,
          fee_ngn: picked.fee_ngn,
          ...(receiverCode != null ? { receiver_address_code: receiverCode } : {}),
        }),
      });
      setPicked(null);
      setOptions(null);
      await reloadOrder();
    } catch (err) {
      setDeliveryError(humanizeError(err));
    } finally {
      setBooking(false);
    }
  }

  async function cancelRide(): Promise<void> {
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${saleId}/delivery/cancel`, { method: "POST", body: "{}" });
      await reloadOrder();
    } catch (err) {
      setDeliveryError(humanizeError(err));
    }
  }

  async function recheckPayment(): Promise<void> {
    setRecheckBusy(true);
    try {
      await api(`/online-orders/${saleId}/recheck`, { method: "POST", body: "{}" });
      await reloadOrder();
    } finally {
      setRecheckBusy(false);
    }
  }

  async function acceptAsPaid(): Promise<void> {
    setAcceptBusy(true);
    try {
      await api(`/online-orders/${saleId}/accept`, { method: "POST", body: "{}" });
      setShowAcceptModal(false);
      await reloadOrder();
    } finally {
      setAcceptBusy(false);
    }
  }

  async function cancelAndRefund(): Promise<void> {
    if (!cancelReason.trim()) return;
    setCancelBusy(true);
    try {
      await api(`/online-orders/${saleId}/cancel-refund`, {
        method: "POST",
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      setShowCancelModal(false);
      setCancelReason("");
      await reloadOrder();
    } finally {
      setCancelBusy(false);
    }
  }

  async function markRefunded(): Promise<void> {
    setMarkRefundedBusy(true);
    try {
      await api(`/online-orders/${saleId}/mark-refunded`, { method: "POST", body: "{}" });
      setShowMarkRefundedModal(false);
      await reloadOrder();
    } finally {
      setMarkRefundedBusy(false);
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

  async function printOrderReceipt(): Promise<void> {
    if (!data) return;
    setPrinting(true);
    try {
      const branch = await fetchBranchInfo(data.branchId);
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

  // Sale items only carry productId; resolve names/bottles client-side so the
  // Items table shows the flavour instead of a raw id fragment.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: Array<{ id: string; name: string; slug: string }> }>("/products");
        if (cancelled) return;
        setProducts(Object.fromEntries(res.data.map((p) => [p.id, { name: p.name, slug: p.slug }])));
      } catch {
        /* fall back to id fragment */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // We don't know the branch yet — fan out: list branches, try each for the sale.
        const br = await api<{ data: Array<{ id: string; name: string }> }>("/branches");
        let sale: Sale | null = null;
        let owningBranch: { id: string; name: string } | null = null;
        for (const b of br.data) {
          try {
            const res = await api<{ data: Sale }>(`/branches/${b.id}/sales/${saleId}`);
            sale = res.data;
            owningBranch = b;
            break;
          } catch {
            /* keep searching */
          }
        }
        if (cancelled) return;
        if (!sale) {
          setError("Order not found in any branch.");
          return;
        }
        setData(sale);
        setBranchName(owningBranch?.name ?? "");
        setBranchId(owningBranch?.id ?? "");
      } catch (err) {
        if (!cancelled) setError(humanizeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saleId]);

  return (
    <Shell
      title={data ? `Order ${data.orderNumber}` : "Order"}
      crumb="Owner"
      actions={
        <>
          {data && (
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              disabled={printing}
              onClick={() => void printOrderReceipt()}
            >
              {printing ? "Printing…" : "🖨 Print receipt"}
            </button>
          )}
          <Link to="/owner/orders" className="btn btn--subtle btn--sm">
            ← All orders
          </Link>
        </>
      }
    >
      <StatHero
        eyebrow="Sales"
        title={data ? `Order ${data.orderNumber}` : "Order"}
        sub={data ? `Placed ${formatDateTime(data.createdAtLocal)}` : "Loading…"}
        loading={loading}
        chips={[
          { label: "Items", value: data ? data.items.length : "—" },
          { label: "Total", value: data ? ngn(data.totalNgn) : "—" },
          { label: "Status", value: data?.status ?? "—" },
          { label: "Channel", value: data?.channel ?? "—" },
        ]}
      />

      {loading ? (
        <InlineLoader />
      ) : error || !data ? (
        <section className="card">
          <p style={{ color: "var(--danger)" }}>{error ?? "Order not found."}</p>
          <Link to="/owner/orders" className="btn btn--ghost btn--sm" style={{ marginTop: 12 }}>
            Back to orders
          </Link>
        </section>
      ) : (
        <div
          className="ed-rise"
          style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18, alignItems: "start" }}
        >
          <section className="card">
            <header className="card__head" style={{ alignItems: "flex-start" }}>
              <div>
                <div className="t-eyebrow" style={{ marginBottom: 4 }}>
                  {data.channel} · {branchName}
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
              <div style={{ textAlign: "right", display: "grid", gap: 6, justifyItems: "end" }}>
                {statusPill(data.status)}
                {data.isPreorder && <span className="pill pill--warning">Preorder</span>}
              </div>
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
            </div>

            {data.notes && (
              <div style={{ marginTop: 18 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Notes</h3>
                <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>{data.notes}</p>
              </div>
            )}
          </section>

          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
                  {(data.deliveryAddressFormatted ?? data.customerAddress) && (
                    <div style={{ color: "var(--ink-soft)" }}>
                      {data.deliveryAddressFormatted ?? data.customerAddress}
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

            <section className="card">
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Payment</h3>
              <div style={{ fontSize: 14 }}>Method: {data.paymentMethod}</div>
            </section>

            {/* Payment resolution panel — online orders only */}
            {data.channel === "online" && (
              <section className="card" style={{ border: data.status === "reconcile_needed" ? "1.5px solid var(--danger)" : undefined }}>
                <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 700 }}>Payment status</h3>
                  {statusPill(data.status)}
                </header>

                {/* Refund owed badge */}
                {data.refundOwedNgn != null && data.refundOwedNgn > 0 && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--danger)",
                      color: "#fff",
                      fontSize: 13,
                      fontWeight: 700,
                      borderRadius: 8,
                      padding: "4px 10px",
                      marginBottom: 10,
                    }}
                  >
                    <span>⚠</span>
                    Refund owed {ngn(data.refundOwedNgn)}
                  </div>
                )}

                {/* Amount mismatch row */}
                {data.reportedNgn != null && data.reportedNgn !== data.totalNgn && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-soft)",
                      background: "var(--surface-raised, rgba(0,0,0,0.03))",
                      borderRadius: 6,
                      padding: "6px 10px",
                      marginBottom: 12,
                      lineHeight: 1.6,
                    }}
                  >
                    <span style={{ fontWeight: 600, color: "var(--ink)" }}>Expected</span>{" "}
                    {ngn(data.totalNgn)}
                    {" · "}
                    <span style={{ fontWeight: 600, color: "var(--ink)" }}>Payaza reported</span>{" "}
                    {ngn(data.reportedNgn)}
                  </div>
                )}

                {/* Action buttons */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {can("orders.manage") && (
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={recheckBusy}
                      onClick={() => void recheckPayment()}
                      style={{ justifyContent: "center" }}
                    >
                      {recheckBusy ? "Checking…" : "↻ Re-check payment"}
                    </button>
                  )}
                  {can("orders.accept_payment") && (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={() => setShowAcceptModal(true)}
                      style={{ justifyContent: "center" }}
                    >
                      ✓ Accept as paid
                    </button>
                  )}
                  {can("orders.manage") && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => { setCancelReason(""); setShowCancelModal(true); }}
                      style={{ justifyContent: "center", color: "var(--danger)" }}
                    >
                      ✕ Cancel &amp; mark refund owed
                    </button>
                  )}
                  {can("orders.accept_payment") && data.refundOwedNgn != null && data.refundOwedNgn > 0 && (
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      onClick={() => setShowMarkRefundedModal(true)}
                      style={{ justifyContent: "center" }}
                    >
                      ✓ Mark refunded
                    </button>
                  )}
                </div>
              </section>
            )}

            {/* Fulfilment advance buttons — channel and delivery-booking aware */}
            {(() => {
              // Determine if this is a delivery order or a pickup
              const isDeliveryOrder =
                !!(data.deliveryAddressFormatted || data.deliveryState || (data.deliveryFeeNgn ?? 0) > 0 || data.delivery);

              // Live statuses where the webhook drives progress — hide manual steps
              const liveDeliveryStatuses = new Set(["searching_rider", "assigned", "picked_up", "in_transit"]);
              const deliveryIsLive = !!(data.delivery && liveDeliveryStatuses.has(data.delivery.status));

              const showAdvanceButtons = can("orders.manage") && !deliveryIsLive;
              const isPaid = data.status === "paid";
              const isOutForDelivery = data.status === "out_for_delivery";
              const isHandedOver = data.status === "handed_over";

              if (!showAdvanceButtons && !deliveryIsLive) return null;

              return (
                <section className="card">
                  <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Fulfilment</h3>

                  {deliveryIsLive && (
                    <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 10 }}>
                      Rider is active — status updates via webhook.
                    </p>
                  )}

                  {showAdvanceButtons && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {isDeliveryOrder ? (
                        <>
                          {isPaid && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              disabled={advanceBusy}
                              onClick={() => void advance()}
                            >
                              {advanceBusy ? "Saving…" : "Mark out for delivery"}
                            </button>
                          )}
                          {isOutForDelivery && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              disabled={advanceBusy}
                              onClick={() => void advance()}
                            >
                              {advanceBusy ? "Saving…" : "Mark delivered"}
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {isPaid && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              disabled={advanceBusy}
                              onClick={() => void advance()}
                            >
                              {advanceBusy ? "Saving…" : "Mark ready"}
                            </button>
                          )}
                          {isHandedOver && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              disabled={advanceBusy}
                              onClick={() => void advance()}
                            >
                              {advanceBusy ? "Saving…" : "Mark collected"}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Force-delivered fallback when webhook is live */}
                  {deliveryIsLive && can("orders.manage") && (
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={advanceBusy}
                      onClick={() => void advance()}
                      style={{ fontSize: 12, color: "var(--ink-soft)" }}
                    >
                      {advanceBusy ? "Saving…" : "Force delivered (fallback)"}
                    </button>
                  )}

                  {deliveryError && (
                    <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{deliveryError}</p>
                  )}

                  {/* Rider journey panel */}
                  <DeliveryStatusPanel delivery={data.delivery ?? null} onRebook={bookRide} />
                </section>
              );
            })()}

            {/* Delivery / Shipbubble booking — shown for any delivery order, not
                just ones with a geocoder-validated address. Since the customer
                live-courier quote was retired (LIVE_COURIER_QUOTES off),
                deliveryAddressFormatted is null on real orders; fall back to the
                customer's on-file address + state, which the options endpoint
                also uses. Walk-up / pickup channels never deliver. */}
            {data.channel !== "walkup" &&
              (data.deliveryAddressFormatted || data.customerAddress || data.deliveryState) && (
              <section className="card">
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Delivery</h3>
                <div style={{ fontSize: 14 }}>
                  {data.deliveryAddressFormatted ?? data.customerAddress ?? "Address on file"}
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

                {/* Booked delivery */}
                {data.delivery && data.delivery.status !== "cancelled" ? (
                  <div style={{ marginTop: 10, fontSize: 13 }}>
                    <div style={{ color: "var(--ink-soft)" }}>
                      {data.delivery.provider} · {data.delivery.status}
                      {data.delivery.quotedFeeNgn != null && <> · {ngn(data.delivery.quotedFeeNgn)}</>}
                    </div>
                    {data.delivery.riderName && <div style={{ marginTop: 4 }}>Rider: {data.delivery.riderName}</div>}
                    {data.delivery.riderPhone && <div>Rider phone: {data.delivery.riderPhone}</div>}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                      {data.customerPhone && (
                        <a className="btn btn--primary btn--sm" href={waLink(data.customerPhone)} target="_blank" rel="noopener noreferrer">
                          WhatsApp customer
                        </a>
                      )}
                      {data.delivery.trackingUrl && (
                        <a className="btn btn--subtle btn--sm" href={data.delivery.trackingUrl} target="_blank" rel="noopener noreferrer">
                          Track →
                        </a>
                      )}
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void cancelRide()}>
                        Cancel ride
                      </button>
                    </div>
                  </div>
                ) : !data.customerPhone ? (
                  <p style={{ fontSize: 13, color: "var(--warning)", marginTop: 10 }}>
                    No customer phone on this order — arrange delivery manually.
                  </p>
                ) : options ? (
                  /* Options fetched — pick a courier */
                  <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                    {options.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>No couriers available for this route right now.</p>}
                    {options.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setPicked(o)}
                        className="btn btn--subtle btn--sm"
                        style={{ justifyContent: "space-between", textAlign: "left" }}
                      >
                        <span>{o.courier_name}{o.eta_minutes != null ? ` · ~${o.eta_minutes}m` : ""}</span>
                        <strong>{ngn(o.fee_ngn)}</strong>
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    style={{ marginTop: 10 }}
                    disabled={loadingOptions || !branchId}
                    onClick={() => void getOptions()}
                  >
                    {loadingOptions ? "Getting options…" : "Get delivery options"}
                  </button>
                )}
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
            Book <strong>{picked.courier_name}</strong> for <strong>{ngn(picked.fee_ngn)}</strong>. This debits the
            Shipbubble wallet. Tell the customer this amount on WhatsApp.
          </p>
        </ConfirmModal>
      )}

      {showAcceptModal && data && (
        <ConfirmModal
          title="Accept order as paid?"
          confirmLabel="Accept as paid"
          busyLabel="Accepting…"
          busy={acceptBusy}
          onCancel={() => setShowAcceptModal(false)}
          onConfirm={() => void acceptAsPaid()}
        >
          <p style={{ fontSize: 14 }}>
            This will manually mark order <strong>{data.orderNumber}</strong> as{" "}
            <strong>paid</strong> ({ngn(data.totalNgn)}) without a Payaza verification.
            Only do this if you have confirmed payment through another channel.
          </p>
        </ConfirmModal>
      )}

      {showCancelModal && data && (
        <ConfirmModal
          title="Cancel order & mark refund owed?"
          confirmLabel="Cancel & mark refund"
          busyLabel="Cancelling…"
          busy={cancelBusy}
          confirmDisabled={cancelReason.trim() === ""}
          tone="danger"
          onCancel={() => setShowCancelModal(false)}
          onConfirm={() => void cancelAndRefund()}
        >
          <p style={{ fontSize: 14, marginBottom: 12 }}>
            This will cancel order <strong>{data.orderNumber}</strong> and mark a refund
            owed to the customer. Provide a reason:
          </p>
          <textarea
            className="input"
            rows={3}
            placeholder="e.g. Payment received but product unavailable"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 14 }}
          />
        </ConfirmModal>
      )}

      {showMarkRefundedModal && data && (
        <ConfirmModal
          title="Mark refund as sent?"
          confirmLabel="Mark refunded"
          busyLabel="Saving…"
          busy={markRefundedBusy}
          onCancel={() => setShowMarkRefundedModal(false)}
          onConfirm={() => void markRefunded()}
        >
          <p style={{ fontSize: 14 }}>
            Confirm that the refund of{" "}
            <strong>{ngn(data.refundOwedNgn ?? 0)}</strong> has been sent to the customer
            for order <strong>{data.orderNumber}</strong>. This cannot be undone.
          </p>
        </ConfirmModal>
      )}
    </Shell>
  );
}
