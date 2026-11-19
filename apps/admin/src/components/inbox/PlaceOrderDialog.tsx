/**
 * "Create order from cart" (suite spec 08, 7.4). The staff member sees the cart
 * at the shop's own prices, chooses delivery or pickup, checks the address and
 * the fee, reads the exact message the customer will receive, and clicks once
 * (foundation rule 7). The server prices every line again from the shop's
 * price list and checks stock at that moment; nothing here is trusted for money.
 */
import { useMemo, useState } from "react";
import { cartSubtotalNgn, formatNaira, PAY_BUTTON_TEXT, paymentMessageBody, type CartTextLine } from "@ms/shared";
import { Modal } from "../Modal.js";
import { ApiError, humanizeError } from "../../lib/api.js";
import { inboxApi } from "../../lib/inbox-api.js";
import { cartLineNote, deliveryAddressProblem, parseDeliveryFee } from "../../lib/inbox-logic.js";
import { toast } from "../../lib/toast.js";
import type { ChatOrder, ChatOrderLine } from "../../lib/inbox-types.js";

const NO_BRANCH = "No branch is set to take online orders. Ask the owner to choose one in the shop admin.";

export function PlaceOrderDialog({
  order,
  branchName,
  defaultAddress,
  onClose,
  onPlaced,
}: {
  order: ChatOrder;
  /** The branch that takes online orders; null when the owner has not chosen one. */
  branchName: string | null;
  defaultAddress: string | null;
  onClose: () => void;
  onPlaced: () => void;
}): JSX.Element {
  const [lines, setLines] = useState<ChatOrderLine[]>(order.lines);
  const [fulfilment, setFulfilment] = useState<"delivery" | "pickup">(order.fulfilment ?? "delivery");
  const [address, setAddress] = useState(order.address ?? defaultAddress ?? "");
  const [feeText, setFeeText] = useState("0");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fee = fulfilment === "delivery" ? parseDeliveryFee(feeText) : 0;
  const addressProblem = fulfilment === "delivery" ? deliveryAddressProblem(address) : null;
  const unsellable = lines.some((l) => !l.sellable || !l.variant_id);
  const textLines: CartTextLine[] = useMemo(
    () =>
      [...lines]
        .sort((a, b) => a.name.localeCompare(b.name) || (a.size_ml ?? 0) - (b.size_ml ?? 0))
        .map((l) => ({
          name: l.name,
          sizeMl: l.size_ml,
          quantity: l.quantity,
          lineTotalNgn: l.sellable && l.shop_price_ngn != null ? l.shop_price_ngn * l.quantity : null,
          sellable: l.sellable,
        })),
    [lines],
  );
  const subtotal = cartSubtotalNgn(textLines);
  const total = subtotal + (fee ?? 0);
  const preorder = lines.some((l) => l.sellable && !l.in_stock);
  const problem = !branchName
    ? NO_BRANCH
    : lines.length === 0
      ? "Add at least one juice."
      : unsellable
        ? "Remove the juices that are no longer sold to continue."
        : fee === null
          ? "Enter the delivery fee as a whole number of naira, up to 100,000."
          : addressProblem;

  const setQty = (i: number, q: number): void => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, quantity: Math.min(99, Math.max(1, q)) } : l)));

  async function place(): Promise<void> {
    if (problem || fee === null) return;
    setBusy(true);
    setError(null);
    try {
      const done = await inboxApi.placeChatOrder(order.id, {
        fulfilment,
        ...(fulfilment === "delivery" ? { address: address.trim() } : {}),
        delivery_fee_ngn: fee,
        items: lines.map((l) => ({ variant_id: l.variant_id!, quantity: l.quantity })),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      if (done.warning) toast.info(`Order ${done.order_number} created. ${done.warning}`);
      else toast.success(`Order ${done.order_number} created. Payment link sent.`);
      onPlaced();
    } catch (err) {
      const reason = err instanceof ApiError ? err.details?.["reason"] : null;
      setError(
        reason === "no_phone"
          ? "This customer has no usable phone number."
          : reason === "item_not_sellable"
            ? "One of these juices can no longer be ordered. Remove it and try again."
            : humanizeError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create order from cart" onClose={onClose} maxWidth={560}>
      <div style={{ display: "grid", gap: 12 }}>
        <div className="ibx-cart__lines">
          {lines.map((l, i) => {
            const note = cartLineNote(l);
            return (
              <div key={`${l.retailer_id}:${i}`} className="ibx-cart__edit">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
                    {l.name}
                    {l.size_ml ? ` ${l.size_ml}ml` : ""}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                    {l.sellable && l.shop_price_ngn != null ? `${formatNaira(l.shop_price_ngn)} each · ${formatNaira(l.shop_price_ngn * l.quantity)}` : ""}
                  </div>
                  {note && <div className={l.sellable ? "ibx-cart__note" : "ibx-cart__note ibx-cart__note--bad"}>{note}</div>}
                </div>
                {l.sellable && (
                  <div className="ibx-cart__qty">
                    <button type="button" className="btn btn--subtle btn--sm" aria-label={`One fewer ${l.name}`} disabled={busy || l.quantity <= 1} onClick={() => setQty(i, l.quantity - 1)}>
                      −
                    </button>
                    <span aria-live="polite" style={{ minWidth: 22, textAlign: "center", fontWeight: 700 }}>
                      {l.quantity}
                    </span>
                    <button type="button" className="btn btn--subtle btn--sm" aria-label={`One more ${l.name}`} disabled={busy || l.quantity >= 99} onClick={() => setQty(i, l.quantity + 1)}>
                      +
                    </button>
                  </div>
                )}
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            );
          })}
          {lines.length === 0 && <div style={{ color: "var(--ink-soft)" }}>No juices left in this order.</div>}
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
          <legend className="field__label" style={{ padding: 0 }}>
            How will they get it?
          </legend>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="radio" name="fulfilment" checked={fulfilment === "delivery"} disabled={busy} onChange={() => setFulfilment("delivery")} /> Delivery
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="radio" name="fulfilment" checked={fulfilment === "pickup"} disabled={busy} onChange={() => setFulfilment("pickup")} /> Pickup at{" "}
            {branchName ?? "the shop"}
          </label>
        </fieldset>

        {fulfilment === "delivery" && (
          <>
            <label className="field">
              <span className="field__label">Delivery address</span>
              <textarea className="textarea" rows={3} value={address} maxLength={500} disabled={busy} onChange={(e) => setAddress(e.target.value)} />
              {address.trim() !== "" && addressProblem && (
                <span className="field__error" role="alert">
                  {addressProblem}
                </span>
              )}
            </label>
            <label className="field">
              <span className="field__label">Delivery fee (₦)</span>
              <input className="input" inputMode="numeric" value={feeText} maxLength={7} disabled={busy} onChange={(e) => setFeeText(e.target.value)} />
              <span className="field__hint">Enter what you agreed with the customer. Leave 0 if delivery is free or will be settled separately.</span>
            </label>
          </>
        )}
        <label className="field">
          <span className="field__label">Note for the shop</span>
          <input className="input" value={notes} maxLength={500} disabled={busy} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />
        </label>

        <dl className="ibx-cart__sum">
          <dt>Subtotal</dt>
          <dd>{formatNaira(subtotal)}</dd>
          <dt>{fulfilment === "delivery" ? "Delivery" : "Pickup"}</dt>
          <dd>{fulfilment === "delivery" ? formatNaira(fee ?? 0) : "No charge"}</dd>
          <dt style={{ fontWeight: 800 }}>Total</dt>
          <dd style={{ fontWeight: 800 }}>{formatNaira(total)}</dd>
        </dl>
        {preorder && (
          <div className="ibx-cart__note">
            Some of this is out of stock, so it will be a made-to-order (preorder) order. The customer still pays now.
          </div>
        )}

        <div>
          <div className="field__label">The customer will receive:</div>
          <div className="ibx-cart__preview">
            {paymentMessageBody({
              orderNumber: "(order number)",
              lines: textLines.filter((l) => l.sellable),
              fulfilment,
              deliveryFeeNgn: fee ?? 0,
              branchName,
              totalNgn: total,
            })}
            <div className="ibx-cart__paybtn" aria-hidden>
              {PAY_BUTTON_TEXT}
            </div>
          </div>
          <div className="field__hint">The order number is filled in when the order is created. The link opens OPay.</div>
        </div>

        {(error || problem) && (
          <div className="field__error" role="alert">
            {error ?? problem}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !!problem} onClick={() => void place()}>
            {busy ? "Creating…" : "Create order and send payment link"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
