/**
 * "Send products" (suite spec 08, 7.3): tick one to thirty juices from the
 * catalogue, or send the whole menu. WhatsApp shows the catalogue's own name,
 * picture and price; nothing typed here can change a price. Only inside the
 * 24-hour window, like any free message.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatNaira, MAX_PRODUCTS_PER_MESSAGE, waWindowRemainingMs } from "@ms/shared";
import { Modal } from "../Modal.js";
import { ApiError } from "../../lib/api.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { toast } from "../../lib/toast.js";
import type { ConversationDetail } from "../../lib/inbox-types.js";

const WINDOW_CLOSED = "You can only send products within 24 hours of the customer's last message. Send a template first.";

export function ProductPicker({ conv, onClose, onSent }: { conv: ConversationDetail; onClose: () => void; onSent: () => void }): JSX.Element {
  const q = useQuery({ queryKey: inboxKeys.catalogueSendable, queryFn: inboxApi.catalogueSendable, staleTime: 30_000 });
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return s ? items.filter((i) => i.title.toLowerCase().includes(s)) : items;
  }, [items, search]);
  const windowOpen = conv.lastInboundWaAt ? waWindowRemainingMs(conv.lastInboundWaAt, new Date()) > 0 : false;
  const full = chosen.length >= MAX_PRODUCTS_PER_MESSAGE;

  function toggle(id: string): void {
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= MAX_PRODUCTS_PER_MESSAGE ? c : [...c, id]));
  }

  async function send(kind: "products" | "menu"): Promise<void> {
    setBusy(true);
    try {
      const note = text.trim() || undefined;
      if (kind === "menu") await inboxApi.sendCatalogue(conv.id, note);
      else await inboxApi.sendProducts(conv.id, chosen, note);
      onSent();
    } catch (err) {
      // inboxApi has already shown the server's sentence; add the two the spec words differently.
      const reason = err instanceof ApiError ? err.details?.["reason"] : null;
      if (reason === "item_not_in_catalogue") {
        toast.error("That juice is no longer in the catalogue. Refresh and choose again.");
        setChosen([]);
        void q.refetch();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Send products" onClose={onClose} maxWidth={560}>
      <div style={{ display: "grid", gap: 10 }}>
        {q.isLoading ? (
          <div style={{ color: "var(--ink-soft)" }}>Loading the catalogue…</div>
        ) : q.error ? (
          <button type="button" className="btn btn--subtle btn--sm" style={{ justifySelf: "start" }} onClick={() => void q.refetch()}>
            Couldn&apos;t load the catalogue. Try again
          </button>
        ) : items.length === 0 ? (
          <div className="empty">No products are live on WhatsApp yet. Check the Catalogue page.</div>
        ) : (
          <>
            <input className="input" type="search" placeholder="Search juices" aria-label="Search juices" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="ibx-pick" role="group" aria-label="Juices">
              {shown.length === 0 && <div style={{ color: "var(--ink-soft)", padding: 8 }}>Nothing matches.</div>}
              {shown.map((item) => {
                const on = chosen.includes(item.retailer_id);
                return (
                  <label key={item.retailer_id} className="ibx-pick__row">
                    <input type="checkbox" checked={on} disabled={busy || (!on && full)} onChange={() => toggle(item.retailer_id)} />
                    {item.picture_url ? <img className="ibx-pick__img" src={item.picture_url} alt="" loading="lazy" /> : <span className="ibx-pick__img" aria-hidden />}
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{item.title}</span>
                      {item.availability === "out of stock" && <span style={{ color: "var(--ink-soft)", fontSize: 12 }}> · Out of stock</span>}
                    </span>
                    <span style={{ whiteSpace: "nowrap" }}>{item.price_ngn != null ? formatNaira(item.price_ngn) : ""}</span>
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)" }} aria-live="polite">
              {chosen.length} of {MAX_PRODUCTS_PER_MESSAGE} chosen
            </div>
          </>
        )}
        <label className="field">
          <span className="field__label">Message</span>
          <input className="input" value={text} maxLength={1024} placeholder="Add a short note (optional)" onChange={(e) => setText(e.target.value)} />
        </label>
        {!windowOpen && (
          <div className="field__error" role="alert">
            {WINDOW_CLOSED}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--subtle" disabled={busy || !windowOpen || items.length === 0} onClick={() => void send("menu")}>
            Send our whole menu
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !windowOpen || chosen.length === 0} onClick={() => void send("products")}>
            {busy ? "Sending…" : `Send ${chosen.length} product${chosen.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
