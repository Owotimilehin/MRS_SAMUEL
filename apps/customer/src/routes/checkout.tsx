import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useCart } from "../store/cart.js";
import { api, ngn } from "../lib/api.js";

interface Zone {
  branch_id: string;
  branch_name: string;
  name: string;
  fee_ngn: number;
}

interface OrderResponse {
  data: {
    order_number: string;
    total_ngn: number;
    payment: { authorization_url: string };
  };
}

export function CheckoutPage(): JSX.Element {
  const cart = useCart();
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ data: Zone[] }>("/catalog/zones").then((r) => {
      setZones(r.data);
      if (r.data[0]) setSelectedZone(r.data[0]);
    });
  }, []);

  const subtotal = cart.subtotal();
  const delivery = selectedZone?.fee_ngn ?? 0;
  const total = subtotal + delivery;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!selectedZone) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<OrderResponse>("/orders", {
        method: "POST",
        body: JSON.stringify({
          branch_id: selectedZone.branch_id,
          zone_name: selectedZone.name,
          delivery_fee_ngn: selectedZone.fee_ngn,
          customer: {
            name: form.name,
            phone: form.phone,
            email: form.email || undefined,
            address: form.address,
          },
          items: cart.items.map((i) => ({
            product_id: i.product_id,
            quantity: i.quantity,
          })),
        }),
      });
      cart.clear();
      // Stash the phone so the tracking page can use it without asking again
      sessionStorage.setItem(
        `track:${res.data.order_number}`,
        form.phone,
      );
      window.location.href = res.data.payment.authorization_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (cart.items.length === 0) {
    return (
      <main className="max-w-2xl mx-auto py-20 px-6 text-center">
        <p className="mb-4" style={{ color: "var(--ms-ink-3)" }}>Your cart is empty.</p>
        <Link
          to="/"
          className="inline-block px-6 py-3 rounded-full text-white font-bold no-underline"
          style={{ background: "var(--ms-green-500)" }}
        >
          Back to menu
        </Link>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto py-12 px-6">
      <Link
        to="/cart"
        className="text-sm no-underline mb-6 inline-block"
        style={{ color: "var(--ms-ink-3)" }}
      >
        ← Back to cart
      </Link>
      <h1 className="font-display text-3xl font-bold mb-6">Checkout</h1>

      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Full name">
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
        <Field label="Phone (for delivery)">
          <input
            required
            type="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="+234 …"
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
        <Field label="Email (for receipt — optional)">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
        <Field label="Delivery address">
          <input
            required
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>

        <Field label="Delivery zone">
          {!zones ? (
            <p style={{ color: "var(--ms-ink-3)" }}>Loading…</p>
          ) : (
            <div className="grid gap-2">
              {zones.map((z) => (
                <label
                  key={`${z.branch_id}-${z.name}`}
                  className="flex items-center gap-3 p-3 rounded-lg cursor-pointer"
                  style={{
                    background:
                      selectedZone?.name === z.name && selectedZone?.branch_id === z.branch_id
                        ? "var(--ms-bg)"
                        : "white",
                    border:
                      selectedZone?.name === z.name && selectedZone?.branch_id === z.branch_id
                        ? "1px solid var(--ms-green-500)"
                        : "1px solid var(--ms-border)",
                  }}
                >
                  <input
                    type="radio"
                    name="zone"
                    checked={selectedZone?.name === z.name && selectedZone?.branch_id === z.branch_id}
                    onChange={() => setSelectedZone(z)}
                  />
                  <div className="flex-1">
                    <div className="font-semibold">{z.name}</div>
                    <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
                      from {z.branch_name}
                    </div>
                  </div>
                  <div className="font-display font-bold tabular-nums">{ngn(z.fee_ngn)}</div>
                </label>
              ))}
            </div>
          )}
        </Field>

        <div
          className="rounded-xl p-4"
          style={{ background: "white", border: "1px solid var(--ms-border)" }}
        >
          <div className="flex justify-between text-sm mb-1">
            <span style={{ color: "var(--ms-ink-3)" }}>Subtotal</span>
            <span className="tabular-nums">{ngn(subtotal)}</span>
          </div>
          <div className="flex justify-between text-sm mb-2">
            <span style={{ color: "var(--ms-ink-3)" }}>Delivery</span>
            <span className="tabular-nums">{ngn(delivery)}</span>
          </div>
          <div
            className="flex justify-between font-display text-xl font-bold pt-2"
            style={{ borderTop: "1px dashed var(--ms-border)" }}
          >
            <span>Total</span>
            <span className="tabular-nums">{ngn(total)}</span>
          </div>
        </div>

        {error && (
          <p
            className="p-3 rounded-md text-sm"
            style={{ background: "#ffe1de", color: "#8a2018" }}
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !selectedZone}
          className="w-full py-4 rounded-full text-white font-bold disabled:opacity-50"
          style={{ background: "var(--ms-ink)" }}
        >
          {submitting ? "Redirecting to Payaza…" : `Pay ${ngn(total)} →`}
        </button>

        <p className="text-xs text-center" style={{ color: "var(--ms-ink-3)" }}>
          You'll be redirected to Payaza to complete payment. We'll text you when the bottles are
          on their way.
        </p>
      </form>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span
        className="block text-xs font-semibold mb-1"
        style={{ color: "var(--ms-ink-2)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
