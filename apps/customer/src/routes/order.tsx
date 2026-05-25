import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api, ngn } from "../lib/api.js";
import { BRAND } from "../data/menu.js";
import { SiteLayout } from "../components/SiteLayout.js";
import { Eyebrow, StatusPill, type Status } from "../components/ui/index.js";

interface DeliveryInfo {
  status:
    | "searching_rider"
    | "assigned"
    | "picked_up"
    | "in_transit"
    | "delivered"
    | "failed"
    | "cancelled";
  rider_name: string | null;
  rider_phone: string | null;
  rider_vehicle: string | null;
  tracking_url: string | null;
  eta_minutes: number | null;
  provider: "bolt" | "manual";
}

interface OrderResp {
  data: {
    order_number: string;
    status: string;
    payment_status: string;
    total_ngn: number;
    subtotal_ngn: number;
    delivery_fee_ngn: number;
    channel: string;
    created_at: string;
    delivery: DeliveryInfo | null;
  };
}

const TIMELINE = [
  { status: "confirmed", label: "Order placed", desc: "We've got your order — waiting on payment." },
  { status: "paid", label: "Payment received", desc: "Your bottles are being chilled and packed." },
  { status: "out_for_delivery", label: "Out for delivery", desc: "On the way to you." },
  { status: "delivered", label: "Delivered", desc: "Enjoy! Tag us at @mrs_samuelfruitjuice." },
];

function stepState(orderStatus: string, step: string): "done" | "current" | "pending" {
  const order = TIMELINE.findIndex((t) => t.status === orderStatus);
  const idx = TIMELINE.findIndex((t) => t.status === step);
  if (order === -1) return idx === 0 ? "current" : "pending";
  if (idx < order) return "done";
  if (idx === order) return "current";
  return "pending";
}

function asStatus(s: string): Status {
  const valid: Status[] = [
    "pending",
    "confirmed",
    "paid",
    "out_for_delivery",
    "delivered",
    "cancelled",
    "rejected",
    "flagged",
    "requires_review",
  ];
  return (valid as string[]).includes(s) ? (s as Status) : "pending";
}

function deliveryLabel(s: DeliveryInfo["status"]): string {
  return {
    searching_rider: "Finding a rider…",
    assigned: "Rider on the way to us",
    picked_up: "Order picked up",
    in_transit: "On the way to you",
    delivered: "Delivered",
    failed: "Delivery failed",
    cancelled: "Delivery cancelled",
  }[s];
}

export function OrderPage({ orderNumber }: { orderNumber: string }): JSX.Element {
  const nav = useNavigate();
  const search = useSearch({ strict: false }) as { paid?: string };
  const justPaid = search.paid === "1";

  const stashedKey = `ms_order_phone_${orderNumber}`;
  const initialPhone =
    typeof sessionStorage !== "undefined" ? sessionStorage.getItem(stashedKey) ?? "" : "";

  const [data, setData] = useState<OrderResp["data"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialPhone) {
      void nav({ to: "/track" });
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await api<OrderResp>(
          `/orders/${encodeURIComponent(orderNumber)}?phone=${encodeURIComponent(initialPhone)}`,
        );
        if (!cancelled) setData(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const handle = window.setInterval(() => {
      if (!data || ["delivered", "cancelled"].includes(data.status)) return;
      void load();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderNumber, initialPhone]);

  if (loading && !data) {
    return (
      <SiteLayout meta={{ title: `Order ${orderNumber} · Mrs. Samuel` }}>
        <main className="ms-order ms-container">
          <p className="ms-section-sub">Loading order…</p>
        </main>
      </SiteLayout>
    );
  }

  if (error || !data) {
    return (
      <SiteLayout meta={{ title: `Order ${orderNumber} · Mrs. Samuel` }}>
        <main className="ms-order ms-container">
          <Eyebrow>Order</Eyebrow>
          <h1 className="ms-section-title">We couldn't find that order.</h1>
          <p className="ms-section-sub">{error ?? "Try again from the track page."}</p>
          <Link to="/track" className="btn btn--primary">
            Try the lookup form
          </Link>
        </main>
      </SiteLayout>
    );
  }

  return (
    <SiteLayout meta={{ title: `Order ${orderNumber} · Mrs. Samuel` }}>
      <main className="ms-order ms-container">
        {justPaid && (
          <div className="ms-order__paid-banner" role="status">
            <strong>Payment confirmed</strong> · We're chilling your bottles. You'll see live
            updates on this page.
          </div>
        )}

        <Eyebrow>Order tracking</Eyebrow>
        <h1 className="ms-section-title">Order {orderNumber}</h1>

        <div className="ms-track__grid">
          <section className="ms-track__main">
            <header className="ms-track__head">
              <div>
                <div className="ms-cart__line-unit">
                  Placed{" "}
                  {new Date(data.created_at).toLocaleString("en-NG", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </div>
                <div className="ms-track__total tabular-nums">{ngn(data.total_ngn)}</div>
                {data.delivery_fee_ngn > 0 && (
                  <div className="ms-track__total-breakdown">
                    {ngn(data.subtotal_ngn)} juice + {ngn(data.delivery_fee_ngn)} delivery
                    {data.delivery?.provider === "bolt" && (
                      <span className="ms-track__provider-chip">via Bolt</span>
                    )}
                  </div>
                )}
              </div>
              <StatusPill status={asStatus(data.status)} />
            </header>

            <ol className="ms-track__timeline">
              {TIMELINE.map((step) => {
                const state = stepState(data.status, step.status);
                return (
                  <li key={step.status} className={`ms-track__step ms-track__step--${state}`}>
                    <span className="ms-track__dot" aria-hidden />
                    <div>
                      <div className="ms-track__step-label">{step.label}</div>
                      <div className="ms-track__step-desc">{step.desc}</div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {data.delivery && data.status !== "cancelled" && (
              <div className="ms-track__delivery">
                <div className="ms-track__delivery-head">
                  <Eyebrow>Delivery</Eyebrow>
                  <span className="ms-track__delivery-status">
                    {deliveryLabel(data.delivery.status)}
                  </span>
                </div>
                {data.delivery.rider_name ? (
                  <>
                    <div className="ms-track__rider">
                      <div className="ms-track__rider-avatar" aria-hidden>
                        {data.delivery.rider_name.charAt(0)}
                      </div>
                      <div>
                        <div className="ms-track__rider-name">{data.delivery.rider_name}</div>
                        {data.delivery.rider_vehicle && (
                          <div className="ms-track__rider-vehicle">
                            {data.delivery.rider_vehicle}
                          </div>
                        )}
                        {data.delivery.eta_minutes != null && (
                          <div className="ms-track__eta">ETA ~{data.delivery.eta_minutes} min</div>
                        )}
                      </div>
                    </div>
                    <div className="ms-track__delivery-actions">
                      {data.delivery.rider_phone && (
                        <a href={`tel:${data.delivery.rider_phone}`} className="btn btn--ghost">
                          Call rider
                        </a>
                      )}
                      {data.delivery.tracking_url && (
                        <a
                          href={data.delivery.tracking_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn--primary"
                        >
                          Track on Bolt →
                        </a>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="ms-cart__fineprint" style={{ margin: 0 }}>
                    Looking for a rider — usually under 5 minutes.
                  </p>
                )}
              </div>
            )}

            {data.status === "cancelled" && (
              <div className="ms-checkout__error" style={{ marginTop: 16 }}>
                This order was cancelled. If that's not right, message us on WhatsApp.
              </div>
            )}
          </section>

          <aside className="ms-track__aside">
            <h2 className="ms-cart__summary-title">Need a hand?</h2>
            <p className="ms-cart__fineprint" style={{ marginTop: 0 }}>
              Reach out and we'll sort it out fast.
            </p>
            <a
              href={`https://wa.me/${BRAND.whatsapp}?text=${encodeURIComponent(
                `Hi! Question about order ${orderNumber}.`,
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn--primary"
              style={{ width: "100%", justifyContent: "center", marginTop: 6 }}
            >
              Message on WhatsApp
            </a>
            <a
              href={`tel:${BRAND.phone.replace(/\s/g, "")}`}
              className="btn btn--ghost"
              style={{ width: "100%", justifyContent: "center", marginTop: 10 }}
            >
              Call {BRAND.phone}
            </a>
          </aside>
        </div>
      </main>
    </SiteLayout>
  );
}
