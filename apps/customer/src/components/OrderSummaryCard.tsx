import { formatNaira } from "@/lib/cart";
import type { ApiOrderItem } from "@/lib/api/types";

export function OrderSummaryCard({
  items,
  subtotalNgn,
  deliveryFeeNgn,
  totalNgn,
}: {
  items: ApiOrderItem[];
  subtotalNgn: number;
  deliveryFeeNgn: number;
  totalNgn: number;
}) {
  return (
    <div className="rounded-2xl bg-white ring-1 ring-black/5 p-6">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55">
        Your order
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((it, i) => (
          <li key={i} className="flex justify-between text-sm text-[color:var(--brand)]/80">
            <span>
              {it.quantity}× {it.name}
              {it.size_ml ? ` ${it.size_ml}ml` : ""}
            </span>
            <span className="tabular-nums">{formatNaira(it.line_total_ngn)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-1.5 border-t border-black/5 pt-3 text-sm">
        <div className="flex justify-between text-[color:var(--brand)]/70">
          <span>Subtotal</span>
          <span>{formatNaira(subtotalNgn)}</span>
        </div>
        <div className="flex justify-between text-[color:var(--brand)]/70">
          <span>Delivery</span>
          <span>{deliveryFeeNgn === 0 ? "₦0" : formatNaira(deliveryFeeNgn)}</span>
        </div>
        <div className="flex justify-between font-display text-xl pt-2 border-t border-black/5 text-[color:var(--brand)]">
          <span>Total</span>
          <span>{formatNaira(totalNgn)}</span>
        </div>
      </div>
    </div>
  );
}
