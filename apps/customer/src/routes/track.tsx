import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { api, ngn } from "../lib/api.js";

interface TrackData {
  order_number: string;
  status: string;
  payment_status: string;
  total_ngn: number;
  channel: string;
  created_at: string;
}

const STATUS_LABEL: Record<string, { label: string; tone: string; emoji: string }> = {
  draft: { label: "Draft", tone: "var(--ms-ink-3)", emoji: "📝" },
  confirmed: { label: "Order received", tone: "var(--ms-orange)", emoji: "📨" },
  paid: { label: "Payment received · bottling now", tone: "var(--ms-green-700)", emoji: "🥤" },
  handed_over: { label: "Out for delivery", tone: "var(--ms-orange)", emoji: "🛵" },
  delivered: { label: "Delivered", tone: "var(--ms-green-700)", emoji: "✅" },
  failed: { label: "Payment failed", tone: "var(--ms-danger)", emoji: "❌" },
  cancelled: { label: "Cancelled", tone: "var(--ms-ink-3)", emoji: "✕" },
  reconcile_needed: { label: "Pending review", tone: "var(--ms-orange)", emoji: "⏳" },
};

export function TrackPage({ orderNumber }: { orderNumber: string }): JSX.Element {
  const [phone, setPhone] = useState(() => sessionStorage.getItem(`track:${orderNumber}`) ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [data, setData] = useState<TrackData | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(p: string): Promise<void> {
    try {
      setError(null);
      const r = await api<{ data: TrackData }>(
        `/orders/${orderNumber}?phone=${encodeURIComponent(p)}`,
      );
      setData(r.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (phone) {
      setSubmitted(true);
      void load(phone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for status changes once every 15s while we have a successful lookup
  useEffect(() => {
    if (!data) return;
    const id = setInterval(() => void load(phone), 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!submitted) {
    return (
      <main className="max-w-md mx-auto py-20 px-6">
        <h1 className="font-display text-3xl font-bold mb-2">Track order</h1>
        <p className="mb-6" style={{ color: "var(--ms-ink-3)" }}>
          Enter the phone number you used at checkout.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            void load(phone);
          }}
          className="flex flex-col gap-4"
        >
          <input
            type="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+234 …"
            className="w-full px-3 py-3 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
          <button
            type="submit"
            className="w-full py-3 rounded-full text-white font-bold"
            style={{ background: "var(--ms-ink)" }}
          >
            Look up
          </button>
        </form>
        {error && (
          <p
            className="p-3 rounded-md text-sm mt-4"
            style={{ background: "#ffe1de", color: "#8a2018" }}
          >
            {error}
          </p>
        )}
      </main>
    );
  }

  if (error) {
    return (
      <main className="max-w-md mx-auto py-20 px-6 text-center">
        <p
          className="p-4 rounded-md text-sm mb-4"
          style={{ background: "#ffe1de", color: "#8a2018" }}
        >
          {error}
        </p>
        <button
          onClick={() => {
            setSubmitted(false);
            setError(null);
          }}
          className="text-sm underline"
        >
          Try again
        </button>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="max-w-md mx-auto py-20 px-6 text-center">
        <p style={{ color: "var(--ms-ink-3)" }}>Loading…</p>
      </main>
    );
  }

  const status = STATUS_LABEL[data.status] ?? STATUS_LABEL["draft"]!;

  return (
    <main className="max-w-2xl mx-auto py-12 px-6">
      <Link
        to="/"
        className="text-sm no-underline mb-6 inline-block"
        style={{ color: "var(--ms-ink-3)" }}
      >
        ← Back to menu
      </Link>
      <div
        className="rounded-3xl p-10 text-center"
        style={{ background: "white", border: "1px solid var(--ms-border)" }}
      >
        <div
          className="text-xs uppercase tracking-widest mb-3 font-semibold"
          style={{ color: "var(--ms-ink-3)" }}
        >
          Order · {data.order_number}
        </div>
        <div className="text-6xl mb-4">{status.emoji}</div>
        <h1 className="font-display text-3xl font-bold mb-2" style={{ color: status.tone }}>
          {status.label}
        </h1>
        <p className="mb-6" style={{ color: "var(--ms-ink-3)" }}>
          {data.status === "paid" && "We've started preparing your bottles."}
          {data.status === "handed_over" && "Your rider is on the way."}
          {data.status === "delivered" && "Hope you enjoy it. Thanks for ordering."}
          {data.status === "confirmed" &&
            "Waiting for payment confirmation from Payaza."}
        </p>
        <div className="flex justify-between text-sm pt-4" style={{ borderTop: "1px solid var(--ms-divider)" }}>
          <span style={{ color: "var(--ms-ink-3)" }}>Total paid</span>
          <span className="font-display font-bold">{ngn(data.total_ngn)}</span>
        </div>
      </div>
    </main>
  );
}
