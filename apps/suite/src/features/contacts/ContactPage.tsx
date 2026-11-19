/**
 * One contact (suite spec 14, 7.3): details, consent, how they reach us, orders,
 * conversations, labels and lists, and who changed what.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLink, Pencil } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import type { ContactDetail } from "@ms/shared";
import { AddToListDialog } from "./AddToListDialog.js";
import { ConsentDialog } from "./ConsentDialog.js";
import { EditContactDialog } from "./EditContactDialog.js";
import { LabelsDialog } from "./LabelsDialog.js";
import { contactKeys, contactsApi, failureText, type ContactHistory } from "./contacts-api.js";
import {
  CHANNEL_TEXT,
  addressTag,
  consentHow,
  consentLine,
  consentTitle,
  editLine,
  lagosDate,
  naira,
  plainDate,
  sourceText,
  whatsappPromotions,
} from "./contacts-logic.js";
import "./contacts.css";

type Dialog = "edit" | "consent" | "labels" | "add-to-list" | "history" | null;

export function ContactPage({ customerId }: { customerId: string }): JSX.Element {
  const navigate = useNavigate();
  const contact = useQuery({ queryKey: contactKeys.one(customerId), queryFn: () => contactsApi.get(customerId), refetchOnWindowFocus: false });
  const data = contact.data;

  return (
    <Frame title="Contact" crumb="Contacts">
      <div className="ct-page">
        <div>
          <Link to="/contacts" className="ct-linkish">
            ← All contacts
          </Link>
        </div>
        <DataState loading={contact.isLoading} error={contact.error} onRetry={() => void contact.refetch()}>
          {data && "merged_into" in data ? (
            <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
              <div className="empty__title">This record was merged into another contact.</div>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void navigate({ to: "/contacts/$customerId", params: { customerId: data.merged_into } })}
              >
                Open that contact
              </button>
            </div>
          ) : data ? (
            <Loaded contact={data} />
          ) : null}
        </DataState>
      </div>
    </Frame>
  );
}

function Loaded({ contact }: { contact: ContactDetail }): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can("contacts.manage");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const history = useQuery({ queryKey: contactKeys.history(contact.id), queryFn: () => contactsApi.history(contact.id), refetchOnWindowFocus: false });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: contactKeys.all });
  };
  const promotions = whatsappPromotions(contact.consent_now);
  const otherConsent = contact.consent_now.filter((r) => !(r.channel === "whatsapp" && r.purpose === "marketing"));

  async function removeFromList(): Promise<void> {
    if (!removing) return;
    setBusy(true);
    try {
      await contactsApi.removeFromList(removing.id, [contact.id]);
      toast.success(`Removed from “${removing.name}”.`);
      setRemoving(null);
      await refresh();
    } catch (err) {
      toast.error(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ct-head">
        <h1 className="ct-head__name">{contact.name ?? "No name"}</h1>
        {contact.phone && <span className="ct-head__phone">{contact.phone}</span>}
        <span style={{ flex: 1 }} />
        {manage && (
          <button type="button" className="btn btn--subtle" onClick={() => setDialog("edit")}>
            <Pencil size={14} /> Edit
          </button>
        )}
        <a className="btn btn--ghost" href={contact.shop_profile_url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Open in shop admin
        </a>
      </div>

      <div className="ct-cards">
        <section className="card ct-card" aria-label="Details">
          <h2 className="ct-card__h">Details</h2>
          <dl className="ct-facts">
            <dt>Name</dt>
            <dd>{contact.name ?? "—"}</dd>
            <dt>Phone</dt>
            <dd>{contact.phone ?? "—"}</dd>
            <dt>Email</dt>
            <dd>{contact.email ?? "—"}</dd>
            <dt>Address</dt>
            <dd>
              {contact.address ?? "—"}
              {contact.address && <span className="ct-tag">{addressTag(contact.address_source)}</span>}
            </dd>
            <dt>Notes</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{contact.notes ?? "—"}</dd>
            <dt>Came from</dt>
            <dd>
              {sourceText(contact.source)}
              {contact.origin && (
                <div className="ct-soft">
                  {contact.origin.origin === "manual"
                    ? `Added by hand by ${contact.origin.created_by_name ?? "staff"} on ${lagosDate(contact.origin.created_at)}`
                    : `Imported from “${contact.origin.import_filename ?? "a file"}”${contact.origin.source_label ? ` (${contact.origin.source_label})` : ""} on ${lagosDate(
                        contact.origin.created_at,
                      )}`}
                  {contact.origin.origin === "manual" && contact.origin.source_label ? ` (${contact.origin.source_label})` : ""}
                </div>
              )}
            </dd>
          </dl>
        </section>

        <section className="card ct-card" aria-label="Promotions and consent">
          <h2 className="ct-card__h">
            Promotions and consent
            {manage && (
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("consent")}>
                Record consent
              </button>
            )}
          </h2>
          <ul className="ct-rows">
            <li className="ct-consent-line">
              <span>
                <strong>WhatsApp promotions</strong>
                <div className={promotions?.state === "withdrawn" ? "ct-stopped" : "ct-soft"}>{consentLine(promotions)}</div>
              </span>
            </li>
            {otherConsent.map((r) => (
              <li key={`${r.channel}:${r.purpose}`} className="ct-consent-line">
                <span>
                  <strong>{consentTitle(r.channel, r.purpose)}</strong>
                  <div className="ct-soft">{consentLine(r)}</div>
                </span>
              </li>
            ))}
          </ul>
          {contact.wa_unreachable && <p className="ct-note ct-note--amber">An earlier WhatsApp message to this number could not be delivered. They may not be on WhatsApp.</p>}
          <div>
            <button type="button" className="ct-linkish" onClick={() => setDialog("history")}>
              History
            </button>
          </div>
        </section>

        <section className="card ct-card" aria-label="How they reach us">
          <h2 className="ct-card__h">How they reach us</h2>
          {contact.identities.length === 0 && !contact.channels.includes("phone") ? (
            <p className="ct-soft">They have not messaged or called yet.</p>
          ) : (
            <ul className="ct-rows">
              {contact.identities.map((i) => (
                <li key={i.id}>
                  <span>
                    <strong>{CHANNEL_TEXT[i.channel]}</strong>{" "}
                    {i.username ? `@${i.username}` : (i.display_name ?? i.phone ?? "")}
                    {i.channel !== "whatsapp" && i.account_label ? <span className="ct-soft"> · {i.account_label}</span> : null}
                  </span>
                  <span className="ct-soft">{i.last_seen_at ? `last seen ${lagosDate(i.last_seen_at)}` : ""}</span>
                </li>
              ))}
              {contact.channels.includes("phone") && (
                <li>
                  <span>
                    <strong>Phone call</strong> {contact.phone ?? ""}
                  </span>
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="card ct-card" aria-label="Orders">
          <h2 className="ct-card__h">Orders</h2>
          {contact.orders.count === 0 && contact.orders.recent.length === 0 ? (
            <p className="ct-soft">No orders yet.</p>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 14 }}>
                {contact.orders.count} order{contact.orders.count === 1 ? "" : "s"} · {naira(contact.orders.spent_ngn)}
                {contact.orders.first_at ? ` · first ${lagosDate(contact.orders.first_at)} · last ${lagosDate(contact.orders.last_at)}` : ""}
              </p>
              <ul className="ct-rows">
                {contact.orders.recent.map((o) => (
                  <li key={o.id}>
                    <span>
                      <strong>{o.order_number}</strong> <span className="ct-soft">{lagosDate(o.created_at)}</span>
                    </span>
                    <span>
                      {naira(o.total_ngn)} <span className="ct-soft">· {o.status.replace(/_/g, " ")}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <a className="ct-linkish" href={contact.shop_profile_url} target="_blank" rel="noreferrer">
            See all orders in the shop admin
          </a>
        </section>

        <section className="card ct-card" aria-label="Conversations">
          <h2 className="ct-card__h">Conversations</h2>
          {!contact.can_see_conversations ? (
            <p className="ct-soft">You don&apos;t have access to conversations.</p>
          ) : contact.conversations.length === 0 ? (
            <p className="ct-soft">No conversations you can see.</p>
          ) : (
            <>
              <ul className="ct-rows">
                {contact.conversations.map((v) => (
                  <li key={v.id}>
                    <Link to="/inbox/$conversationId" params={{ conversationId: v.id }}>
                      {CHANNEL_TEXT[v.channel as keyof typeof CHANNEL_TEXT] ?? v.channel} · {v.number_label}
                    </Link>
                    <span className="ct-soft">
                      {v.status} · {lagosDate(v.last_activity_at)}
                    </span>
                  </li>
                ))}
              </ul>
              {contact.conversation_labels.length > 0 && <p className="ct-soft">Labels on their chats: {contact.conversation_labels.join(", ")}</p>}
            </>
          )}
        </section>

        <section className="card ct-card" aria-label="Labels and lists">
          <h2 className="ct-card__h">
            Labels and lists
            {manage && (
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("labels")}>
                Change
              </button>
            )}
          </h2>
          <div className="ct-pills">
            {contact.labels.length === 0 ? (
              <span className="ct-soft">No labels.</span>
            ) : (
              contact.labels.map((l) => (
                <span key={l.id} className={`ct-label ct-label--${l.colour}`}>
                  {l.name}
                </span>
              ))
            )}
          </div>
          {contact.lists.length === 0 ? (
            <p className="ct-soft">Not on any list.</p>
          ) : (
            <ul className="ct-rows">
              {contact.lists.map((l) => (
                <li key={l.id}>
                  <Link to="/contacts/lists/$listId" params={{ listId: l.id }}>
                    {l.name}
                  </Link>
                  {l.kind === "smart" ? (
                    <span className="ct-soft">(fills itself)</span>
                  ) : manage ? (
                    <button type="button" className="ct-linkish" onClick={() => setRemoving({ id: l.id, name: l.name })}>
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {manage && (
            <div>
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("add-to-list")}>
                Add to a list
              </button>
            </div>
          )}
        </section>

        <section className="card ct-card ct-card--wide" aria-label="Changes">
          <h2 className="ct-card__h">Changes</h2>
          <DataState
            loading={history.isLoading}
            error={history.error}
            isEmpty={(history.data?.edits ?? []).length === 0}
            emptyTitle="No changes yet"
            emptyHint="Edits made here or in the inbox show up in this list."
            onRetry={() => void history.refetch()}
          >
            <ul className="ct-rows">
              {(history.data?.edits ?? []).map((e, i) => (
                <li key={`${e.at}:${i}`}>
                  <span>{editLine(e)}</span>
                  <span className="ct-soft">{lagosDate(e.at)}</span>
                </li>
              ))}
            </ul>
          </DataState>
        </section>
      </div>

      {dialog === "edit" && (
        <EditContactDialog
          contact={contact}
          onClose={() => setDialog(null)}
          onSaved={(c) => {
            qc.setQueryData(contactKeys.one(contact.id), c);
            setDialog(null);
            toast.success("Saved.");
            void refresh();
          }}
        />
      )}
      {dialog === "consent" && (
        <ConsentDialog
          customerId={contact.id}
          current={contact.consent_now}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.success("Saved.");
            void refresh();
          }}
        />
      )}
      {dialog === "labels" && (
        <LabelsDialog
          target={{ kind: "contact", customerId: contact.id, current: contact.labels.map((l) => l.id) }}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog === "add-to-list" && (
        <AddToListDialog
          selection={{ mode: "ids", ids: [contact.id] }}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog === "history" && <ConsentHistory history={history.data ?? null} onClose={() => setDialog(null)} />}
      {removing && (
        <ConfirmModal
          title="Remove from list"
          confirmLabel="Remove"
          busyLabel="Removing…"
          busy={busy}
          tone="danger"
          onCancel={() => setRemoving(null)}
          onConfirm={() => void removeFromList()}
        >
          <p style={{ margin: 0 }}>
            Remove {contact.name ?? "this contact"} from “{removing.name}”?
          </p>
        </ConfirmModal>
      )}
    </>
  );
}

function ConsentHistory({ history, onClose }: { history: ContactHistory | null; onClose: () => void }): JSX.Element {
  const rows = history?.consent ?? [];
  return (
    <Modal title="Consent history" onClose={onClose} maxWidth={600}>
      {rows.length === 0 ? (
        <p className="ct-soft">Nothing has been recorded yet.</p>
      ) : (
        <ul className="ct-rows" style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {rows.map((r) => (
            <li key={r.id} style={{ display: "block" }}>
              <div>
                <strong>{consentTitle(r.channel, r.purpose)}:</strong> {r.state === "granted" ? "agreed" : "asked us to stop"} on {lagosDate(r.recorded_at)} (
                {consentHow(r.method, r.state, r.recorded_by_name)}){r.is_current ? " · current" : ""}
              </div>
              {r.wording && <div className="ct-soft">{r.state === "granted" && (r.method === "staff" || r.method === "import") ? "What they agreed to" : "Recorded as"}: {r.wording}</div>}
              {r.collected_on && <div className="ct-soft">Given on {plainDate(r.collected_on)}</div>}
              {r.note && <div className="ct-soft">Note: {r.note}</div>}
            </li>
          ))}
        </ul>
      )}
      <div className="ct-dialog-buttons">
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
