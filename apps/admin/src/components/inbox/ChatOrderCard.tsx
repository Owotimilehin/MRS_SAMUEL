/**
 * The cart beside the chat (suite spec 08, 7.4): what a customer sent from the
 * WhatsApp catalogue, at the shop's own prices, and the order it became.
 * Shown at the top of the contact panel when the conversation has carts.
 */
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingBag } from "lucide-react";
import { formatNaira } from "@ms/shared";
import { ConfirmModal } from "../ConfirmModal.js";
import { ApiError } from "../../lib/api.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { cartLineNote, chatOrderAwaitingPayment, chatOrderHeading, chatOrderStatusChip } from "../../lib/inbox-logic.js";
import { useInboxEvents } from "../../lib/inbox-stream.js";
import { toast } from "../../lib/toast.js";
import type { ChatOrder, InboxEvent } from "../../lib/inbox-types.js";
import { PlaceOrderDialog } from "./PlaceOrderDialog.js";

export function ChatOrders({ conversationId, can }: { conversationId: string; can: (cap: string) => boolean }): JSX.Element | null {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: inboxKeys.chatOrders(conversationId),
    queryFn: () => inboxApi.chatOrders(conversationId),
    retry: false,
    staleTime: 10_000,
  });
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: inboxKeys.chatOrders(conversationId) });
  }, [qc, conversationId]);
  // A new cart, the customer's answer, or an order placed by a colleague: refetch when this chat changes.
  const onEvent = useCallback(
    (e: InboxEvent) => {
      if (e.conversationId === conversationId && (e.event === "message.created" || e.event === "conversation.updated")) refresh();
    },
    [conversationId, refresh],
  );
  useInboxEvents(onEvent, true);

  const rows = q.data?.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((row) => (
        <ChatOrderCard
          key={row.id}
          order={row}
          branchName={q.data?.online_branch?.name ?? null}
          defaultAddress={q.data?.default_address ?? null}
          can={can}
          onChanged={() => {
            refresh();
            void qc.invalidateQueries({ queryKey: inboxKeys.timeline(conversationId) });
            void qc.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
          }}
        />
      ))}
    </div>
  );
}

function ChatOrderCard({
  order,
  branchName,
  defaultAddress,
  can,
  onChanged,
}: {
  order: ChatOrder;
  branchName: string | null;
  defaultAddress: string | null;
  can: (cap: string) => boolean;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const canReply = can("inbox.reply");
  const canOrder = can("orders.manage");
  const open = order.state !== "placed" && order.state !== "cancelled";
  const chip = order.order ? chatOrderStatusChip(order.order.status) : null;

  async function ask(): Promise<void> {
    setBusy("ask");
    try {
      await inboxApi.askChatOrder(order.id);
      toast.success("Question sent.");
    } catch (err) {
      const reason = err instanceof ApiError ? err.details?.["reason"] : null;
      toast.error(
        reason === "window_closed"
          ? "More than 24 hours since the customer's last message. Send a template first."
          : err instanceof ApiError && err.status === 502
            ? "The question didn't go through normally. Check how it's marked in the chat before sending again."
            : err instanceof Error
              ? err.message
              : "The question could not be sent.",
      );
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function resend(): Promise<void> {
    setBusy("link");
    try {
      const r = await inboxApi.sendPaymentLink(order.id);
      if (r.warning) toast.error(r.warning);
      else toast.success("Payment link sent.");
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function dismiss(): Promise<void> {
    setBusy("dismiss");
    try {
      await inboxApi.cancelChatOrder(order.id);
      setDismissing(false);
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <section className={`ibx-cart${order.state === "cancelled" ? " ibx-cart--off" : ""}`} aria-label="Cart from WhatsApp">
      <div className="ibx-cart__head">
        <ShoppingBag size={15} aria-hidden />
        <span>{chatOrderHeading(order.state, order.order?.order_number)}</span>
      </div>
      <div className="ibx-cart__lines">
        {order.lines.map((l, i) => {
          const note = cartLineNote(l);
          return (
            <div key={`${l.retailer_id}:${i}`}>
              <div>
                {l.quantity} × {l.name}
                {l.size_ml ? ` ${l.size_ml}ml` : ""}
                {l.line_total_ngn != null ? ` — ${formatNaira(l.line_total_ngn)}` : ""}
              </div>
              {open && note && <div className={l.sellable ? "ibx-cart__note" : "ibx-cart__note ibx-cart__note--bad"}>{note}</div>}
            </div>
          );
        })}
      </div>
      {!order.order && <div style={{ fontWeight: 700 }}>Subtotal {formatNaira(order.subtotal_ngn)}</div>}
      {order.cart_note && <div style={{ fontSize: 13 }}>Customer&apos;s note: “{order.cart_note}”</div>}
      {open && order.fulfilment && (
        <div style={{ fontSize: 13 }}>
          {order.fulfilment === "pickup" ? "They chose pickup." : order.address ? `Delivery to: ${order.address}` : "They chose delivery."}
        </div>
      )}
      {order.problem && open && <div className="ibx-cart__note ibx-cart__note--bad">{order.problem}</div>}

      {open && (
        <div className="ibx-cart__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!canReply || !canOrder || busy !== null}
            title={canOrder ? undefined : "You need order permission to create orders."}
            onClick={() => setPlacing(true)}
          >
            Create order…
          </button>
          {(order.state === "new" || order.state === "asked") && canReply && (
            <button type="button" className="btn btn--subtle btn--sm" disabled={busy !== null} onClick={() => void ask()}>
              {busy === "ask" ? "Sending…" : "Ask: delivery or pickup?"}
            </button>
          )}
          {canReply && (
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => setDismissing(true)}>
              Dismiss
            </button>
          )}
          {!canOrder && <div className="field__hint">You need order permission to create orders.</div>}
        </div>
      )}

      {order.order && chip && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`pill pill--${chip.tone}`}>{chip.text}</span>
            <span style={{ fontWeight: 700 }}>{formatNaira(order.order.total_ngn)}</span>
          </div>
          {order.problem && <div className="ibx-cart__note ibx-cart__note--bad">{order.problem}</div>}
          <div className="ibx-cart__actions">
            {chatOrderAwaitingPayment(order.order.status) && canReply && (
              <button type="button" className="btn btn--subtle btn--sm" disabled={busy !== null} onClick={() => void resend()}>
                {busy === "link" ? "Sending…" : order.payment_link_sent_at ? "Send payment link again" : "Send payment link"}
              </button>
            )}
            <a href={order.order.admin_url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
              Open in shop admin
            </a>
          </div>
        </>
      )}

      {placing && (
        <PlaceOrderDialog
          order={order}
          branchName={branchName}
          defaultAddress={defaultAddress}
          onClose={() => setPlacing(false)}
          onPlaced={() => {
            setPlacing(false);
            onChanged();
          }}
        />
      )}
      {dismissing && (
        <ConfirmModal title="Dismiss this cart?" confirmLabel="Dismiss" busyLabel="Dismissing…" busy={busy === "dismiss"} onCancel={() => setDismissing(false)} onConfirm={() => void dismiss()}>
          <p style={{ margin: 0 }}>Dismiss this cart? The customer is not told.</p>
        </ConfirmModal>
      )}
    </section>
  );
}
