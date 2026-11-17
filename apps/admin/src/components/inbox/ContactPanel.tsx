import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../ConfirmModal.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { contactName, listTime, phoneConfirmMatches } from "../../lib/inbox-logic.js";
import { toast } from "../../lib/toast.js";
import type { ContactInfo, ContactSearchHit } from "../../lib/inbox-types.js";

type Customer = ContactInfo["customer"];

/** Right panel: who the customer is, editable name/notes, their other chats. */
export function ContactPanel({
  customerId,
  currentConversationId,
  can,
  onErased,
  onMerged,
}: {
  customerId: string;
  currentConversationId: string;
  can: (cap: string) => boolean;
  /** This customer's inbox history was permanently deleted. */
  onErased: () => void;
  /** This contact's chats and calls were moved to another contact. */
  onMerged: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: inboxKeys.contact(customerId), queryFn: () => inboxApi.contact(customerId) });
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"erase" | "merge" | null>(null);
  const editable = can("inbox.reply");
  const canErase = can("inbox.erase");

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
      {canErase && (
        <div style={{ display: "grid", gap: 6, justifyItems: "start", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div className="t-eyebrow">Manage contact</div>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("merge")}>
            Merge with another contact…
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ color: "var(--danger-ink, #b91c1c)", textAlign: "left", whiteSpace: "normal" }}
            onClick={() => setDialog("erase")}
          >
            Delete this customer's messages and calls…
          </button>
        </div>
      )}
      {dialog === "erase" && (
        <EraseDialog
          customer={c}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onErased();
          }}
        />
      )}
      {dialog === "merge" && (
        <MergeDialog
          customer={c}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onMerged();
          }}
        />
      )}
    </>
  );
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Permanently delete a customer's inbox history, after they type the phone number. */
function EraseDialog({ customer, onClose, onDone }: { customer: Customer; onClose: () => void; onDone: () => void }): JSX.Element {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const who = contactName(customer.name, customer.phone);
  const matches = phoneConfirmMatches(typed, customer.phone);

  async function erase(): Promise<void> {
    setBusy(true);
    try {
      const r = await inboxApi.eraseContact(customer.id, typed.trim());
      toast.success(
        `Deleted ${plural(r.conversations, "chat")}, ${plural(r.messages, "message")}, ${plural(r.calls, "call")} and ${plural(r.recordings, "recording")}.`,
      );
      onDone();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title="Delete messages and calls"
      confirmLabel="Delete permanently"
      busyLabel="Deleting…"
      tone="danger"
      busy={busy}
      confirmDisabled={!matches}
      onCancel={onClose}
      onConfirm={() => void erase()}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <p style={{ margin: 0 }}>
          This permanently removes every chat, call, recording and note for <strong>{who}</strong> from the inbox. It can't be
          undone.
        </p>
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 13 }}>Their orders are not touched.</p>
        {customer.phone ? (
          <label className="field">
            <span className="field__label">
              Type the customer's phone number to confirm: <strong>{customer.phone}</strong>
            </span>
            <input
              className="input"
              inputMode="tel"
              autoComplete="off"
              value={typed}
              placeholder={customer.phone}
              onChange={(e) => setTyped(e.target.value)}
            />
            {typed.trim() && !matches && <span className="field__hint">That doesn't match yet.</span>}
          </label>
        ) : (
          <div className="field__error">This contact has no phone number on file, so it can't be confirmed here.</div>
        )}
      </div>
    </ConfirmModal>
  );
}

/** Find the contact to keep, then move this one's chats and calls onto it. */
function MergeDialog({ customer, onClose, onDone }: { customer: Customer; onClose: () => void; onDone: () => void }): JSX.Element {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [target, setTarget] = useState<ContactSearchHit | null>(null);
  const [busy, setBusy] = useState(false);

  // Search a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const search = useQuery({
    queryKey: ["inbox", "contact-search", term],
    queryFn: () => inboxApi.searchContacts(term),
    enabled: term.length >= 2 && !target,
    staleTime: 30_000,
  });
  const hits = (search.data ?? []).filter((h) => h.id !== customer.id);
  const who = contactName(customer.name, customer.phone);

  async function merge(): Promise<void> {
    if (!target) return;
    setBusy(true);
    try {
      const r = await inboxApi.mergeContact(customer.id, target.id);
      toast.success(`Moved ${plural(r.moved_conversations, "chat")} to ${contactName(target.name, target.phone)}.`);
      onDone();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title="Merge with another contact"
      confirmLabel="Merge contacts"
      busyLabel="Merging…"
      busy={busy}
      confirmDisabled={!target}
      onCancel={onClose}
      onConfirm={() => void merge()}
    >
      {target ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0 }}>
            Moves this contact's chats and calls to <strong>{contactName(target.name, target.phone)}</strong>. Orders are not
            changed.
          </p>
          <div className="card card--soft" style={{ fontSize: 13, display: "grid", gap: 2 }}>
            <div>
              <strong>From:</strong> {who}
              {customer.name && customer.phone ? ` (${customer.phone})` : ""}
            </div>
            <div>
              <strong>To:</strong> {contactName(target.name, target.phone)}
              {target.name && target.phone ? ` (${target.phone})` : ""}
            </div>
          </div>
          <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 13 }}>This can't be undone from here.</p>
          <button type="button" className="btn btn--subtle btn--sm" style={{ justifySelf: "start" }} disabled={busy} onClick={() => setTarget(null)}>
            ← Pick a different contact
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <label className="field">
            <span className="field__label">Find the contact to keep</span>
            <input
              className="input"
              value={text}
              placeholder="Name or phone number"
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
            />
            <span className="field__hint">
              {who}'s chats and calls will move to the contact you pick.
            </span>
          </label>
          {term.length < 2 ? null : search.isLoading ? (
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>Searching…</div>
          ) : search.error ? (
            <button type="button" className="btn btn--subtle btn--sm" style={{ justifySelf: "start" }} onClick={() => void search.refetch()}>
              Couldn't search — try again
            </button>
          ) : hits.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>No other contact matches "{term}".</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="card card--hoverable"
                  style={{ padding: 8, fontFamily: "inherit", fontSize: 13, color: "inherit", textAlign: "left", cursor: "pointer" }}
                  onClick={() => setTarget(h)}
                >
                  <div style={{ fontWeight: 700 }}>{contactName(h.name, h.phone)}</div>
                  <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {h.name && h.phone ? `${h.phone} · ` : ""}
                    {plural(h.conversations, "chat")}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </ConfirmModal>
  );
}
