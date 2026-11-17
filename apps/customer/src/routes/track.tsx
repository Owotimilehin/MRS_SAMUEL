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

  const ready = Boolean(orderNumber.trim() && phone.trim());

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
        <div className="mt-6 space-y-4">
          <label className="block">
            <span className="text-xs font-semibold text-[color:var(--brand)]/70">Order number</span>
            <input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()}
              placeholder="e.g. SO-2026-01042"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1.5 w-full rounded-xl bg-white px-4 py-3 text-base sm:text-sm text-[color:var(--brand)] ring-1 ring-black/10 placeholder:text-[color:var(--brand)]/40 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none"
            />
            <span className="mt-1.5 block text-xs text-[color:var(--brand)]/55">
              Order numbers start with SO-, then the year.
            </span>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-[color:var(--brand)]/70">Phone number</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()}
              placeholder="0800 000 0000"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className="mt-1.5 w-full rounded-xl bg-white px-4 py-3 text-base sm:text-sm text-[color:var(--brand)] ring-1 ring-black/10 placeholder:text-[color:var(--brand)]/40 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none"
            />
          </label>
          <button
            onClick={go}
            disabled={!ready}
            className="w-full rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-bold transition hover:bg-[color:var(--brand-orange)] disabled:cursor-not-allowed disabled:bg-[color:var(--brand)]/10 disabled:text-[color:var(--brand)]/45 disabled:ring-1 disabled:ring-[color:var(--brand)]/15 disabled:hover:bg-[color:var(--brand)]/10"
          >
            Track Order
          </button>
          {!ready && (
            <p className="text-center text-xs text-[color:var(--brand)]/55">
              Fill in both fields to track your order.
            </p>
          )}
        </div>
      </div>
    </SiteShell>
  );
}
