/**
 * DeliveryStatusPanel — presentational rider-journey panel.
 * Renders a status pill + rider details + rebook button when needed.
 * If `delivery` is null, renders nothing.
 */

interface DeliveryRow {
  status: string;
  riderName: string | null;
  riderPhone: string | null;
  riderVehicle: string | null;
  trackingUrl: string | null;
  assignedAt?: string | null;
  pickedUpAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  failedAt?: string | null;
  failReason?: string | null;
}

interface DeliveryStatusPanelProps {
  delivery: DeliveryRow | null;
  onRebook: () => void;
}

const RIDER_LABELS: Record<string, string> = {
  searching_rider: "Finding a rider…",
  assigned: "Rider assigned",
  picked_up: "Rider picked up the order",
  in_transit: "On the way",
  delivered: "Delivered",
  cancelled: "Rider cancelled",
  failed: "Delivery failed / returned",
};

function statusColor(status: string): string {
  if (status === "delivered") return "var(--success, #22c55e)";
  if (status === "cancelled" || status === "failed") return "var(--danger, #ef4444)";
  if (status === "in_transit" || status === "picked_up") return "var(--accent, #f97316)";
  return "var(--ink-soft)";
}

export function DeliveryStatusPanel({ delivery, onRebook }: DeliveryStatusPanelProps): JSX.Element | null {
  if (!delivery) return null;

  const label = RIDER_LABELS[delivery.status] ?? delivery.status;
  const isFailed = delivery.status === "cancelled" || delivery.status === "failed";

  return (
    <div
      style={{
        marginTop: 12,
        padding: "12px 14px",
        borderRadius: 10,
        background: "var(--surface-raised, rgba(0,0,0,0.03))",
        border: isFailed ? "1.5px solid var(--danger, #ef4444)" : "1px solid var(--border, rgba(0,0,0,0.08))",
        fontSize: 13,
      }}
    >
      {/* Status label */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusColor(delivery.status),
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 700, color: statusColor(delivery.status) }}>{label}</span>
      </div>

      {/* Rider details */}
      {(delivery.riderName || delivery.riderPhone || delivery.riderVehicle) && (
        <div style={{ display: "grid", gap: 3, marginBottom: 8, color: "var(--ink)" }}>
          {delivery.riderName && (
            <div>
              <span style={{ color: "var(--ink-soft)" }}>Rider: </span>
              <span style={{ fontWeight: 600 }}>{delivery.riderName}</span>
            </div>
          )}
          {delivery.riderPhone && (
            <div>
              <span style={{ color: "var(--ink-soft)" }}>Phone: </span>
              <a href={`tel:${delivery.riderPhone}`} style={{ color: "var(--accent)" }}>
                {delivery.riderPhone}
              </a>
            </div>
          )}
          {delivery.riderVehicle && (
            <div>
              <span style={{ color: "var(--ink-soft)" }}>Vehicle: </span>
              {delivery.riderVehicle}
            </div>
          )}
        </div>
      )}

      {/* Tracking link */}
      {delivery.trackingUrl && (
        <div style={{ marginBottom: 8 }}>
          <a
            className="btn btn--subtle btn--sm"
            href={delivery.trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Track rider →
          </a>
        </div>
      )}

      {/* Fail reason */}
      {delivery.failReason && (
        <div
          style={{
            fontSize: 12,
            color: "var(--danger)",
            background: "rgba(239,68,68,0.07)",
            borderRadius: 6,
            padding: "5px 9px",
            marginBottom: 8,
          }}
        >
          {delivery.failReason}
        </div>
      )}

      {/* Rebook button when delivery ended badly */}
      {isFailed && (
        <div
          style={{
            marginTop: 4,
            padding: "10px 12px",
            background: "rgba(239,68,68,0.06)",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ color: "var(--danger)", fontWeight: 600 }}>
            {delivery.status === "cancelled" ? "Rider cancelled this delivery." : "Delivery failed or returned."}
          </span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onRebook}
          >
            Re-book rider
          </button>
        </div>
      )}
    </div>
  );
}
