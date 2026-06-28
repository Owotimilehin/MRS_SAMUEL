import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { ConfirmModal } from "../../components/ConfirmModal.js";
import { DeliveryStatusPanel } from "../../components/DeliveryStatusPanel.js";
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
}

interface DeliveryRow {
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
}

function statusPill(status: string): JSX.Element {
  if (status === "paid") return <span className="pill pill--success">Paid</span>;
  if (status === "out_for_delivery") return <span className="pill pill--accent">Out for delivery</span>;
  if (status === "delivered") return <span className="pill pill--success">Delivered</span>;
  if (status === "handed_over") return <span className="pill pill--success">Handed over</span>;
  if (status === "confirmed") return <span className="pill pill--warning">Pending pay</span>;
  if (status === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  return <span className="pill">{status.replace(/_/g, " ")}</span>;
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
          sizeMl: null,
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

  const chips: StatChip[] = [
    { label: "Items", value: data ? data.items.length : "—" },
    { label: "Total", value: data ? ngn(data.totalNgn) : "—" },
    { label: "Status", value: data?.status.replace(/_/g, " ") ?? "—" },
    { label: "Channel", value: data?.channel ?? "—" },
  ];

  // Delivery + fulfilment logic — mirrors owner detail, gated on pos.sell for branch staff
  const isDeliveryOrder =
    data != null &&
    !!(
      data.deliveryAddressFormatted ||
      data.deliveryState ||
      (data.deliveryFeeNgn ?? 0) > 0 ||
      data.delivery
    );

  const liveDeliveryStatuses = new Set(["searching_rider", "assigned", "picked_up", "in_transit"]);
  const deliveryIsLive = !!(data?.delivery && liveDeliveryStatuses.has(data.delivery.status));

  const canAct = can("pos.sell") && !deliveryIsLive;
  const isPaid = data?.status === "paid";
  const isOutForDelivery = data?.status === "out_for_delivery";
  const isHandedOver = data?.status === "handed_over";

  const showFulfilmentSection =
    data != null && (canAct || deliveryIsLive) &&
    !["delivered", "cancelled", "failed"].includes(data.status);

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
              </div>
              <div style={{ textAlign: "right" }}>{statusPill(data.status)}</div>
            </header>

            <h3 style={{ fontSize: 14, fontWeight: 700, margin: "16px 0 8px" }}>Items</h3>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
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

          {/* Right sidebar */}
          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Customer card */}
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

            {/* Payment card (read-only — no payment actions for branch staff) */}
            <section className="card">
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Payment</h3>
              <div style={{ fontSize: 14 }}>Method: {data.paymentMethod}</div>
            </section>

            {/* Fulfilment panel — advance + ride book/cancel */}
            {showFulfilmentSection && (
              <section className="card">
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Fulfilment</h3>

                {deliveryIsLive && (
                  <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 10 }}>
                    Rider is active — status updates via webhook.
                  </p>
                )}

                {/* Force-delivered fallback when webhook is live but stalled */}
                {deliveryIsLive && can("pos.sell") && (
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

                {canAct && (
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

                {deliveryError && (
                  <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{deliveryError}</p>
                )}

                {/* Rider journey panel */}
                <DeliveryStatusPanel delivery={data.delivery ?? null} onRebook={bookRide} />
              </section>
            )}

            {/* Delivery booking section — for delivery orders with no active ride */}
            {data.channel !== "walkup" &&
              (data.deliveryAddressFormatted || data.customerAddress || data.deliveryState) &&
              can("pos.sell") && (
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

                  {data.delivery && data.delivery.status !== "cancelled" ? (
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
                        {data.customerPhone && (
                          <a
                            className="btn btn--primary btn--sm"
                            href={waLink(data.customerPhone)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            WhatsApp customer
                          </a>
                        )}
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
            Book <strong>{picked.courier_name}</strong> for <strong>{ngn(picked.fee_ngn)}</strong>. This debits
            the Shipbubble wallet. Tell the customer this amount on WhatsApp.
          </p>
        </ConfirmModal>
      )}
    </BranchShell>
  );
}
