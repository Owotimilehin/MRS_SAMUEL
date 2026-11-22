/**
 * The broadcast editor (suite spec 14, 7.9): five numbered sections beside a preview of the
 * message. "/broadcasts/new" asks for sections 1 to 3 and makes a draft; the draft's own page
 * adds the blanks, who will get it, the test and the send.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { Frame } from "@admin/lib/app-frame.js";
import { toast } from "@admin/lib/toast.js";
import {
  BROADCAST_HEADER_MIMES,
  BROADCAST_LIMITS,
  blanksProblem,
  componentsToDraft,
  fillBlanks,
  groupThousands,
  previewText,
  scheduleProblem,
  type BroadcastBlanks,
  type BroadcastDetail,
  type BroadcastOptions,
} from "@ms/shared";
import { TemplatePreview } from "../templates/TemplatePreview.js";
import "../templates/templates.css";
import { broadcastKeys, broadcastsApi, failureText, uploadPicture } from "./broadcasts-api.js";
import { isoToLagosInput, lagosInputToIso, reviewBlocker, whenText } from "./broadcasts-logic.js";
import { AudiencePanel } from "./AudiencePanel.js";
import { BlankFiller } from "./BlankFiller.js";
import { ConfirmSendDialog } from "./ConfirmSendDialog.js";
import { TestSendPanel } from "./TestSendPanel.js";
import "./broadcasts.css";

function Section({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }): JSX.Element {
  return (
    <section className="card bc-section" aria-labelledby={`bc-s${n}`}>
      <div className="bc-section__head">
        <span className={`bc-section__num${done ? " is-done" : ""}`} aria-hidden="true">
          {done ? <Check size={15} /> : n}
        </span>
        <h3 className="bc-section__title" id={`bc-s${n}`}>
          {title}
          {done && <span className="bc-sr"> (complete)</span>}
        </h3>
      </div>
      {children}
    </section>
  );
}

function ListPicker({ lists, value, onPick }: { lists: BroadcastOptions["lists"]; value: string | null; onPick: (id: string) => void }): JSX.Element {
  if (lists.length === 0) {
    return (
      <div className="bc-notice">
        <span>You have no lists yet.</span>
        <span>
          <Link to="/contacts" className="bc-link">
            Go to Contacts
          </Link>
        </span>
      </div>
    );
  }
  return (
    <>
      <p className="bc-soft">Make lists on the Contacts page.</p>
      <div className="bc-picks" role="radiogroup" aria-label="List">
        {lists.map((l) => (
          <button key={l.id} type="button" role="radio" aria-checked={value === l.id} className={`bc-pick${value === l.id ? " is-on" : ""}`} onClick={() => onPick(l.id)}>
            <span className="bc-pick__name">{l.name}</span>
            <span className="bc-pick__body">
              {groupThousands(l.count)} {l.count === 1 ? "person" : "people"} · {l.kind === "smart" ? "Fills itself" : "Picked by hand"}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function TemplatePicker({ templates, waba, value, onPick }: { templates: BroadcastOptions["templates"]; waba: string | null; value: string | null; onPick: (id: string) => void }): JSX.Element {
  const mine = templates.filter((t) => !waba || t.waba_id === waba);
  if (mine.length === 0) {
    return (
      <div className="bc-notice">
        <span>No approved promotion templates yet. Write one under Templates and forms.</span>
        <span>
          <Link to="/templates" className="bc-link">
            Templates and forms
          </Link>
        </span>
      </div>
    );
  }
  return (
    <div className="bc-picks" role="radiogroup" aria-label="Template">
      {mine.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={value === t.id}
          disabled={!t.usable}
          className={`bc-pick${value === t.id ? " is-on" : ""}`}
          onClick={() => onPick(t.id)}
        >
          <span className="bc-pick__name">{t.name}</span>
          <span className="bc-row">
            <span className="pill pill--ink">{t.category === "MARKETING" ? "Promotion" : "Update"}</span>
            {t.quality_score && <span className="bc-faint">Quality {t.quality_score.toLowerCase()}</span>}
          </span>
          <span className="bc-pick__body">{t.body_text}</span>
          {!t.usable && t.why_not && <span className="bc-pick__why">{t.why_not}</span>}
        </button>
      ))}
    </div>
  );
}

function Preview({ components, category, blanks }: { components: unknown[] | null; category: string | null; blanks: BroadcastBlanks }): JSX.Element | null {
  const draft = useMemo(() => {
    if (!components) return null;
    const d = componentsToDraft(components, category);
    if (!d) return null;
    return { ...d, body: { ...d.body, examples: fillBlanks(blanks, { name: null }).body } };
  }, [components, category, blanks]);
  if (!draft) return null;
  return (
    <aside className="bc-preview">
      <span className="bc-preview__label">What the customer sees</span>
      <TemplatePreview draft={draft} />
    </aside>
  );
}

// ── New: sections 1 to 3, then a draft ─────────────────────────────────────

function NewBroadcast(): JSX.Element {
  const navigate = useNavigate();
  const options = useQuery({ queryKey: broadcastKeys.options, queryFn: broadcastsApi.options, refetchOnWindowFocus: false });
  const [name, setName] = useState("");
  const [line, setLine] = useState<string | null>(null);
  const [list, setList] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const o = options.data;
  const lineId = line ?? o?.lines[0]?.id ?? null;
  const waba = o?.lines.find((l) => l.id === lineId)?.waba_id ?? null;
  const tpl = o?.templates.find((t) => t.id === template) ?? null;

  const create = async () => {
    if (!lineId || !list || !template) return;
    setBusy(true);
    setError(null);
    try {
      const d = await broadcastsApi.create({ name: name.trim(), phone_number_id: lineId, list_id: list, template_id: template });
      void navigate({ to: "/broadcasts/$broadcastId/edit", params: { broadcastId: d.id } });
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  };

  return (
    <Frame title="New broadcast" crumb="Broadcasts">
      <div className="bc-page">
        <div>
          <Link to="/broadcasts" className="bc-link">
            ← All broadcasts
          </Link>
        </div>
        {options.error && <p className="bc-notice bc-notice--red">{failureText(options.error)}</p>}
        {!o ? (
          !options.error && <p className="bc-soft">Loading…</p>
        ) : (
          <div className="bc-editor">
            <div className="bc-sections">
              <Section n={1} title="Name and number" done={!!name.trim() && !!lineId}>
                <label className="bc-field">
                  <span>Name</span>
                  <input className="input" value={name} maxLength={BROADCAST_LIMITS.name} onChange={(e) => setName(e.target.value)} />
                  <small>For your own records. Customers don't see it.</small>
                </label>
                <label className="bc-field">
                  <span>Send from</span>
                  {o.lines.length === 0 ? (
                    <small>There is no WhatsApp number set up yet.</small>
                  ) : (
                    <select className="select" value={lineId ?? ""} onChange={(e) => (setLine(e.target.value), setTemplate(null))}>
                      {o.lines.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label}
                          {l.e164 ? ` (${l.e164})` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              </Section>
              <Section n={2} title="Who" done={!!list}>
                <ListPicker lists={o.lists} value={list} onPick={setList} />
              </Section>
              <Section n={3} title="Message" done={!!tpl?.usable}>
                <TemplatePicker templates={o.templates} waba={waba} value={template} onPick={setTemplate} />
              </Section>
              {error && <p className="bc-notice bc-notice--red">{error}</p>}
              <div className="bc-row">
                <span className="bc-spacer" />
                <button type="button" className="btn btn--primary" disabled={busy || !name.trim() || !lineId || !list || !tpl?.usable} onClick={() => void create()}>
                  {busy ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
            {tpl && <Preview components={tpl.components} category={tpl.category} blanks={{ body: [{ from: "first_name", fallback: "there" }] }} />}
          </div>
        )}
      </div>
    </Frame>
  );
}

// ── A draft: all five sections ─────────────────────────────────────────────

function DraftEditor({ detail, options }: { detail: BroadcastDetail; options: BroadcastOptions }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const id = detail.id;
  const [name, setName] = useState(detail.name);
  const [blanks, setBlanks] = useState<BroadcastBlanks>(detail.blanks);
  const [dirty, setDirty] = useState(false);
  const [when, setWhen] = useState<"now" | "scheduled">(detail.scheduled_at ? "scheduled" : "now");
  const [later, setLater] = useState(isoToLagosInput(detail.scheduled_at));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!dirty) setBlanks(detail.blanks);
  }, [detail.blanks, dirty]);

  const audience = useQuery({
    queryKey: broadcastKeys.audience(id, "summary"),
    queryFn: () => broadcastsApi.audience(id),
    enabled: !!detail.list_id && !!detail.template_id,
    refetchOnWindowFocus: false,
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: broadcastKeys.one(id) });
    await qc.invalidateQueries({ queryKey: ["broadcasts", "audience", id] });
  };
  const patch = async (b: Parameters<typeof broadcastsApi.update>[1]) => {
    setSaving(true);
    setError(null);
    try {
      await broadcastsApi.update(id, b);
      await refresh();
      return true;
    } catch (err) {
      setError(failureText(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const needs = detail.needs;
  const line = options.lines.find((l) => l.id === detail.phone_number_id) ?? null;
  const blanksOk = !!needs && blanksProblem(blanks, needs) === null && !dirty;
  const pictureOk = !needs?.headerMedia || !!detail.header_media;
  const templateOk = !!detail.template_id && detail.template_why_not === null;
  const scheduledIso = when === "scheduled" ? lagosInputToIso(later) : null;
  const schedProblem =
    when === "scheduled" ? scheduleProblem(scheduledIso ? new Date(scheduledIso) : null, new Date(), { send_from: detail.send_from, send_until: detail.send_until }) : null;
  const blocker = reviewBlocker({
    enabled: detail.enabled,
    nameOk: !!detail.name.trim(),
    listChosen: !!detail.list_id,
    templateOk,
    blanksOk,
    pictureOk,
    audience: audience.data ?? null,
    test: detail.test,
    when,
    scheduleProblem: schedProblem ?? (when === "scheduled" && scheduledIso !== detail.scheduled_at ? "Saving the time…" : null),
  });
  const testBlocker = !templateOk ? "Pick a template that can be used." : !blanksOk ? (dirty ? "Save the blanks first." : "Fill in every blank first.") : !pictureOk ? "Add the picture first." : null;

  const choosePicture = async (f: File) => {
    if (!(BROADCAST_HEADER_MIMES as readonly string[]).includes(f.type)) return setError("Choose a JPG or PNG picture.");
    if (f.size > BROADCAST_LIMITS.headerMaxBytes) return setError("The picture must be 5 MB or smaller.");
    setUploading(true);
    setError(null);
    try {
      const up = await broadcastsApi.headerUpload(id, f.type, f.size);
      await uploadPicture(up.upload_url, f);
      await refresh();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete the draft “${detail.name}”?`)) return;
    try {
      await broadcastsApi.remove(id);
      await qc.invalidateQueries({ queryKey: broadcastKeys.list });
      void navigate({ to: "/broadcasts" });
    } catch (err) {
      setError(failureText(err));
    }
  };

  const example = detail.template_components ? previewText(detail.template_components, fillBlanks(blanks, { name: null })) : detail.preview_text;
  const skipped = audience.data ? audience.data.counts.list - audience.data.counts.will_send : 0;

  return (
    <div className="bc-editor">
      <div className="bc-sections">
        <Section n={1} title="Name and number" done={!!detail.name.trim() && !!line}>
          <label className="bc-field">
            <span>Name</span>
            <input
              className="input"
              value={name}
              maxLength={BROADCAST_LIMITS.name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name.trim() !== detail.name && void patch({ name: name.trim() })}
            />
            <small>For your own records. Customers don't see it.</small>
          </label>
          <label className="bc-field">
            <span>Send from</span>
            <select className="select" value={detail.phone_number_id} onChange={(e) => void patch({ phone_number_id: e.target.value })}>
              {options.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                  {l.e164 ? ` (${l.e164})` : ""}
                </option>
              ))}
            </select>
          </label>
        </Section>

        <Section n={2} title="Who" done={!!detail.list_id}>
          <ListPicker lists={options.lists} value={detail.list_id} onPick={(listId) => void patch({ list_id: listId })} />
        </Section>

        <Section n={3} title="Message" done={templateOk}>
          {detail.template_why_not && detail.template_id && <p className="bc-notice bc-notice--amber">{detail.template_why_not}</p>}
          <TemplatePicker
            templates={options.templates}
            waba={line?.waba_id ?? null}
            value={detail.template_id}
            onPick={(templateId) => {
              setDirty(false);
              void patch({ template_id: templateId });
            }}
          />
        </Section>

        <Section n={4} title="Fill the blanks" done={blanksOk && pictureOk}>
          {needs ? (
            <>
              <BlankFiller
                needs={needs}
                blanks={blanks}
                onChange={(b) => {
                  setBlanks(b);
                  setDirty(true);
                }}
                noName={audience.data?.no_name ?? null}
                picture={needs.headerMedia === "image" ? { has: !!detail.header_media, busy: uploading, onChoose: (f) => void choosePicture(f) } : null}
              />
              {dirty && (
                <div className="bc-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={saving}
                    onClick={async () => {
                      if (await patch({ blanks })) setDirty(false);
                    }}
                  >
                    {saving ? "Saving…" : "Save the blanks"}
                  </button>
                  <span className="bc-soft">{blanksProblem(blanks, needs) ?? "Saving changes the message, so you will need a new test."}</span>
                </div>
              )}
            </>
          ) : (
            <p className="bc-soft">Pick a template first.</p>
          )}
        </Section>

        <Section n={5} title="Check and send" done={blocker === null}>
          <h4 className="bc-section__title" style={{ fontSize: 14 }}>
            Who will get it
          </h4>
          {detail.list_id && detail.template_id ? (
            <AudiencePanel broadcastId={id} audience={audience.data} loading={audience.isLoading} error={audience.error} />
          ) : (
            <p className="bc-soft">Pick a list and a template first.</p>
          )}
          <h4 className="bc-section__title" style={{ fontSize: 14 }}>
            Send a test first
          </h4>
          <TestSendPanel broadcastId={id} myPhone={options.my_phone} test={detail.test} disabledReason={testBlocker} onSent={() => void refresh()} />
          <h4 className="bc-section__title" style={{ fontSize: 14 }}>
            When
          </h4>
          <div className="bc-seg" role="tablist" aria-label="When">
            <button type="button" role="tab" aria-selected={when === "now"} onClick={() => (setWhen("now"), detail.scheduled_at && void patch({ scheduled_at: null }))}>
              Send now
            </button>
            <button type="button" role="tab" aria-selected={when === "scheduled"} onClick={() => setWhen("scheduled")}>
              Send later
            </button>
          </div>
          {when === "scheduled" && (
            <label className="bc-field">
              <span>Date and time (Lagos)</span>
              <input
                className="input"
                type="datetime-local"
                value={later}
                onChange={(e) => setLater(e.target.value)}
                onBlur={() => {
                  const iso = lagosInputToIso(later);
                  if (iso && iso !== detail.scheduled_at) void patch({ scheduled_at: iso });
                }}
              />
              {schedProblem && <small>{schedProblem}</small>}
            </label>
          )}
          {error && <p className="bc-notice bc-notice--red">{error}</p>}
          <div className="bc-row">
            <button type="button" className="btn btn--primary" disabled={blocker !== null} onClick={() => setConfirming(true)}>
              Review and send
            </button>
            {blocker && <span className="bc-soft">{blocker}</span>}
            <span className="bc-spacer" />
            <button type="button" className="btn" onClick={() => void remove()}>
              Delete draft
            </button>
          </div>
        </Section>
      </div>
      <Preview components={detail.template_components} category={detail.template_category} blanks={blanks} />
      {confirming && audience.data && (
        <ConfirmSendDialog
          mode="confirm"
          count={audience.data.counts.will_send}
          templateName={detail.template_name ?? ""}
          listName={detail.list_name ?? ""}
          lineLabel={detail.line_label ?? "your number"}
          whenText={whenText(when, detail.scheduled_at)}
          scheduled={when === "scheduled"}
          exampleText={example}
          skipped={skipped}
          sendFrom={detail.send_from}
          sendUntil={detail.send_until}
          rate={detail.rate_per_minute}
          onClose={() => setConfirming(false)}
          onConfirm={async (n) => {
            try {
              const res = await broadcastsApi.confirm(id, n, when);
              await qc.invalidateQueries({ queryKey: broadcastKeys.all });
              toast.success(res.status === "scheduled" ? `Scheduled for ${groupThousands(res.recipients)} people.` : `Sending to ${groupThousands(res.recipients)} people.`);
              void navigate({ to: "/broadcasts/$broadcastId", params: { broadcastId: id } });
            } catch (err) {
              // A count that changed refreshes who will get it, so the person can check again.
              await qc.invalidateQueries({ queryKey: ["broadcasts", "audience", id] });
              throw err;
            }
          }}
        />
      )}
    </div>
  );
}

function EditBroadcast({ broadcastId }: { broadcastId: string }): JSX.Element {
  const detail = useQuery({ queryKey: broadcastKeys.one(broadcastId), queryFn: () => broadcastsApi.get(broadcastId), refetchOnWindowFocus: false });
  const options = useQuery({ queryKey: broadcastKeys.options, queryFn: broadcastsApi.options, refetchOnWindowFocus: false });
  const d = detail.data;
  return (
    <Frame title={d?.name ?? "Broadcast"} crumb="Broadcasts" pageName="Edit broadcast">
      <div className="bc-page">
        <div>
          <Link to="/broadcasts" className="bc-link">
            ← All broadcasts
          </Link>
        </div>
        {(detail.error || options.error) && <p className="bc-notice bc-notice--red">{failureText(detail.error ?? options.error)}</p>}
        {d && !d.enabled && (
          <p className="bc-notice bc-notice--amber">Broadcasts are switched off. You can prepare and test one, but nothing is sent to customers until the owner switches them on.</p>
        )}
        {d && d.status !== "draft" ? (
          <p className="bc-notice">
            This broadcast has been confirmed and can no longer be changed.{" "}
            <Link to="/broadcasts/$broadcastId" params={{ broadcastId }} className="bc-link">
              See the results
            </Link>
          </p>
        ) : d && options.data ? (
          <DraftEditor detail={d} options={options.data} />
        ) : (
          !detail.error && !options.error && <p className="bc-soft">Loading…</p>
        )}
      </div>
    </Frame>
  );
}

export function BroadcastEditorPage({ broadcastId }: { broadcastId?: string }): JSX.Element {
  return broadcastId ? <EditBroadcast broadcastId={broadcastId} /> : <NewBroadcast />;
}
