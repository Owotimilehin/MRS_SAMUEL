import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { ConfirmModal } from "../../components/ConfirmModal.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { useAuthUser } from "../../lib/auth.js";
import { buildReceiptFromOrder } from "../../lib/receipt-data.js";
import { getReceiptStyle } from "../../lib/receipt-settings.js";
import { fetchBranchInfo, printAndToast } from "../../lib/reprint.js";

interface SaleItem {
  id: string;
  productId: string;
  quantity: number;
  unitPriceNgn: number;
  lineTotalNgn: number;
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
  return <span className="pill">{status}</span>;
}

export function OrderDetailPage({ saleId }: { saleId: string }): JSX.Element {
  const [data, setData] = useState<Sale | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [products, setProducts] = useState<Record<string, { name: string; slug: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const authUser = useAuthUser();
  const [printing, setPrinting] = useState(false);
  const [branchId, setBranchId] = useState<string>("");

  interface CourierOption { id: string; courier_name: string; fee_ngn: number; eta_minutes: number | null }
  const [options, setOptions] = useState<CourierOption[] | null>(null);
  const [receiverCode, setReceiverCode] = useState<number | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [picked, setPicked] = useState<CourierOption | null>(null);
  const [booking, setBooking] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  async function reloadOrder(): Promise<void> {
    const res = await api<{ data: Sale }>(`/branches/${branchId}/sales/${saleId}`);
    setData(res.data);
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
              </div>
              <div style={{ textAlign: "right" }}>
                {statusPill(data.status)}
              </div>
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

          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section className="card">
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Payment</h3>
              <div style={{ fontSize: 14 }}>Method: {data.paymentMethod}</div>
            </section>

            {data.deliveryAddressFormatted && (
              <section className="card">
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Delivery</h3>
                <div style={{ fontSize: 14 }}>{data.deliveryAddressFormatted}</div>
                {data.customerPhone && (
                  <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
                    {data.customerName ?? "Customer"} · {data.customerPhone}
                  </div>
                )}

                {deliveryError && (
                  <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{deliveryError}</p>
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
    </Shell>
  );
}
