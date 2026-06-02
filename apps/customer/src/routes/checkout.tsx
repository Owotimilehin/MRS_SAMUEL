import { useEffect, useState, type FormEvent } from "react";
import { cart as cartApi } from "../store/cart.js";
import { Link } from "@tanstack/react-router";
import { useCart } from "../store/cart.js";
import { api, ngn } from "../lib/api.js";
import { BRAND } from "../data/menu.js";
import { Button, Eyebrow } from "../components/ui/index.js";

interface Branch {
  id: string;
  name: string;
  delivery_zones: { name: string; fee_ngn: number }[];
}
interface CreateOrderResp {
  data: {
    id: string;
    order_number: string;
    total_ngn: number;
    payment: {
      authorization_url: string;
      reference: string;
    };
  };
}


// Lagos first (default); the rest alphabetical. Any value other than "Lagos"
// makes the order "outside Lagos" — delivery is ₦0 and arranged out-of-band.
const NG_STATES = [
  "Lagos",
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue",
  "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu",
  "Abuja (FCT)", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina",
  "Kebbi", "Kogi", "Kwara", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun",
  "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
] as const;

export function CheckoutPage(): JSX.Element {
  // Re-fetch the cart on mount so a refresh / direct visit shows live state.
  useEffect(() => {
    void cartApi.refresh().catch(() => undefined);
  }, []);

  const items = useCart((s) => s.items);
  const subtotal = useCart((s) => s.subtotal());
  const clear = useCart((s) => s.clear);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [loadingRef, setLoadingRef] = useState(true);
  const [refError, setRefError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [deliveryState, setDeliveryState] = useState("Lagos");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live delivery quote (Bolt). Refreshed when address or coords change.
  const [quote, setQuote] = useState<{
    provider: string;
    provider_quote_id: string | null;
    fee_ngn: number;
    eta_minutes: number;
    notice?: string;
  } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingRef(true);
    void (async () => {
      try {
        const b = await api<{ data: Branch[] }>("/catalog/branches");
        if (cancelled) return;
        setBranches(b.data);
      } catch (err) {
        if (!cancelled) {
          setRefError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoadingRef(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Server cart already exposes variant UUIDs — no slug-matching needed.
  // Order submit reads from the cookie-keyed cart on the server, so we don't
  // even need to send items[]; the API resolves them from the cart row.
  const unmatched: { name: string }[] = [];
  // Single active kitchen — auto-picked, no branch UI. Its delivery zones are
  // kept only as the static fallback fee when the live Bolt quote is down.
  const branch = branches[0] ?? null;
  const branchId = branch?.id ?? "";
  const fallbackFee =
    branch && branch.delivery_zones.length > 0
      ? Math.min(...branch.delivery_zones.map((z) => z.fee_ngn))
      : null;
  const outsideLagos = deliveryState !== "Lagos";

  // Live delivery-fee quote. Refreshes when address text is stable for 800ms
  // OR coords change. Requires a branch + an address. Aborts on stale calls.
  useEffect(() => {
    if (outsideLagos || !branchId || !address || address.trim().length < 4) {
      setQuote(null);
      return;
    }
    setQuoteLoading(true);
    const abort = new AbortController();
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const body: Record<string, unknown> = {
            branch_id: branchId,
            dropoff_address: address,
          };
          if (coords) {
            body["dropoff_lat"] = coords.lat;
            body["dropoff_lng"] = coords.lng;
          }
          const res = await fetch("/v1/public/orders/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: abort.signal,
          });
          if (!res.ok) throw new Error(`quote ${res.status}`);
          const data = (await res.json()) as {
            data: {
              provider: string;
              provider_quote_id: string | null;
              fee_ngn: number;
              eta_minutes: number;
              notice?: string;
            };
          };
          if (!abort.signal.aborted) setQuote(data.data);
        } catch (err) {
          if (!abort.signal.aborted) {
            // Quote failed entirely — fall back silently to the static zone fee.
            setQuote(null);
            console.warn("delivery quote failed", err);
          }
        } finally {
          if (!abort.signal.aborted) setQuoteLoading(false);
        }
      })();
    }, 800);
    return () => {
      window.clearTimeout(handle);
      abort.abort();
    };
  }, [outsideLagos, branchId, address, coords?.lat, coords?.lng]);

  function useMyLocation(): void {
    if (!navigator.geolocation) {
      setGeoError("Your browser doesn't support location.");
      return;
    }
    setGeoLoading(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoLoading(false);
      },
      (err) => {
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Type your address instead."
            : "Couldn't get your location. Type your address instead.",
        );
        setGeoLoading(false);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }
  // Outside Lagos → ₦0 (arranged out-of-band). In Lagos → the live Bolt quote,
  // falling back to the branch's static zone fee if the quote is unavailable.
  const lagosFee = quote?.fee_ngn ?? fallbackFee;
  const deliveryFee = outsideLagos ? 0 : lagosFee ?? 0;
  // Lagos orders need a known fee before the customer can pay.
  const feeReady = outsideLagos || lagosFee != null;
  const total = subtotal + deliveryFee;

  const scheduledIso =
    scheduleMode === "later" && scheduledAt ? new Date(scheduledAt).toISOString() : null;
  const scheduledValid =
    scheduleMode === "now" ||
    (scheduledIso != null && new Date(scheduledIso).getTime() > Date.now());
  const minDateTime = (() => {
    const d = new Date(Date.now() + 60_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  // Pickup branch is the single active kitchen (needed even outside Lagos).
  const pickupBranchId = branchId;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting || !pickupBranchId || !scheduledValid || (!outsideLagos && !feeReady)) return;
    setSubmitting(true);
    setError(null);
    try {
      // No items[] payload — the server reads the cart from the ms_cart cookie.
      const res = await api<CreateOrderResp>("/orders", {
        method: "POST",
        body: JSON.stringify({
          branch_id: pickupBranchId,
          delivery_fee_ngn: deliveryFee,
          delivery_state: deliveryState,
          ...(quote?.provider_quote_id && !outsideLagos
            ? { delivery_quote_id: quote.provider_quote_id }
            : {}),
          ...(scheduledIso ? { scheduled_delivery_at: scheduledIso } : {}),
          customer: {
            name,
            phone,
            email: email || undefined,
            address,
            ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
          },
          notes: notes || undefined,
        }),
      });
      // Stash details for the tracking page
      try {
        sessionStorage.setItem(
          `ms_order_phone_${res.data.order_number}`,
          phone,
        );
      } catch {
        /* private mode — fine, the user can re-enter */
      }
      clear();
      window.location.href = res.data.payment.authorization_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="ms-shell">
        <div className="ms-container">
          <CheckoutHeader />
          <main className="ms-checkout">
            <div className="ms-cart__empty">
              <Eyebrow>Checkout</Eyebrow>
              <h1 className="ms-section-title">Your basket is empty.</h1>
              <p className="ms-section-sub">Add a bottle first, then come back to check out.</p>
              <Link to="/" className="btn btn--primary">
                Browse the menu
              </Link>
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="ms-shell">
      <div className="ms-container">
        <CheckoutHeader />
        <main className="ms-checkout">
          <header style={{ marginBottom: 22 }}>
            <Eyebrow>Checkout</Eyebrow>
            <h1 className="ms-section-title">Where should we deliver?</h1>
            <p className="ms-section-sub">
              {outsideLagos
                ? "Book and pay now — we'll arrange delivery to your state and confirm logistics separately."
                : scheduleMode === "later"
                  ? "Book and pay now — we'll prepare your order fresh and deliver it at your chosen time."
                  : "We'll take a deposit now and dispatch within the hour. Pay with card or transfer on the next screen."}
            </p>
          </header>

          {refError && (
            <div className="ms-checkout__error" role="alert">
              Couldn't load delivery options — {refError}
            </div>
          )}

          <form onSubmit={submit} className="ms-checkout__grid">
            <section className="ms-checkout__form">
              <h2 className="ms-checkout__h2">Your details</h2>
              <div className="ms-checkout__row">
                <Field label="Full name" required>
                  <input
                    className="ms-checkout__input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                  />
                </Field>
                <Field label="Phone" required>
                  <input
                    className="ms-checkout__input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+234…"
                  />
                </Field>
              </div>
              <Field label="Email (optional)">
                <input
                  className="ms-checkout__input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </Field>

              <h2 className="ms-checkout__h2" style={{ marginTop: 22 }}>
                Delivery
              </h2>

              <Field label="When?">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={`btn btn--sm ${scheduleMode === "now" ? "btn--primary" : "btn--subtle"}`}
                    onClick={() => setScheduleMode("now")}
                  >
                    Deliver now
                  </button>
                  <button
                    type="button"
                    className={`btn btn--sm ${scheduleMode === "later" ? "btn--primary" : "btn--subtle"}`}
                    onClick={() => setScheduleMode("later")}
                  >
                    Schedule for later
                  </button>
                </div>
                {scheduleMode === "later" && (
                  <input
                    className="ms-checkout__input"
                    style={{ marginTop: 8 }}
                    type="datetime-local"
                    min={minDateTime}
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    required
                  />
                )}
                {scheduleMode === "later" && !scheduledValid && scheduledAt && (
                  <div className="ms-checkout__hint" style={{ color: "var(--warning)" }}>
                    Pick a time in the future.
                  </div>
                )}
              </Field>

              <Field label="Delivery state" required>
                <select
                  className="ms-checkout__input"
                  value={deliveryState}
                  onChange={(e) => setDeliveryState(e.target.value)}
                  required
                >
                  {NG_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {outsideLagos && (
                  <div className="ms-checkout__hint">
                    Outside Lagos — we'll arrange delivery to {deliveryState} and confirm
                    logistics separately. No delivery fee charged now.
                  </div>
                )}
              </Field>

              <Field label="Address" required>
                <textarea
                  className="ms-checkout__input"
                  rows={2}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  required
                  autoComplete="street-address"
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={useMyLocation}
                    disabled={geoLoading}
                    style={{ fontSize: 12 }}
                  >
                    {geoLoading
                      ? "Locating…"
                      : coords
                        ? "✓ Using my location"
                        : "📍 Use my location"}
                  </button>
                  {geoError && (
                    <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{geoError}</span>
                  )}
                  {coords && (
                    <button
                      type="button"
                      onClick={() => setCoords(null)}
                      style={{
                        background: "transparent",
                        border: 0,
                        color: "var(--ink-soft)",
                        fontSize: 12,
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </Field>
              <Field label="Notes for the rider (optional)">
                <textarea
                  className="ms-checkout__input"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Gate code, landmark, etc."
                />
              </Field>
            </section>

            <aside className="ms-checkout__summary">
              <h2 className="ms-cart__summary-title">Order</h2>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                {items.map((it) => (
                  <li key={it.product_id} className="ms-checkout__sumline">
                    <span>
                      {it.name} <span style={{ color: "var(--ink-soft)" }}>× {it.quantity}</span>
                    </span>
                    <span className="tabular-nums">{ngn(it.unit_price_ngn * it.quantity)}</span>
                  </li>
                ))}
              </ul>
              <div className="ms-cart__divider" />
              <div className="ms-cart__row">
                <span>Subtotal</span>
                <span className="tabular-nums">{ngn(subtotal)}</span>
              </div>
              <div className="ms-cart__row">
                <span>
                  Delivery
                  {quote?.provider === "bolt" && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--accent)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      · Bolt
                    </span>
                  )}
                  {quoteLoading && (
                    <span style={{ marginLeft: 6, fontSize: 12, color: "var(--ink-soft)" }}>
                      updating…
                    </span>
                  )}
                </span>
                <span className="tabular-nums">{feeReady ? ngn(deliveryFee) : "—"}</span>
              </div>
              {outsideLagos ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-soft)",
                    marginTop: -4,
                    marginBottom: 6,
                  }}
                >
                  Delivery to {deliveryState} arranged separately — ₦0 charged now.
                </div>
              ) : scheduleMode === "later" && scheduledIso ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--accent)",
                    fontWeight: 600,
                    marginTop: -4,
                    marginBottom: 6,
                  }}
                >
                  Scheduled for{" "}
                  {new Date(scheduledIso).toLocaleString("en-NG", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
              ) : (
                quote?.eta_minutes && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-soft)",
                      marginTop: -4,
                      marginBottom: 6,
                    }}
                  >
                    ETA ~{quote.eta_minutes} min from confirmation
                  </div>
                )
              )}
              {quote?.notice && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--warning)",
                    marginTop: -4,
                    marginBottom: 6,
                  }}
                >
                  {quote.notice}
                </div>
              )}
              <div className="ms-cart__divider" />
              <div className="ms-cart__row">
                <span style={{ fontWeight: 700 }}>Total</span>
                <span className="tabular-nums" style={{ fontWeight: 800, fontSize: 22 }}>
                  {ngn(total)}
                </span>
              </div>

              {error && (
                <div className="ms-checkout__error" style={{ marginTop: 12 }}>
                  {error}
                </div>
              )}

              <Button
                variant="primary"
                className="ms-cart__cta"
                style={{ marginTop: 16 }}
                disabled={
                  submitting ||
                  loadingRef ||
                  !pickupBranchId ||
                  !name ||
                  !phone ||
                  !address ||
                  !scheduledValid ||
                  (!outsideLagos && !feeReady)
                }
                {...({ type: "submit" } as React.ButtonHTMLAttributes<HTMLButtonElement>)}
              >
                {submitting ? "Creating order…" : `Pay ${ngn(total)}`}
              </Button>
              <p className="ms-cart__fineprint">
                You'll be taken to a secure Payaza page. Prefer WhatsApp?{" "}
                <a
                  href={`https://wa.me/${BRAND.whatsapp}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)", fontWeight: 600 }}
                >
                  Order there instead
                </a>
                .
              </p>
            </aside>
          </form>
        </main>
      </div>
    </div>
  );
}

function CheckoutHeader(): JSX.Element {
  return (
    <nav className="ms-nav">
      <Link to="/" className="ms-brand">
        <span className="ms-brand__logo">
          <img src="/assets/brand-logo.png" alt={BRAND.name} />
        </span>
      </Link>
      <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
        Checkout
      </span>
      <div />
    </nav>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="ms-checkout__field">
      <span className="ms-checkout__label">
        {label}
        {required && <span style={{ color: "var(--accent)" }}> *</span>}
      </span>
      {children}
    </label>
  );
}
