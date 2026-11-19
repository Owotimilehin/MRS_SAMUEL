/**
 * "Connect this catalogue to WhatsApp?" (suite spec 08, 7.2 line 1). This
 * changes what customers see on WhatsApp, so a person confirms it after reading
 * exactly what will happen (foundation rule 7). The server writes the audit row.
 */
import { ConfirmModal } from "@admin/components/ConfirmModal.js";

export function ConnectCatalogueDialog({
  name,
  busy,
  onConfirm,
  onCancel,
}: {
  name: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <ConfirmModal
      title="Connect this catalogue to WhatsApp?"
      confirmLabel="Connect"
      busyLabel="Connecting…"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p style={{ margin: 0 }}>
        Customers will be able to see your menu in WhatsApp and send you a cart. This connects “{name}” to your WhatsApp
        account and turns on the cart and the menu button on your number.
      </p>
    </ConfirmModal>
  );
}
