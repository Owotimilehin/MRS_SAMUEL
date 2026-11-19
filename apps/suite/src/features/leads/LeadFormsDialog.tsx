/**
 * Lead forms (suite spec 13, 7.4): the connection to Meta, the Page's forms,
 * and for each form which WhatsApp number to use, which tick-box means "you may
 * message me on WhatsApp", and "Fetch earlier leads".
 *
 * Read-only without channels.manage. Confirmations are shown in place (no
 * dialog inside a dialog).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { leadKeys, leadsApi, type LeadFormRow } from "./leads-api.js";
import { backfillLine, formStatusLabel } from "./leads-logic.js";

export function LeadFormsDialog({ startAt, onClose }: { startAt: "forms" | "connection"; onClose: () => void }): JSX.Element {
  const can = useCan();
  const manage = can("channels.manage");
  const qc = useQueryClient();
  const forms = useQuery({
    queryKey: leadKeys.forms,
    queryFn: leadsApi.forms,
    // While earlier leads are being fetched, show the count moving.
    refetchInterval: (query) => (query.state.data?.data.some((f) => f.backfill.requested_at && !f.backfill.done_at) ? 10_000 : false),
  });
  const [refreshing, setRefreshing] = useState(false);

  async function refreshForms(): Promise<void> {
    setRefreshing(true);
    try {
      const r = await leadsApi.syncForms();
      toast.success(r.forms === 1 ? "Found 1 form." : `Found ${r.forms} forms.`);
      await qc.invalidateQueries({ queryKey: leadKeys.forms });
    } catch {
      /* toast shown by api() */
    } finally {
      setRefreshing(false);
    }
  }

  const rows = forms.data?.data ?? [];
  const lines = forms.data?.lines ?? [];

  return (
    <Modal title="Lead forms" onClose={onClose} maxWidth={720}>
      <div style={{ display: "grid", gap: 16 }}>
        {!manage && <p className="ld-fine">Only people who manage channels can change these settings.</p>}
        {manage ? (
          <Connection highlight={startAt === "connection"} />
        ) : (
          startAt === "connection" && (
            <div className="ld-strip ld-strip--amber">
              <span>
                Ask the owner to open Leads → Forms and press Check connection. Leads cannot be read until Meta&apos;s “Leads Access” setting
                includes the suite.
              </span>
            </div>
          )
        )}

        <section className="ld-section">
          <div className="ld-form__head">
            <div className="t-eyebrow">Forms</div>
            {manage && (
              <button type="button" className="btn btn--subtle btn--sm" disabled={refreshing} onClick={() => void refreshForms()}>
                {refreshing ? "Refreshing…" : "Refresh forms"}
              </button>
            )}
          </div>
          <DataState loading={forms.isLoading} error={forms.error} onRetry={() => void forms.refetch()}>
            {rows.length === 0 ? (
              <div className="empty">
                No forms yet. Create one for your Page in Meta Business Suite (All tools → Instant Forms), then press Refresh forms.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {rows.map((f) => (
                  <FormCard key={f.id} form={f} lines={lines} manage={manage} />
                ))}
              </div>
            )}
          </DataState>
        </section>
      </div>
    </Modal>
  );
}

function Connection({ highlight }: { highlight: boolean }): JSX.Element {
  const qc = useQueryClient();
  const health = useQuery({ queryKey: leadKeys.health, queryFn: leadsApi.health, staleTime: 60_000 });
  const [askTurnOn, setAskTurnOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const h = health.data;

  async function turnOn(): Promise<void> {
    setBusy(true);
    try {
      await leadsApi.subscribe();
      toast.success("Meta will now send us this Page's new leads.");
      setAskTurnOn(false);
      await qc.invalidateQueries({ queryKey: leadKeys.health });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ld-section" style={highlight ? { border: "1px solid var(--line)", borderRadius: 14, padding: 12 } : undefined}>
      <div className="ld-form__head">
        <div className="t-eyebrow">Connection</div>
        <button type="button" className="btn btn--subtle btn--sm" disabled={health.isFetching} onClick={() => void health.refetch()}>
          {health.isFetching ? "Checking…" : "Check connection"}
        </button>
      </div>
      {health.isLoading ? (
        <p className="ld-fine">Checking the connection to Meta…</p>
      ) : health.error || !h ? (
        <p className="ld-fine">We couldn&apos;t check the connection. Press Check connection to try again.</p>
      ) : (
        <>
          <div>{h.page ? `Page: ${h.page.name}` : "No Facebook Page is connected. Connect one under Channels."}</div>
          {h.page && (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>Meta is sending us new leads: {h.subscribed ? "Yes" : "No"}</span>
                {!h.subscribed && h.token_ok && !askTurnOn && (
                  <button type="button" className="btn btn--primary btn--sm" onClick={() => setAskTurnOn(true)}>
                    Turn on
                  </button>
                )}
              </div>
              {askTurnOn && (
                <div className="ld-inline-confirm">
                  <div>Ask Meta to send this Page&apos;s new leads to the suite?</div>
                  <div className="ld-buttons">
                    <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void turnOn()}>
                      {busy ? "Turning on…" : "Yes, turn on"}
                    </button>
                    <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => setAskTurnOn(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <div>We can read this Page&apos;s forms: {h.can_list_forms ? "Yes" : "No"}</div>
            </>
          )}
          {h.problems.map((p) => (
            <div key={p.code + p.plain} className="ld-strip ld-strip--red" role="alert" style={{ marginBottom: 0 }}>
              <span>{p.plain}</span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function FormCard({ form, lines, manage }: { form: LeadFormRow; lines: { id: string; label: string }[]; manage: boolean }): JSX.Element {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [askBackfill, setAskBackfill] = useState(false);
  const backfillRunning = !!form.backfill.requested_at && !form.backfill.done_at;
  const backfill = backfillLine(form.backfill);
  const status = formStatusLabel(form.status);

  async function patch(b: Parameters<typeof leadsApi.updateForm>[1]): Promise<void> {
    setBusy(true);
    try {
      await leadsApi.updateForm(form.id, b);
      toast.success("Saved");
      await Promise.all([qc.invalidateQueries({ queryKey: leadKeys.forms }), qc.invalidateQueries({ queryKey: ["leads", "detail"] })]);
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  async function startBackfill(): Promise<void> {
    setBusy(true);
    try {
      await leadsApi.backfill(form.id);
      setAskBackfill(false);
      await qc.invalidateQueries({ queryKey: leadKeys.forms });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ld-form">
      <div className="ld-form__head">
        <strong style={{ overflowWrap: "anywhere" }}>{form.name}</strong>
        <span className="ld-fine">
          {status ? `${status} · ` : ""}
          {form.leads_30d} {form.leads_30d === 1 ? "lead" : "leads"} in the last 30 days
        </span>
      </div>

      <label className="ld-check" style={{ minHeight: 0 }}>
        <input type="checkbox" checked={form.is_enabled} disabled={!manage || busy} onChange={(e) => void patch({ is_enabled: e.target.checked })} />
        Bring this form&apos;s leads into the suite
      </label>
      {!form.is_enabled && <p className="ld-fine">Leads from this form are saved but no conversation is opened and nobody is alerted.</p>}

      <label className="field">
        <span className="field__label">WhatsApp number to use</span>
        <select
          className="select"
          value={form.phone_number_id ?? ""}
          disabled={!manage || busy}
          onChange={(e) => void patch({ phone_number_id: e.target.value || null })}
        >
          <option value="">Default</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Permission to message on WhatsApp</span>
        <select
          className="select"
          value={form.whatsapp_consent_key ?? ""}
          disabled={!manage || busy}
          onChange={(e) => void patch({ whatsapp_consent_key: e.target.value || null })}
        >
          <option value="">None of these</option>
          {form.disclaimers.map((d) => (
            <option key={d.key} value={d.key}>
              {d.text ? (d.text.length > 90 ? `${d.text.slice(0, 89)}…` : d.text) : d.key}
            </option>
          ))}
        </select>
        <span className="field__hint">
          Choose the tick-box where the person agrees to be contacted on WhatsApp. Leads who ticked it can be sent the follow-up.
        </span>
      </label>
      <label className="ld-check" style={{ minHeight: 0, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={form.consent_covers_whatsapp}
          disabled={!manage || busy}
          style={{ marginTop: 3 }}
          onChange={(e) => void patch({ consent_covers_whatsapp: e.target.checked })}
        />
        <span>
          This form&apos;s own wording already says we will contact them on WhatsApp
          <span className="ld-fine" style={{ display: "block" }}>
            Only tick this if the form says so in its introduction or privacy text.
          </span>
        </span>
      </label>

      {manage && !askBackfill && (
        <div className="ld-buttons">
          <button type="button" className="btn btn--subtle btn--sm" disabled={busy || backfillRunning} onClick={() => setAskBackfill(true)}>
            Fetch earlier leads
          </button>
        </div>
      )}
      {askBackfill && (
        <div className="ld-inline-confirm">
          <div>
            Bring in leads from the last 90 days for “{form.name}”? They will be marked “Earlier lead”. Nobody is alerted and no messages are
            sent.
          </div>
          <div className="ld-buttons">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void startBackfill()}>
              {busy ? "Starting…" : "Fetch earlier leads"}
            </button>
            <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => setAskBackfill(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {backfill && <p className="ld-fine">{backfill}</p>}
    </div>
  );
}
