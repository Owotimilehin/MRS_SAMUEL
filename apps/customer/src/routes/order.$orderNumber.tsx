import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Loader2, AlertCircle } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { trackOrder } from "@/lib/api/server-fns";
import { ApiError } from "@/lib/api/client";
import type { ApiOrderTracking } from "@/lib/api/types";
import { deriveJourney } from "@/lib/order-journey";
import { OrderTimeline } from "@/components/OrderTimeline";
import { RiderCard } from "@/components/RiderCard";
import { OrderSummaryCard } from "@/components/OrderSummaryCard";
import { PaymentHoldBanner } from "@/components/PaymentHoldBanner";

export const Route = createFileRoute("/order/$orderNumber")({
  head: () => ({ meta: [{ title: "Your order — Mrs. Samuel Fruit Juice" }] }),
  component: OrderPage,
});

function storedPhone(orderNumber: string): string | null {
  try {
    const raw = localStorage.getItem(`ms_track_${orderNumber}`);
    return raw ? (JSON.parse(raw).phone ?? null) : null;
  } catch {
    return null;
  }
}

const TERMINAL = new Set(["delivered", "cancelled"]);

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-NG", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function OrderPage() {
  const { orderNumber } = useParams({ from: "/order/$orderNumber" });
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [order, setOrder] = useState<ApiOrderTracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setPhone(storedPhone(orderNumber));
  }, [orderNumber]);

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      try {
        const o = await trackOrder({ data: { orderNumber, phone: p } });
        setOrder(o);
        setError(null);
        if (!TERMINAL.has(o.status) && document.visibilityState === "visible") {
          timerRef.current = setTimeout(() => void load(p), 20000);
        }
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.message
            : "We couldn't find an order with that number and phone.",
        );
      } finally {
        setLoading(false);
      }
    },
    [orderNumber],
  );

  useEffect(() => {
    if (!phone) return;
    void load(phone);
    const onVis = () => {
      if (document.visibilityState === "visible" && order && !TERMINAL.has(order.status))
        void load(phone);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, load]);

  const journey = order ? deriveJourney(order) : null;

  return (
    <SiteShell>
      <div className="px-5 sm:px-10 max-w-2xl mx-auto pt-32 sm:pt-36 pb-24">
        <div className="inline-flex items-center gap-2 rounded-full bg-[color:var(--cream)]/80 px-4 py-1.5 text-xs font-mono">
          <span className="text-[color:var(--brand)]/60">Order</span>
          <span className="font-bold text-[color:var(--brand)]">{orderNumber}</span>
        </div>

        {!phone && (
          <div className="mt-8 rounded-2xl bg-white ring-1 ring-black/5 p-6">
            <p className="text-sm text-[color:var(--brand)]/75">
              Enter the phone number on the order to view its status.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="0800 000 0000"
                className="flex-1 rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none"
              />
              <button
                onClick={() => setPhone(phoneInput.replace(/[\s-]/g, ""))}
                className="rounded-xl bg-[color:var(--brand)] text-white px-5 text-sm font-semibold"
              >
                View
              </button>
            </div>
          </div>
        )}

        {phone && loading && !order && (
          <div className="mt-10 flex items-center gap-2 text-[color:var(--brand)]/60">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
          </div>
        )}
        {phone && error && !order && (
          <div className="mt-8 rounded-2xl bg-white ring-1 ring-black/5 p-6 text-[color:var(--brand)]/80">
            <AlertCircle className="inline h-4 w-4 mr-1" /> {error}
          </div>
        )}

        {order && journey && (
          <div className="mt-6 space-y-5">
            <div aria-live="polite">
              <h1 className="font-display text-4xl text-[color:var(--brand)]">
                {journey.special === "cancelled"
                  ? "Order cancelled"
                  : journey.special === "reconcile"
                    ? "Confirming your payment"
                    : journey.special === "payment_hold"
                      ? "Almost there"
                      : journey.currentStep.label === "Delivered"
                        ? "Delivered 🎉"
                        : journey.currentStep.label}
              </h1>
              <p className="mt-1 text-sm text-[color:var(--brand)]/70">{journey.methodLabel}</p>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[color:var(--brand)]/70">
                <div>
                  Ordered <span className="font-semibold">{fmtDate(order.created_at)}</span>
                </div>
                {order.delivery_state && (
                  <div>
                    Delivery to <span className="font-semibold">{order.delivery_state}</span>
                  </div>
                )}
                {order.scheduled_delivery_at && (
                  <div>
                    {order.is_preorder ? "Ready" : "Arriving"}{" "}
                    <span className="font-semibold">{fmtDate(order.scheduled_delivery_at)}</span>
                  </div>
                )}
              </dl>
              {order.is_preorder && !order.scheduled_delivery_at && journey.special === "none" && (
                <p className="mt-2 text-xs text-[color:var(--brand)]/60">
                  This is a preorder — we're making your bottles fresh and will message you on
                  WhatsApp as soon as they're ready.
                </p>
              )}
            </div>

            {journey.special === "payment_hold" && (
              <PaymentHoldBanner order={order} onResumed={() => phone && void load(phone)} />
            )}
            {journey.special === "reconcile" && (
              <div className="rounded-2xl bg-[color:var(--cream)]/70 p-5 ring-1 ring-black/5 text-sm text-[color:var(--brand)]/80">
                We've received your payment and we're just confirming the details. We'll message you
                shortly — no action needed.
              </div>
            )}

            {journey.special === "none" && (
              <div className="rounded-2xl bg-white ring-1 ring-black/5 p-6">
                <OrderTimeline steps={journey.steps} />
              </div>
            )}

            {journey.track === "live" && order.delivery && journey.special === "none" && (
              <RiderCard delivery={order.delivery} />
            )}

            <OrderSummaryCard
              items={order.items}
              subtotalNgn={order.subtotal_ngn}
              deliveryFeeNgn={order.delivery_fee_ngn}
              totalNgn={order.total_ngn}
            />

            {order.support_whatsapp && (
              <a
                href={order.support_whatsapp.url}
                target="_blank"
                rel="noreferrer"
                className="block w-full rounded-full bg-[#25D366] text-white px-6 py-3 text-center text-sm font-bold"
              >
                💬 Need help? WhatsApp us
              </a>
            )}
            <div className="flex flex-wrap gap-3">
              <Link
                to="/juices"
                className="rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold"
              >
                Order more
              </Link>
              <Link
                to="/"
                className="rounded-full bg-white ring-1 ring-black/10 text-[color:var(--brand)] px-6 py-3 text-sm font-semibold"
              >
                Back home
              </Link>
            </div>
          </div>
        )}
      </div>
    </SiteShell>
  );
}
