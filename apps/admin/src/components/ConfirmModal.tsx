import type { ReactNode } from "react";
import { Modal } from "./Modal.js";

interface ConfirmModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
  tone?: "primary" | "danger";
  maxWidth?: number;
}

/**
 * A confirm dialog built on the shared Modal: a scrollable summary body with a
 * pinned Cancel/Confirm footer. The footer never scrolls out of view, so long
 * summaries stay confirmable on small screens; Modal itself caps the card to the
 * viewport so it never overflows on large ones.
 */
export function ConfirmModal({
  title,
  children,
  confirmLabel,
  busyLabel,
  onConfirm,
  onCancel,
  busy = false,
  confirmDisabled = false,
  tone = "primary",
  maxWidth = 560,
}: ConfirmModalProps): JSX.Element {
  return (
    <Modal title={title} onClose={onCancel} maxWidth={maxWidth}>
      <div style={{ maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>{children}</div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 14,
          paddingTop: 14,
          borderTop: "1px solid var(--line)",
        }}
      >
        <button type="button" className="btn btn--subtle" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={tone === "danger" ? "btn btn--danger" : "btn btn--primary"}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
