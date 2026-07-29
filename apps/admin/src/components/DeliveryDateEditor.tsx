import { useState } from "react";
import { api, humanizeError } from "../lib/api.js";
import { formatDateTime } from "../lib/format.js";
import { toast } from "../lib/toast.js";

interface DeliveryDateEditorProps {
  branchId: string;
  saleId: string;
  scheduledDeliveryAt?: string | null | undefined;
  status: string;
  channel: string;
  canEdit: boolean;
  onSaved: () => void;
}

// Mirrors the server's own gate in PATCH /:id/delivery-date (apps/api/src/routes/sales.ts)
// — narrower than the items-edit gate: a delivery date can still move while an
// order is out for delivery / handed over, only a finished or dead order freezes it.
const UNEDITABLE_STATUSES = new Set(["delivered", "cancelled"]);

/** ISO instant → the local "YYYY-MM-DDTHH:mm" a <input type="datetime-local"> expects. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Inline delivery-date editor for the order-detail Delivery card, next to the
 * address editor. PATCHes .../delivery-date; the server re-validates future +
 * ≤3-month, so this only needs to surface whatever it rejects.
 */
export function DeliveryDateEditor({
  branchId,
  saleId,
  scheduledDeliveryAt,
  status,
  channel,
  canEdit,
  onSaved,
}: DeliveryDateEditorProps): JSX.Element | null {
  const editable = canEdit && !UNEDITABLE_STATUSES.has(status) && ["online", "phone"].includes(channel);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editable && !scheduledDeliveryAt) return null;

  function startEdit(): void {
    setDraft(scheduledDeliveryAt ? toLocalInputValue(scheduledDeliveryAt) : "");
    setError(null);
    setEditing(true);
  }

  async function save(): Promise<void> {
    if (!draft) return;
    const iso = new Date(draft).toISOString();
    setSaving(true);
    setError(null);
    try {
      await api(`/branches/${branchId}/sales/${saleId}/delivery-date`, {
        method: "PATCH",
        body: JSON.stringify({ scheduledDeliveryAt: iso }),
      });
      setEditing(false);
      toast.success("Delivery date updated.");
      onSaved();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
          {scheduledDeliveryAt ? `Scheduled for ${formatDateTime(scheduledDeliveryAt)}` : "No delivery date set"}
        </span>
        {editable && !editing && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={startEdit} style={{ fontSize: 12 }}>
            ✎ {scheduledDeliveryAt ? "Edit date" : "Add date"}
          </button>
        )}
      </div>
      {editing && (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <input
            className="input"
            type="datetime-local"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{ width: "100%", fontSize: 14 }}
          />
          {error && <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={saving || !draft}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save date"}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
