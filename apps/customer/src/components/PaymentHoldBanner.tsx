import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Clock, Loader2 } from "lucide-react";
import { formatNaira } from "@/lib/cart";
import { launchPayazaCheckout } from "@/lib/payaza";
import { RedirectingOverlay } from "@/components/RedirectingOverlay";
import { resumeOpayOrder } from "@/lib/api/server-fns";
import { useCountdown } from "@/hooks/useCountdown";
import type { ApiOrderTracking } from "@/lib/api/types";

export function PaymentHoldBanner({
  order,
  phone,
  onResumed,
}: {
  order: ApiOrderTracking;
  phone: string | null;
  onResumed: () => void;
}) {
  const { mmss, expired } = useCountdown(order.reservation_expires_at);
  const [busy, setBusy] = useState(false);
  // Set when redirecting to OPay's cashier — mounts the redirect overlay with a
  // flaky-network manual link, same as the checkout page.
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  // Preorders carry no reservation; the hold concept ("bottles held") doesn't
  // apply, but they still need to pay — so show a resume button without a timer.
  const hasTimer = !order.is_preorder && !!order.reservation_expires_at;

  if (hasTimer && expired) {
    return (
      <div className="rounded-2xl bg-[color:var(--cream)]/80 p-5 ring-1 ring-black/5">
        <div className="font-semibold text-[color:var(--brand)]">Your hold expired</div>
        <p className="mt-1 text-sm text-[color:var(--brand)]/70">
          The bottles were released back to stock. You can start a fresh order any time.
        </p>
        <Link
          to="/juices"
          className="mt-3 inline-block rounded-full bg-[color:var(--brand)] text-white px-5 py-2.5 text-sm font-semibold"
        >
          Reorder
        </Link>
      </div>
    );
  }

  async function resume() {
    const rp = order.resume_payment;
    if (!rp) return;
    setBusy(true);

    // OPay: mint a fresh cashier session (the original URL has expired) and do a
    // full-page redirect. Returning to this tracking page re-verifies on view.
    if (rp.provider === "opay") {
      if (!phone) {
        setBusy(false);
        return;
      }
      try {
        const { redirect_url } = await resumeOpayOrder({
          data: { orderNumber: order.order_number, phone },
        });
        // Show the overlay first (instant feedback + flaky-network manual link),
        // then navigate on the next tick so it paints before the page freezes.
        setRedirectUrl(redirect_url);
        setTimeout(() => { window.location.href = redirect_url; }, 50);
      } catch {
        setBusy(false);
      }
      return;
    }

    // Payaza (fallback): relaunch the popup.
    await launchPayazaCheckout(rp.payaza, {
      onPaid: () => onResumed(),
      onClose: () => setBusy(false),
    });
  }

  return (
    <>
    <RedirectingOverlay url={redirectUrl} />
    <div className="rounded-2xl bg-[color:var(--brand-orange)]/10 p-5 ring-1 ring-[color:var(--brand-orange)]/20">
      <div className="flex items-center gap-2 text-[color:var(--brand-orange)] font-semibold">
        <Clock className="h-4 w-4" />{" "}
        {hasTimer ? "We're holding your bottles" : "Finish your payment"}
      </div>
      {hasTimer && (
        <div className="mt-1 text-sm text-[color:var(--brand)]/70">
          Reserved for <span className="font-bold tabular-nums">{mmss}</span> — complete payment to
          lock it in.
        </div>
      )}
      <button
        onClick={() => void resume()}
        disabled={busy || !order.resume_payment}
        className="mt-3 w-full rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-3 text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Opening payment…
          </>
        ) : (
          <>Complete payment — {formatNaira(order.total_ngn)}</>
        )}
      </button>
    </div>
    </>
  );
}
