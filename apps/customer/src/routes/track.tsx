import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SiteShell } from "@/components/SiteShell";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/track")({
  head: () =>
    seo({
      title: "Track your order — Mrs. Samuel Fruit Juice",
      description:
        "Check the status of your Mrs. Samuel order. Enter your order number and the phone number you used at checkout to see live progress.",
      path: "/track",
    }),
  component: TrackPage,
});

function TrackPage() {
  const navigate = useNavigate();
  const [orderNumber, setOrderNumber] = useState("");
  const [phone, setPhone] = useState("");

  function go() {
    const num = orderNumber.trim();
    const ph = phone.replace(/[\s-]/g, "");
    if (!num || !ph) return;
    try {
      localStorage.setItem(`ms_track_${num}`, JSON.stringify({ phone: ph }));
    } catch {
      /* ignore */
    }
    void navigate({ to: "/order/$orderNumber", params: { orderNumber: num } });
  }

  return (
    <SiteShell>
      <div className="px-5 max-w-md mx-auto pt-36 pb-24">
        <h1 className="font-display text-4xl text-[color:var(--brand)]">Track your order</h1>
        <p className="mt-2 text-sm text-[color:var(--brand)]/70">
          Enter your order number and the phone number you used at checkout.
        </p>
        <div className="mt-6 space-y-3">
          <input
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            placeholder="Order number (e.g. 1042)"
            className="w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            placeholder="Phone number"
            className="w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none"
          />
          <button
            onClick={go}
            disabled={!orderNumber.trim() || !phone.trim()}
            className="w-full rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-bold disabled:opacity-50"
          >
            Track order
          </button>
        </div>
      </div>
    </SiteShell>
  );
}
