import type { ReactNode } from "react";

export type Status =
  | "pending"
  | "confirmed"
  | "paid"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "rejected"
  | "flagged"
  | "requires_review";

/** Status pill — solid 12%-alpha fill of the status color with full-color text.
 * Reusable across orders, transfers, returns, closes, etc. */
export function StatusPill({
  status,
  children,
}: {
  status: Status;
  children?: ReactNode;
}): JSX.Element {
  const palette: Record<Status, { fg: string; bg: string; label: string }> = {
    pending:          { fg: "var(--warning)", bg: "rgba(245,158,11,0.12)", label: "Pending" },
    confirmed:        { fg: "var(--success)", bg: "rgba(16,185,129,0.12)", label: "Confirmed" },
    paid:             { fg: "var(--success)", bg: "rgba(16,185,129,0.12)", label: "Paid" },
    out_for_delivery: { fg: "var(--accent)",  bg: "rgba(241,90,36,0.12)",  label: "Out for delivery" },
    delivered:        { fg: "var(--success)", bg: "rgba(16,185,129,0.18)", label: "Delivered" },
    cancelled:        { fg: "var(--danger)",  bg: "rgba(220,38,38,0.12)",  label: "Cancelled" },
    rejected:         { fg: "var(--danger)",  bg: "rgba(220,38,38,0.12)",  label: "Rejected" },
    flagged:          { fg: "var(--accent-2)",bg: "rgba(230,57,70,0.12)",  label: "Flagged" },
    requires_review:  { fg: "var(--accent-2)",bg: "rgba(230,57,70,0.12)",  label: "Needs review" },
  };
  const { fg, bg, label } = palette[status];
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "4px 10px",
      borderRadius: 999,
      background: bg,
      color: fg,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
    }}>
      {children ?? label}
    </span>
  );
}
