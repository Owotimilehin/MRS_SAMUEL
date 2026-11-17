import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { contactName, listTime } from "../../lib/inbox-logic.js";
import { toast } from "../../lib/toast.js";

/** Right panel: who the customer is, editable name/notes, their other chats. */
export function ContactPanel({
  customerId,
  currentConversationId,
  can,
}: {
  customerId: string;
  currentConversationId: string;
  can: (cap: string) => boolean;
}): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: inboxKeys.contact(customerId), queryFn: () => inboxApi.contact(customerId) });
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = can("inbox.reply");

  useEffect(() => {
    if (q.data) {
      setName(q.data.customer.name ?? "");
      setNotes(q.data.customer.notes ?? "");
    }
  }, [q.data]);

  if (q.isLoading) return <div style={{ color: "var(--ink-soft)" }}>Loading contact…</div>;
  if (q.error || !q.data) {
    return (
      <button type="button" className="btn btn--subtle btn--sm" onClick={() => void q.refetch()}>
        Couldn't load contact — try again
      </button>
    );
  }
  const c = q.data.customer;
  const dirty = name.trim() !== (c.name ?? "") || notes !== (c.notes ?? "");
  const others = q.data.conversations.filter((x) => x.id !== currentConversationId);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await inboxApi.patchContact(customerId, {
        ...(name.trim() && name.trim() !== (c.name ?? "") ? { name: name.trim() } : {}),
        notes: notes.trim() ? notes : null,
      });
      toast.success("Contact saved.");
      await qc.invalidateQueries({ queryKey: inboxKeys.all });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <div className="t-eyebrow">Contact</div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{contactName(c.name, c.phone)}</div>
        {c.phone && (
          <a href={`tel:${c.phone}`} style={{ fontSize: 14 }}>
            {c.phone}
          </a>
        )}
        {c.email && <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{c.email}</div>}
        {can("customers.view") && (
          <div style={{ marginTop: 6 }}>
            <Link to="/owner/customers/$customerId" params={{ customerId: c.id }} style={{ fontSize: 13 }}>
              Orders &amp; customer profile →
            </Link>
          </div>
        )}
      </div>
      {editable ? (
        <div style={{ display: "grid", gap: 8 }}>
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Notes about this customer</span>
            <textarea className="textarea" rows={4} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
            <span className="field__hint">Only staff can see these.</span>
          </label>
          <button type="button" className="btn btn--primary btn--sm" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      ) : (
        c.notes && <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{c.notes}</div>
      )}
      <div>
        <div className="t-eyebrow" style={{ marginBottom: 6 }}>Other conversations</div>
        {others.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>None.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {others.map((o) => (
              <Link
                key={o.id}
                to="/inbox/$conversationId"
                params={{ conversationId: o.id }}
                className="card card--hoverable"
                style={{ padding: 8, fontSize: 13, display: "block" }}
              >
                <div style={{ fontWeight: 700 }}>{o.number_label}</div>
                <div style={{ color: "var(--ink-soft)" }}>
                  {o.status === "closed" ? "Closed" : "Open"} · {listTime(o.last_activity_at)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
