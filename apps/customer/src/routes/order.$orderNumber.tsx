import { useEffect, useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Check, Loader2, MapPin, Truck, CalendarClock, AlertCircle } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { formatNaira } from "@/lib/cart";
import { trackOrder } from "@/lib/api/server-fns";
import { ApiError } from "@/lib/api/client";
import type { ApiOrderTracking } from "@/lib/api/types";

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

function OrderPage() {
  const { orderNumber } = useParams({ from: "/order/$orderNumber" });
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [order, setOrder] = useState<ApiOrderTracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setPhone(storedPhone(orderNumber)); }, [orderNumber]);

  useEffect(() => {
    if (!phone) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setLoading(true);
      trackOrder({ data: { orderNumber, phone } })
        .then((o) => {
          if (!alive) return;
          setOrder(o);
          setError(null);
          if (o.payment_status === "pending") timer = setTimeout(tick, 5000); // poll until payment settles
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(e instanceof ApiError ? e.message : "Could not load this order. Check the phone number and try again.");
        })
        .finally(() => { if (alive) setLoading(false); });
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [orderNumber, phone]);

  const paid = order?.payment_status === "paid";

  return (
    <SiteShell>
      <div className="px-5 sm:px-10 max-w-2xl mx-auto pt-32 sm:pt-36 pb-24">
        <h1 className="font-display text-4xl sm:text-5xl text-[color:var(--brand)]">Your order</h1>
        <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-[color:var(--cream)]/80 px-4 py-1.5 text-xs font-mono">
          <span className="text-[color:var(--brand)]/60">Order</span><span className="font-bold text-[color:var(--brand)]">{orderNumber}</span>
        </div>

        {/* Need a phone to look the order up (e.g. opened on another device) */}
        {!phone && (
          <div className="mt-8 rounded-2xl bg-white ring-1 ring-black/5 p-6">
            <p className="text-sm text-[color:var(--brand)]/75">Enter the phone number on the order to view its status.</p>
            <div className="mt-3 flex gap-2">
              <input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="0800 000 0000" className="flex-1 rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none" />
              <button onClick={() => setPhone(phoneInput.replace(/[\s-]/g, ""))} className="rounded-xl bg-[color:var(--brand)] text-white px-5 text-sm font-semibold">View</button>
            </div>
          </div>
        )}

        {phone && loading && !order && (<div className="mt-10 flex items-center gap-2 text-[color:var(--brand)]/60"><Loader2 className="h-5 w-5 animate-spin" /> Loading…</div>)}
        {phone && error && (<div className="mt-8 rounded-2xl bg-white ring-1 ring-black/5 p-6 text-[color:var(--brand)]/80"><AlertCircle className="inline h-4 w-4 mr-1" /> {error}</div>)}

        {order && (
          <div className="mt-8 space-y-5">
            <div className="rounded-2xl bg-white ring-1 ring-black/5 p-6">
              <div className="flex items-center gap-3">
                <span className={`grid h-11 w-11 place-items-center rounded-full ${paid ? "bg-[color:var(--brand)] text-white" : "bg-[color:var(--brand-orange)]/15 text-[color:var(--brand-orange)]"}`}>
                  {paid ? <Check className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
                </span>
                <div>
                  <div className="font-display text-xl text-[color:var(--brand)]">{paid ? "Payment confirmed" : "Waiting for payment"}</div>
                  <div className="text-sm text-[color:var(--brand)]/60">Order status: {order.status}</div>
                </div>
              </div>

              {/* Delivery mode — outside Lagos / scheduled / live rider / preparing */}
              <div className="mt-5 rounded-xl bg-[color:var(--cream)]/60 p-4 text-sm text-[color:var(--brand)]/80">
                {order.delivery_state && order.delivery_state !== "Lagos" ? (
                  <p><MapPin className="inline h-4 w-4 mr-1" /> Outside Lagos ({order.delivery_state}) — we'll arrange delivery and confirm logistics with you separately.</p>
                ) : order.scheduled_delivery_at ? (
                  <p><CalendarClock className="inline h-4 w-4 mr-1" /> Scheduled for {new Date(order.scheduled_delivery_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })}.</p>
                ) : order.delivery ? (
                  <p>
                    <Truck className="inline h-4 w-4 mr-1" />
                    {order.delivery.rider_name ? `${order.delivery.rider_name} is handling your delivery` : "Rider dispatch in progress"}
                    {order.delivery.eta_minutes != null ? ` · ~${order.delivery.eta_minutes} min` : ""}.
                    {order.delivery.tracking_url ? <> <a className="font-semibold underline" href={order.delivery.tracking_url} target="_blank" rel="noreferrer">Track live</a></> : null}
                  </p>
                ) : (
                  <p><Truck className="inline h-4 w-4 mr-1" /> We're preparing your order for delivery within Lagos.</p>
                )}
              </div>

              <div className="mt-5 space-y-1.5 text-sm">
                <div className="flex justify-between text-[color:var(--brand)]/70"><span>Subtotal</span><span>{formatNaira(order.subtotal_ngn)}</span></div>
                <div className="flex justify-between text-[color:var(--brand)]/70"><span>Delivery</span><span>{order.delivery_fee_ngn === 0 ? "₦0" : formatNaira(order.delivery_fee_ngn)}</span></div>
                <div className="flex justify-between font-display text-xl pt-2 border-t border-black/5 text-[color:var(--brand)]"><span>Total</span><span>{formatNaira(order.total_ngn)}</span></div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link to="/juices" className="rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold">Order more</Link>
              <Link to="/" className="rounded-full bg-white ring-1 ring-black/10 text-[color:var(--brand)] px-6 py-3 text-sm font-semibold">Back home</Link>
            </div>
          </div>
        )}
      </div>
    </SiteShell>
  );
}
