import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  ArrowLeft, Check, Lock, Truck, ShoppingBag, AlertCircle, Loader2, CalendarClock,
} from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { useCart, formatNaira } from "@/lib/cart";
import { fetchBranches, requestQuote, placeOrder as placeOrderFn } from "@/lib/api/server-fns";
import { asApiError } from "@/lib/api/client";
import type { ApiDeliveryOption, ApiPlacedOrder } from "@/lib/api/types";
import { launchPayazaCheckout } from "@/lib/payaza";
import { NIGERIA_STATES } from "@/lib/nigeria-states";
import { scheduledIso, orderSchedule, type DeliveryWindow } from "@/lib/schedule";
import { deliveryPromise, isImmediateSchedule } from "@/lib/availability-label";
import { LIVE_COURIER_QUOTES } from "@/lib/flags";
import type { Size } from "@/lib/visuals";

export const Route = createFileRoute("/checkout")({
  head: () => ({
    meta: [
      { title: "Checkout — Mrs. Samuel Fruit Juice" },
      { name: "description", content: "Complete your Mrs. Samuel juice order. Lagos delivery now or scheduled; nationwide arranged separately. Pay securely with Payaza." },
    ],
  }),
  loader: async () => ({ branches: await fetchBranches() }),
  component: Page,
});

// Light client-side Nigerian-phone check; the API is the authority.
function validNgPhone(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "");
  return /^(\+?234|0)\d{9,10}$/.test(s);
}

function todayLagos(): string {
  // YYYY-MM-DD for "today" in Lagos (UTC+1).
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Parse the numeric ml value from a Size string like "650ml" → 650. */
function sizeToMl(size: Size): number {
  return parseInt(size, 10);
}

/** Format a YYYY-MM-DD date string as "Monday, 30 June 2026" (Lagos locale). */
function formatDeliveryDate(dateStr: string): string {
  // dateStr is already Lagos date; parse at noon Lagos time to avoid TZ shifts.
  const d = new Date(`${dateStr}T12:00:00+01:00`);
  return d.toLocaleDateString("en-NG", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    timeZone: "Africa/Lagos",
  });
}

function Page() {
  const { branches } = Route.useLoaderData();
  const { items, subtotal, clear } = useCart();
  // Route to the owner-selected online-fulfilment branch; fall back to the first
  // active branch when none is flagged (preserves prior behaviour).
  const branchId = (branches.find((b) => b.is_online_default) ?? branches[0])?.id ?? null;

  // --- form ---
  const [form, setForm] = useState({
    name: "", phone: "", email: "", altPhone: "", address: "", notes: "",
    state: "Lagos" as string,
    date: todayLagos(),
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((p) => ({ ...p, [k]: v }));

  const outsideLagos = form.state !== "Lagos";

  // --- compute delivery schedule from cart lines ---
  const lineKinds = useMemo(
    () => items.map((i) => ({ sizeMl: sizeToMl(i.size), inStock: !i.preorder })),
    [items],
  );
  const sched = useMemo(() => orderSchedule(new Date(), lineKinds), [lineKinds]);
  // Same-day in-stock orders go out today ASAP — no window to pick.
  const immediate = useMemo(() => isImmediateSchedule(sched), [sched]);

  // Chosen window: start from first selectable, or the fixed window.
  const [selectedWindow, setSelectedWindow] = useState<DeliveryWindow>(
    () => sched.fixedWindow ?? sched.selectableWindows[0] ?? "afternoon",
  );
  // Keep selection in sync if sched changes (e.g. items added/removed).
  useEffect(() => {
    const windows = sched.fixedWindow ? [] : sched.selectableWindows;
    if (sched.fixedWindow) {
      setSelectedWindow(sched.fixedWindow);
    } else if (!windows.includes(selectedWindow)) {
      setSelectedWindow(windows[0] ?? "afternoon");
    }
  }, [sched, selectedWindow]);

  // --- live delivery quote (Lagos + now only) ---
  const [quoting, setQuoting] = useState(false);
  const [options, setOptions] = useState<ApiDeliveryOption[]>([]);
  const [quoteNotice, setQuoteNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const wantQuote =
    LIVE_COURIER_QUOTES && !outsideLagos && form.address.trim().length >= 5 && !!branchId;

  useEffect(() => {
    if (!wantQuote) {
      setOptions([]); setQuoteNotice(null); setSelectedId(null); setQuoting(false);
      return;
    }
    let alive = true;
    setQuoting(true);
    const t = setTimeout(() => {
      requestQuote({ data: { branch_id: branchId as string, dropoff_address: form.address, delivery_state: form.state } })
        .then((q) => {
          if (!alive) return;
          setOptions(q.options);
          setQuoteNotice(q.options.length === 0 ? (q.notice ?? "We'll confirm your delivery cost and send it to you separately.") : null);
          setSelectedId(q.options[0]?.id ?? null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setOptions([]); setSelectedId(null);
          const qErr = asApiError(e);
          setQuoteNotice(qErr ? qErr.message : "We'll confirm your delivery cost and send it to you separately.");
        })
        .finally(() => { if (alive) setQuoting(false); });
    }, 600);
    return () => { alive = false; clearTimeout(t); };
  }, [wantQuote, branchId, form.address, form.state]);

  const selectedOption = options.find((o) => o.id === selectedId) ?? null;
  const deliveryFee =
    !LIVE_COURIER_QUOTES || outsideLagos ? 0 : (selectedOption?.fee_ngn ?? 0);
  const total = subtotal + deliveryFee;

  // --- placing the order ---
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const idemRef = useRef<string>("");

  // Schedule is always valid — orderSchedule already rolls forward off-hours/past windows.
  const scheduleValid = true;
  const orderItems = useMemo(
    () => items.map((i) => ({ variant_id: i.variantId, quantity: i.qty })),
    [items],
  );
  const canPlace =
    items.length > 0 &&
    !!branchId &&
    form.name.trim() !== "" &&
    validNgPhone(form.phone) &&
    form.address.trim().length >= 3 &&
    scheduleValid &&
    !placing &&
    !quoting;

  // Hand the (already-created) order to Payaza and route to tracking on success.
  // Shared by the normal path and the gracious-modal "Continue" path.
  async function proceedToPayment(order: ApiPlacedOrder) {
    const phone = form.phone.replace(/[\s-]/g, "");
    // Stash phone + placedAt so the tracking page AND the site-wide ongoing-
    // order banner can read the order back after Payaza (placedAt bounds the
    // banner's 48h self-prune).
    try {
      localStorage.setItem(
        `ms_track_${order.order_number}`,
        JSON.stringify({ phone, placedAt: new Date().toISOString() }),
      );
    } catch {
      /* ignore storage failures */
    }
    clear();
    // Payaza checkout is a client-side popup (no redirect). On success the
    // server webhook confirms payment; we just move to the tracking page.
    const trackUrl = `/order/${order.order_number}?paid=1`;
    await launchPayazaCheckout(order.payment.payaza, {
      onPaid: () => {
        window.location.href = trackUrl;
      },
      onClose: () => {
        // Popup dismissed without paying — order stays 'confirmed'; let the
        // customer retry or view the (unpaid) order.
        setPlacing(false);
      },
    });
  }

  async function submit(retry = false) {
    if (!branchId || items.length === 0) return;
    if (!retry) idemRef.current = crypto.randomUUID();
    setPlacing(true);
    setPlaceError(null);

    const phone = form.phone.replace(/[\s-]/g, "");
    const altPhone = form.altPhone.trim();
    // Chosen delivery window from the schedule-driven picker.
    const chosenWindow = sched.fixedWindow ?? selectedWindow;
    try {
      const res = await placeOrderFn({
        data: {
          branch_id: branchId,
          delivery_fee_ngn: 0,
          delivery_state: form.state,
          ...(selectedOption && !outsideLagos ? { delivery_quote_id: selectedOption.id } : {}),
          // Immediate (same-day in-stock) orders omit the window/schedule so the
          // API treats them as dispatch-now, not a scheduled slot.
          ...(immediate
            ? {}
            : {
                delivery_window: chosenWindow,
                scheduled_delivery_at: scheduledIso(sched.date, chosenWindow),
              }),
          customer: {
            name: form.name.trim(),
            phone,
            ...(form.email.trim() ? { email: form.email.trim() } : {}),
            ...(altPhone ? { alt_phone: altPhone } : {}),
            address: form.address.trim(),
          },
          items: orderItems,
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
          idempotency_key: idemRef.current,
        },
      });
      await proceedToPayment(res);
      return;
    } catch (e) {
      // placeOrder runs as a server function; the API's ApiError is serialized
      // across the RPC boundary and reconstructed here so we can branch on
      // code/status (the raw `e` is a plain Error on the client).
      const err = asApiError(e);
      if (err && err.code === "idempotency_in_flight") {
        setTimeout(() => submit(true), 1500); // first attempt still settling — replay same key
        return;
      }
      if (err && err.code === "idempotency_key_reused") {
        await submit(false); // body changed under the same key — fresh attempt
        return;
      }
      if (err && (err.code === "conflict" || err.status === 422)) {
        // Stock/validation conflict — the API message explains (e.g. "only N left").
        setPlaceError(`${err.message} Adjust your basket and try again.`);
      } else {
        setPlaceError(err ? err.message : "Something went wrong placing your order. Please try again.");
      }
      setPlacing(false);
    }
  }

  // ---------- render ----------
  if (items.length === 0) {
    return (
      <SiteShell>
        <div className="px-5 max-w-3xl mx-auto pt-40 pb-32 text-center">
          <div className="text-7xl mb-4">🥤</div>
          <h1 className="font-display text-4xl text-[color:var(--brand)]">Your basket is empty</h1>
          <p className="mt-3 text-[color:var(--brand)]/70">Pick a juice or a bundle to get started.</p>
          <div className="mt-6 flex justify-center gap-3">
            <Link to="/juices" className="rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold">Browse juices</Link>
            <Link to="/shop" className="rounded-full bg-white ring-1 ring-black/10 text-[color:var(--brand)] px-6 py-3 text-sm font-semibold">Bundles</Link>
          </div>
        </div>
      </SiteShell>
    );
  }

  return (
    <SiteShell>
      <div className="px-5 sm:px-10 max-w-6xl mx-auto pt-32 sm:pt-36 pb-24">
        <Link to="/juices" className="inline-flex items-center gap-2 text-sm font-semibold text-[color:var(--brand)]/70 hover:text-[color:var(--brand-orange)]">
          <ArrowLeft className="h-4 w-4" /> Continue shopping
        </Link>
        <div className="mt-6 flex items-center justify-between gap-3">
          <h1 className="font-display text-4xl sm:text-5xl text-[color:var(--brand)]">Checkout</h1>
          <div className="hidden sm:flex items-center gap-2 text-xs text-[color:var(--brand)]/60"><Lock className="h-3.5 w-3.5" /> Secure order</div>
        </div>

        {!branchId && (
          <div className="mt-10 rounded-2xl bg-white ring-1 ring-black/5 p-8 text-center text-[color:var(--brand)]/80">
            Online ordering is temporarily unavailable. Please try again later or order on WhatsApp.
          </div>
        )}

        {branchId && (
          <div className="mt-8 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-8">
            {/* LEFT: form */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-[1.5rem] bg-white ring-1 ring-black/5 p-6 sm:p-8 space-y-8">
              {/* Contact */}
              <section>
                <h2 className="font-display text-2xl text-[color:var(--brand)]">Delivery details</h2>
                <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="Full name" value={form.name} onChange={(v) => set("name", v)} placeholder="Adaeze Okeke" />
                  <Field label="Phone" value={form.phone} onChange={(v) => set("phone", v)} placeholder="0800 000 0000" invalid={form.phone !== "" && !validNgPhone(form.phone)} hint="Enter a valid Nigerian number" />
                  <Field label="Email (optional)" value={form.email} onChange={(v) => set("email", v)} placeholder="you@email.com" className="sm:col-span-2" />
                  <Field label="Delivery address" value={form.address} onChange={(v) => set("address", v)} placeholder="House no, street, area" className="sm:col-span-2" />
                  <label className="block sm:col-span-2">
                    <span className="block text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55 mb-1.5">Delivery state</span>
                    <select value={form.state} onChange={(e) => set("state", e.target.value)} className="w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm text-[color:var(--brand)] ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none">
                      {NIGERIA_STATES.map((s) => (<option key={s} value={s}>{s}</option>))}
                    </select>
                  </label>
                  <Field label="Alternate phone (optional)" value={form.altPhone} onChange={(v) => set("altPhone", v)} placeholder="Second number to reach you" className="sm:col-span-2" />
                  <Field label="Notes (optional)" value={form.notes} onChange={(v) => set("notes", v)} placeholder="Gate code, landmark…" className="sm:col-span-2" />
                </div>
              </section>

              {/* When — schedule-driven delivery date & window picker */}
              <section>
                <h2 className="font-display text-2xl text-[color:var(--brand)]">{immediate ? "Delivery" : "Delivery window"}</h2>
                <div className="mt-4 rounded-2xl bg-[color:var(--cream)]/60 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarClock className="h-4 w-4 text-[color:var(--brand-orange)] shrink-0" />
                    <span className="font-semibold text-[color:var(--brand)]">{formatDeliveryDate(sched.date)}</span>
                  </div>
                  {immediate ? (
                    <div className="flex items-center gap-2 text-sm text-[color:var(--brand)]/70">
                      <Truck className="h-4 w-4 shrink-0" />
                      <span>Delivered today — as soon as possible. No window to pick.</span>
                    </div>
                  ) : sched.fixedWindow ? (
                    <div className="flex items-center gap-2 text-sm text-[color:var(--brand)]/70">
                      <Truck className="h-4 w-4 shrink-0" />
                      <span>
                        {sched.fixedWindow === "morning" && "Morning · 8am–12pm"}
                        {sched.fixedWindow === "afternoon" && "Afternoon · 12–4pm"}
                        {sched.fixedWindow === "evening" && "Evening · 4–8pm"}
                      </span>
                    </div>
                  ) : (
                    <div>
                      <span className="block text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55 mb-2">Pick a window</span>
                      <div className="grid grid-cols-3 gap-2">
                        {(["morning", "afternoon", "evening"] as DeliveryWindow[]).map((w) => {
                          const isSelectable = sched.selectableWindows.includes(w);
                          const active = selectedWindow === w;
                          const label = w === "morning" ? "Morning" : w === "afternoon" ? "Afternoon" : "Evening";
                          return (
                            <button
                              key={w}
                              disabled={!isSelectable}
                              onClick={() => setSelectedWindow(w)}
                              className={`rounded-xl px-2 py-2 text-xs font-semibold ring-1 transition ${active && isSelectable ? "bg-[color:var(--brand)] text-white ring-transparent" : "bg-white text-[color:var(--brand)] ring-black/10"} ${!isSelectable ? "opacity-30 cursor-not-allowed" : ""}`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-xs text-[color:var(--brand)]/55">
                        {selectedWindow === "morning" && "8am–12pm"}
                        {selectedWindow === "afternoon" && "12–4pm"}
                        {selectedWindow === "evening" && "4–8pm"}
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-[color:var(--brand)]/60 pt-1 border-t border-black/5">
                    Delivery cost will be confirmed and sent to you separately.
                  </p>
                </div>
              </section>

              {/* Delivery cost (kept for live-quotes path; hidden when LIVE_COURIER_QUOTES is off) */}
              {LIVE_COURIER_QUOTES && !outsideLagos && (
                <section>
                  <h2 className="font-display text-2xl text-[color:var(--brand)]">Delivery fee</h2>
                  {quoting ? (
                    <div className="mt-3 flex items-center gap-2 text-sm text-[color:var(--brand)]/60"><Loader2 className="h-4 w-4 animate-spin" /> Finding couriers…</div>
                  ) : options.length > 0 ? (
                    <div className="mt-3 grid gap-2">
                      {options.map((o) => {
                        const active = o.id === selectedId;
                        return (
                          <button key={o.id} onClick={() => setSelectedId(o.id)} className={`flex items-center justify-between rounded-2xl px-4 py-3 text-left ring-2 transition ${active ? "ring-[color:var(--brand-orange)] bg-[color:var(--brand-orange)]/5" : "ring-black/5 hover:ring-black/15"}`}>
                            <div>
                              <div className="font-semibold text-[color:var(--brand)]">{o.courier_name}</div>
                              <div className="text-xs text-[color:var(--brand)]/60">{o.eta_minutes != null ? `~${o.eta_minutes} min` : "ETA on dispatch"}{o.on_demand ? " · on-demand" : ""}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-[color:var(--brand)]">{formatNaira(o.fee_ngn)}</span>
                              {active && <Check className="h-4 w-4 text-[color:var(--brand-orange)]" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-2xl bg-[color:var(--cream)]/60 p-4 text-sm text-[color:var(--brand)]/75">
                      {form.address.trim().length >= 5 ? (quoteNotice ?? "Delivery cost will be confirmed and sent to you separately.") : "Enter your address to continue."}
                    </p>
                  )}
                </section>
              )}
            </motion.div>

            {/* RIGHT: summary */}
            <aside className="rounded-[1.5rem] bg-[color:var(--brand)] text-white p-6 sm:p-7 h-fit lg:sticky lg:top-28">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-white/60"><ShoppingBag className="h-3.5 w-3.5" /> Order summary</div>
              <div className="mt-5 space-y-3">
                {items.map((it) => {
                  const stock = it.product.availableBySize[it.size] ?? 0;
                  return (
                    <div key={it.id} className="flex items-start gap-3 text-sm">
                      <div className="grid h-12 w-12 place-items-center rounded-lg shrink-0 bg-white/10"><img src={it.product.image} alt="" className="h-10 w-10 object-contain" /></div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate">{it.product.name}</div>
                        <div className="text-xs text-white/60">{it.size} · ×{it.qty}</div>
                        <div className={`mt-0.5 text-[11px] ${stock > 0 ? "text-white/50" : "text-[color:var(--brand-orange)] font-medium"}`}>
                          {stock > 0 ? `${stock} in stock` : deliveryPromise(it.size, 0)}
                        </div>
                      </div>
                      <div className="font-semibold shrink-0">{formatNaira(it.unitPrice * it.qty)}</div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-5 pt-5 border-t border-white/10 space-y-2 text-sm">
                <Row label="Subtotal" value={formatNaira(subtotal)} />
                <Row label="Delivery" value={!LIVE_COURIER_QUOTES || outsideLagos ? "₦0" : selectedOption ? formatNaira(deliveryFee) : "—"} />
                <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.2em] text-white/60">Total</span>
                  <span className="font-display text-2xl font-semibold">{formatNaira(total)}</span>
                </div>
              </div>

              {placeError && (
                <div className="mt-4 rounded-xl bg-white/10 p-3 text-sm">
                  <div className="flex items-center gap-2 font-semibold"><AlertCircle className="h-4 w-4" /> {placeError}</div>
                  <button onClick={() => submit(false)} className="mt-2 text-xs font-semibold underline">Retry payment</button>
                </div>
              )}

              <button
                disabled={!canPlace}
                onClick={() => submit(false)}
                className="mt-5 w-full rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-4 text-sm font-bold disabled:opacity-40 hover:opacity-90 transition flex items-center justify-center gap-2"
              >
                {placing ? (<><Loader2 className="h-4 w-4 animate-spin" /> Opening payment…</>) : (<>Place order — {formatNaira(total)}</>)}
              </button>
              <p className="mt-2 text-center text-[11px] text-white/50">You'll pay securely via Payaza.</p>
            </aside>
          </div>
        )}
      </div>
    </SiteShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (<div className="flex items-center justify-between text-white/80"><span>{label}</span><span className="font-semibold text-white">{value}</span></div>);
}

function Field({ label, value, onChange, placeholder, className, invalid, hint }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string; invalid?: boolean; hint?: string }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="block text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55 mb-1.5">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm text-[color:var(--brand)] placeholder-[color:var(--brand)]/40 ring-1 focus:ring-2 focus:outline-none transition ${invalid ? "ring-[color:var(--brand-orange)]/60 focus:ring-[color:var(--brand-orange)]" : "ring-black/5 focus:ring-[color:var(--brand-orange)]"}`} />
      {invalid && hint && <span className="mt-1 block text-xs text-[color:var(--brand-orange)]">{hint}</span>}
    </label>
  );
}
