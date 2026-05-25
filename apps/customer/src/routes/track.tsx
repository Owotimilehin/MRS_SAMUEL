import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SiteLayout } from "../components/SiteLayout.js";
import { Button, Eyebrow } from "../components/ui/index.js";

export function TrackPage(): JSX.Element {
  const nav = useNavigate();
  const [orderNumber, setOrderNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!orderNumber || !phone) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/v1/public/orders/${encodeURIComponent(orderNumber)}?phone=${encodeURIComponent(phone)}`,
      );
      if (!res.ok) {
        setError("We couldn't find that order. Check the number and the phone you used.");
        setSubmitting(false);
        return;
      }
      try {
        sessionStorage.setItem(`ms_order_phone_${orderNumber}`, phone);
      } catch {
        /* private mode */
      }
      void nav({ to: "/order/$orderNumber", params: { orderNumber } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <SiteLayout
      meta={{
        title: "Track order · Mrs. Samuel",
        description: "Look up the status of your Mrs. Samuel order.",
      }}
    >
      <main className="ms-track-lookup ms-container">
        <header style={{ textAlign: "center", marginBottom: 28 }}>
          <Eyebrow>Track your order</Eyebrow>
          <h1 className="ms-section-title">Where's my juice?</h1>
          <p className="ms-section-sub" style={{ maxWidth: 480, margin: "0 auto" }}>
            Enter your order number and the phone you used at checkout.
          </p>
        </header>
        <form onSubmit={onSubmit} className="ms-track-lookup__form">
          <label className="ms-track-lookup__field">
            <span>Order number</span>
            <input
              className="ms-checkout__input"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value.trim().toUpperCase())}
              placeholder="MS-2026-…"
              required
              autoFocus
            />
          </label>
          <label className="ms-track-lookup__field">
            <span>Phone number</span>
            <input
              className="ms-checkout__input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+234…"
              inputMode="tel"
              required
            />
          </label>
          {error && <div className="ms-checkout__error">{error}</div>}
          <Button
            variant="primary"
            disabled={submitting || !orderNumber || !phone}
            {...({ type: "submit" } as React.ButtonHTMLAttributes<HTMLButtonElement>)}
          >
            {submitting ? "Looking…" : "Find my order"}
          </Button>
        </form>
      </main>
    </SiteLayout>
  );
}
