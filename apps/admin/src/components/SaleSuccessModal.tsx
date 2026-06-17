/**
 * POS success modal — replaces the green flash banner after a completed sale.
 * Confirms the sale conversationally, shows change due, and offers to print the
 * receipt directly to the thermal printer. "New sale" dismisses to a clean till.
 */
import { useState } from "react";
import { Modal } from "./Modal.js";
import { ngn } from "../lib/format.js";
import { toast } from "../lib/toast.js";
import { printReceipt } from "../lib/print-receipt.js";
import type { ReceiptData } from "../lib/receipt-data.js";

export function SaleSuccessModal({
  receipt,
  itemCount,
  onNewSale,
}: {
  receipt: ReceiptData;
  itemCount: number;
  onNewSale: () => void;
}): JSX.Element {
  const [printing, setPrinting] = useState(false);
  const isCash = receipt.paymentLabel === "Cash";

  async function handlePrint(): Promise<void> {
    setPrinting(true);
    try {
      const res = await printReceipt(receipt, { promptIfNeeded: true, openDrawer: isCash });
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } finally {
      setPrinting(false);
    }
  }

  const title = receipt.kind === "preorder" ? "Preorder taken" : "Sale complete";

  return (
    <Modal title={title} onClose={onNewSale} maxWidth={380}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, textAlign: "center" }}>
        <div
          style={{
            margin: "0 auto",
            width: 56,
            height: 56,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: "rgba(16,185,129,0.12)",
            color: "#047857",
            fontSize: 30,
            fontWeight: 800,
          }}
          aria-hidden
        >
          ✓
        </div>

        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {itemCount} {itemCount === 1 ? "item" : "items"} · {ngn(receipt.totalNgn)}
          </div>
          <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 2 }}>
            {receipt.paymentLabel}
            {receipt.kind === "preorder" && receipt.fulfilLabel
              ? ` · fulfil ${receipt.fulfilLabel}`
              : ""}
          </div>
        </div>

        {isCash && receipt.changeNgn != null && (
          <div
            style={{
              background: "rgba(245,158,11,0.10)",
              border: "1px solid rgba(245,158,11,0.30)",
              borderRadius: 12,
              padding: "10px 14px",
              fontWeight: 800,
              fontSize: 18,
              color: "#b45309",
            }}
          >
            Change due: {ngn(receipt.changeNgn)}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handlePrint}
            disabled={printing}
            style={{ width: "100%" }}
          >
            {printing ? "Printing…" : "🖨  Print receipt"}
          </button>
          <button type="button" className="btn" onClick={onNewSale} style={{ width: "100%" }}>
            New sale
          </button>
        </div>
      </div>
    </Modal>
  );
}
