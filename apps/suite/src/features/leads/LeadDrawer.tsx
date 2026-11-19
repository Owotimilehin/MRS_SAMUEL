/**
 * One lead (suite spec 13, 7.3): their answers, what they agreed to, status,
 * owner, note, and the two actions (open the conversation; send the approved
 * WhatsApp follow-up after a confirmation that shows exactly what will go).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { humanizeError } from "@admin/lib/api.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { leadKeys, leadsApi, type LeadDetail, type LeadStatus, type LostReason } from "./leads-api.js";
import { advertLine, followUpBlockedText, leadName, LOST_REASONS, lostReasonLabel, plainDate, receivedLabel, statusChip, STATUS_ORDER } from "./leads-logic.js";

export function LeadDrawer({ leadId, onClose }: { leadId: string; onClose: () => void }): JSX.Element {
  const q = useQuery({ queryKey: leadKeys.detail(leadId), queryFn: () => leadsApi.detail(leadId), retry: false });
  const [dialogOpen, setDialogOpen] = useState(false);

  // Escape closes the drawer, unless one of its own dialogs is open (that dialog takes the key).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !dialogOpen) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialogOpen, onClose]);

  return (
    <>
      <div className="ld-scrim" aria-hidden="true" onClick={onClose} />
      <aside className="ld-drawer" role="dialog" aria-label="Lead">
        {q.isLoading ? (
          <DrawerHead title="Loading…" onClose={onClose} />
        ) : q.error || !q.data ? (
          <>
            <DrawerHead title="Lead" onClose={onClose} />
            <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
              <div>We couldn&apos;t load this lead. It may have been removed.</div>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void q.refetch()}>
                Try again
              </button>
            </div>
          </>
        ) : (
          <LeadBody lead={q.data} onClose={onClose} onDialog={setDialogOpen} />
        )}
      </aside>
    </>
  );
}

function DrawerHead({ title, onClose, children }: { title: string; onClose: () => void; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="ld-drawer__head">
      <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
        <h2>{title}</h2>
        {children}
      </div>
      <button type="button" className="btn btn--subtle btn--sm" aria-label="Close" onClick={onClose}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

function LeadBody({ lead, onClose, onDialog }: { lead: LeadDetail; onClose: () => void; onDialog: (open: boolean) => void }): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const staff = useQuery({ queryKey: leadKeys.staff, queryFn: leadsApi.staff, staleTime: 5 * 60_000 });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(lead.note ?? "");
  const [askLost, setAskLost] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason | "">("");
  const [askFollowUp, setAskFollowUp] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => setNote(lead.note ?? ""), [lead.id, lead.note]);
  useEffect(() => onDialog(askLost || askFollowUp), [askLost, askFollowUp, onDialog]);

  const chip = statusChip(lead.status);
  const advert = advertLine(lead);
  const blockedText = followUpBlockedText(lead.follow_up_blocked_reason);
  const alreadySent = !!lead.followup_sent_at;
  const differentName =
    lead.customer_name && lead.full_name && lead.customer_name.trim().toLowerCase() !== lead.full_name.trim().toLowerCase();

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: leadKeys.all });
  };

  async function save(patch: Parameters<typeof leadsApi.update>[1], done?: string): Promise<boolean> {
    setBusy(true);
    try {
      await leadsApi.update(lead.id, patch);
      if (done) toast.success(done);
      await refresh();
      return true;
    } catch {
      return false; /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  function chooseStatus(s: LeadStatus): void {
    if (s === lead.status) return;
    if (s === "lost") {
      setLostReason("");
      setAskLost(true);
      return;
    }
    void save({ status: s });
  }

  async function openConversation(): Promise<void> {
    setBusy(true);
    try {
      const r = await leadsApi.openConversation(lead.id);
      await refresh();
      void navigate({ to: "/inbox/$conversationId", params: { conversationId: r.conversation_id } });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  async function sendFollowUp(): Promise<void> {
    setSending(true);
    setSendError(null);
    try {
      await leadsApi.followUp(lead.id, alreadySent);
      toast.success("Follow-up sent.");
      setAskFollowUp(false);
    } catch (err) {
      // The dialog stays open with the server's own sentence; nothing is sent again without another click.
      setSendError(humanizeError(err));
    } finally {
      setSending(false);
      await refresh();
    }
  }

  return (
    <>
      <DrawerHead title={leadName(lead)} onClose={onClose}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className={`pill pill--${chip.tone}`}>{chip.label}</span>
          {lead.status === "lost" && lead.lost_reason && <span className="ld-fine">{lostReasonLabel(lead.lost_reason)}</span>}
          {lead.is_backfill && <span className="ibx-chip">Earlier lead</span>}
        </div>
        <p className="ld-fine">{receivedLabel(lead.received_at)}</p>
        <p className="ld-fine">Form: {lead.form_name}</p>
        {advert && <p className="ld-fine">{advert}</p>}
      </DrawerHead>

      <section className="ld-section">
        <div className="t-eyebrow">Their answers</div>
        {lead.erased ? (
          <div>This person asked us to delete their details.</div>
        ) : lead.answers.length === 0 ? (
          <div className="ld-fine">No answers were given.</div>
        ) : (
          <dl className="ld-answers">
            {lead.answers.map((a) => (
              <div key={a.key}>
                <dt>{a.label}</dt>
                <dd>{a.values.join(", ") || "–"}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {!lead.erased && (
        <section className="ld-section">
          <div className="t-eyebrow">Contact</div>
          {lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : <div className="ld-fine">No phone number was given.</div>}
          {lead.email && <a href={`mailto:${lead.email}`}>{lead.email}</a>}
          {differentName && (
            <div className="ld-fine">
              Already a customer: {lead.customer_name}. The form says “{lead.full_name}”.
            </div>
          )}
        </section>
      )}

      {!lead.erased && (
        <section className="ld-section">
          <div className="t-eyebrow">What they agreed to</div>
          {!lead.consent || (lead.consent.disclaimers.length === 0 && !lead.consent.privacy_policy_url) ? (
            <div className="ld-fine">We could not read the form&apos;s wording from Meta. Open the form in Meta to see it.</div>
          ) : (
            <>
              {lead.consent.disclaimers.map((d) => (
                <div key={d.key}>
                  <div>{d.text || "A tick-box on the form (wording not available)"}</div>
                  <div className="ld-fine">{d.is_checked ? "Ticked" : "Not ticked"}</div>
                </div>
              ))}
              {lead.consent.privacy_policy_url && (
                <a href={lead.consent.privacy_policy_url} target="_blank" rel="noreferrer">
                  Privacy policy shown on the form
                </a>
              )}
            </>
          )}
        </section>
      )}

      <section className="ld-section">
        <div className="t-eyebrow">Status</div>
        <div className="ld-buttons" role="group" aria-label="Status">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn btn--sm ${lead.status === s ? "btn--primary" : "btn--subtle"}`}
              aria-pressed={lead.status === s}
              disabled={busy}
              onClick={() => chooseStatus(s)}
            >
              {statusChip(s).label}
            </button>
          ))}
        </div>
      </section>

      <section className="ld-section">
        <label className="field">
          <span className="field__label">Owner</span>
          <select
            className="select"
            value={lead.assignee?.id ?? ""}
            disabled={busy}
            onChange={(e) => void save({ assignee_id: e.target.value || null }, "Saved")}
          >
            <option value="">No one</option>
            {lead.assignee && !(staff.data ?? []).some((s) => s.id === lead.assignee?.id) && (
              <option value={lead.assignee.id}>{lead.assignee.name}</option>
            )}
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Note</span>
          <textarea
            className="textarea"
            rows={3}
            maxLength={2000}
            value={note}
            style={{ height: "auto", padding: "10px 14px" }}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              if (note !== (lead.note ?? "")) void save({ note }, "Saved");
            }}
          />
          <span className="field__hint">Only staff can see this.</span>
        </label>
      </section>

      <section className="ld-section">
        <div className="t-eyebrow">Actions</div>
        <div className="ld-buttons">
          {can("inbox.view") && (
            <button type="button" className="btn btn--subtle btn--sm" disabled={busy || !lead.can_open_conversation} onClick={() => void openConversation()}>
              Open conversation
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy || !lead.can_follow_up || !lead.follow_up_preview}
            onClick={() => {
              setSendError(null);
              setAskFollowUp(true);
            }}
          >
            {alreadySent ? "Send again" : "Send WhatsApp follow-up"}
          </button>
        </div>
        {blockedText && <p className="ld-fine">{blockedText}</p>}
        {alreadySent && lead.followup_sent_at && <p className="ld-fine">Follow-up sent on {plainDate(lead.followup_sent_at)}.</p>}
      </section>

      {askLost && (
        <ConfirmModal
          title="Why?"
          confirmLabel="Mark as lost"
          busyLabel="Saving…"
          busy={busy}
          confirmDisabled={!lostReason}
          onCancel={() => setAskLost(false)}
          onConfirm={() => {
            if (!lostReason) return;
            void save({ status: "lost", lost_reason: lostReason }).then((ok) => {
              if (ok) setAskLost(false);
            });
          }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            {LOST_REASONS.map((r) => (
              <label key={r.value} className="ld-check" style={{ minHeight: 0 }}>
                <input type="radio" name="lost-reason" checked={lostReason === r.value} onChange={() => setLostReason(r.value)} />
                {r.label}
              </label>
            ))}
          </div>
        </ConfirmModal>
      )}

      {askFollowUp && lead.follow_up_preview && (
        <ConfirmModal
          title="Send the follow-up on WhatsApp?"
          confirmLabel="Send"
          busyLabel="Sending…"
          busy={sending}
          onCancel={() => setAskFollowUp(false)}
          onConfirm={() => void sendFollowUp()}
        >
          {alreadySent && lead.followup_sent_at && <p>You already sent this on {plainDate(lead.followup_sent_at)}.</p>}
          <p style={{ margin: 0 }}>
            {leadName(lead)} will receive this message on {lead.follow_up_preview.phone} from {lead.follow_up_preview.line_label}:
          </p>
          <div className="ld-quote">{lead.follow_up_preview.text}</div>
          <p className="ld-fine">WhatsApp may charge for this message.</p>
          {sendError && (
            <p className="field__error" role="alert">
              Not sent: {sendError}
            </p>
          )}
        </ConfirmModal>
      )}
    </>
  );
}
