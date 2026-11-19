/**
 * Write and edit a template (suite spec 06, 7.4): the form on the left, a phone preview and the
 * "Before you send" checks on the right. The draft saves itself two seconds after the last keystroke.
 * Nothing reaches WhatsApp until a person presses "Send to WhatsApp for approval" and confirms.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Eye, Plus, Trash2, Upload } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { ApiError, humanizeError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { humanTemplateName, languageName } from "@admin/lib/inbox-logic.js";
import { toast } from "@admin/lib/toast.js";
import {
  EMPTY_DRAFT,
  TEMPLATE_LIMITS,
  blanksIn,
  validateDraft,
  type DraftButton,
  type DraftCategory,
  type TemplateDraft,
} from "@ms/shared";
import { DeleteTemplateDialog } from "./DeleteTemplateDialog.js";
import { flowKeys, flowsApi } from "./forms/flows-api.js";
import { formButtonChoices } from "./forms/form-labels.js";
import { SubmitDialog } from "./SubmitDialog.js";
import { TemplateChecks } from "./TemplateChecks.js";
import { TemplatePreview } from "./TemplatePreview.js";
import { draftOfRow, lagosDate, statusOf, textOfRow, TONE_PILL } from "./template-labels.js";
import { TemplateFailure, templateKeys, templatesApi, type SubmitAnswer, type TemplateRow } from "./templates-api.js";
import {
  SAMPLE_ACCEPT,
  buttonMenu,
  examplePlaceholder,
  insertBlank,
  moveButton,
  newButton,
  sameDraft,
  sampleProblem,
  saveStatusText,
  syncExamples,
  urlHasBlank,
  withHeaderKind,
  type ButtonKind,
  type SampleFormat,
} from "./templates-logic.js";
import "./templates.css";

const NO_ACCESS = "You do not have access to templates. Ask the owner to give your account the 'Templates' permission.";

export function TemplateEditorPage({ templateId }: { templateId: string }): JSX.Element {
  const can = useCan();
  const [epoch, setEpoch] = useState(0);
  // Kept here, not in the editor, because the editor starts afresh after a send.
  const [notice, setNotice] = useState<string | null>(null);
  const q = useQuery({
    queryKey: templateKeys.one(templateId),
    queryFn: () => templatesApi.get(templateId),
    refetchOnWindowFocus: false,
    enabled: can("templates.manage"),
  });
  if (!can("templates.manage")) {
    return (
      <Frame title="Template" crumb="Templates and forms">
        <div className="empty">
          <div className="empty__title">No access</div>
          {NO_ACCESS}
        </div>
      </Frame>
    );
  }
  const notFound = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400);
  return (
    <Frame title={q.data ? humanTemplateName(q.data.name) : "Template"} crumb="Templates and forms">
      {notFound ? (
        <div className="empty">
          <div className="empty__title">Not found</div>
          We could not find this template. It may have been deleted.
        </div>
      ) : (
        <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {q.data && (
            <Editor
              key={`${q.data.id}-${epoch}`}
              initial={q.data}
              notice={notice}
              onReload={async (n) => {
                setNotice(n ?? null);
                await q.refetch();
                setEpoch((e) => e + 1);
              }}
            />
          )}
        </DataState>
      )}
    </Frame>
  );
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "failed" | "stopped";

const TYPES: { id: DraftCategory; title: string; text: string }[] = [
  { id: "UTILITY", title: "Order and account updates", text: "For a specific customer about something they did: an order, a payment, a delivery, a missed call. No selling." },
  { id: "MARKETING", title: "Marketing", text: "News, offers, new flavours, reminders to buy. Customers can switch these off, and WhatsApp limits how many each person gets." },
];

function Counter({ value, max }: { value: string; max: number }): JSX.Element {
  const n = [...value].length;
  return <span className={n > max ? "tpl-count tpl-count--over" : "tpl-count"}>{n}/{max}</span>;
}

function Editor({
  initial,
  notice,
  onReload,
}: {
  initial: TemplateRow;
  notice: string | null;
  onReload: (notice?: string | null) => Promise<void>;
}): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: templateKeys.list, queryFn: templatesApi.list, refetchOnWindowFocus: false });
  const options = useQuery({ queryKey: templateKeys.options, queryFn: templatesApi.options, refetchOnWindowFocus: false });

  // The forms a form button may open (suite spec 07, 5.5a). Asked for only once the draft has such a button.
  const [wantForms, setWantForms] = useState(() => (draftOfRow(initial)?.buttons ?? []).some((b) => b.type === "FLOW"));
  const formsQ = useQuery({ queryKey: flowKeys.inboxFlows, queryFn: flowsApi.inboxFlows, refetchOnWindowFocus: false, enabled: wantForms });

  const [row, setRow] = useState(initial);
  const [saved, setSaved] = useState<TemplateDraft | null>(() => draftOfRow(initial));
  const [draft, setDraft] = useState<TemplateDraft>(() => draftOfRow(initial) ?? EMPTY_DRAFT);
  const [status, setStatus] = useState<SaveState>("idle");
  const [elsewhere, setElsewhere] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [localSample, setLocalSample] = useState<{ url: string | null; name: string } | null>(null);
  const [dialog, setDialog] = useState<"submit" | "delete" | "discard" | "preview" | null>(null);

  const draftRef = useRef(draft);
  const stampRef = useRef<string | null>(initial.draft_updated_at);
  const savingRef = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const cursorRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const readOnly = !row.editable || saved === null;
  const dirty = !readOnly && !sameDraft(draft, saved);
  const isMetaRow = row.status !== "DRAFT";
  const approved = row.status === "APPROVED";

  function update(next: TemplateDraft): void {
    draftRef.current = next;
    setDraft(next);
    setStatus("dirty");
  }

  // ── Saving ──
  async function save(manual: boolean): Promise<boolean> {
    if (savingRef.current) return false;
    const sending = draftRef.current;
    savingRef.current = true;
    setStatus("saving");
    try {
      const next = await templatesApi.saveDraft(row.id, sending, stampRef.current);
      stampRef.current = next.draft_updated_at;
      setRow(next);
      setSaved(sending);
      qc.setQueryData(templateKeys.one(next.id), next);
      void qc.invalidateQueries({ queryKey: templateKeys.list });
      setStatus(sameDraft(draftRef.current, sending) ? "saved" : "dirty");
      if (manual) toast.success("Draft saved.");
      return true;
    } catch (err) {
      if (err instanceof TemplateFailure && err.changedElsewhere) {
        setElsewhere(true);
        setStatus("stopped");
      } else {
        setStatus("failed");
        if (manual) toast.error(err instanceof TemplateFailure ? err.message : "Something went wrong. Please try again.");
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }

  useEffect(() => {
    if (!dirty || elsewhere) return undefined;
    const t = setTimeout(() => void save(false), 2000);
    return () => clearTimeout(t);
    // `save` reads refs, so it need not be a dependency; a change of draft or of what is saved restarts the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, saved, elsewhere, dirty]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Put the cursor after a blank that "Add a blank" just inserted.
  useLayoutEffect(() => {
    if (cursorRef.current !== null && bodyRef.current) {
      bodyRef.current.focus();
      bodyRef.current.setSelectionRange(cursorRef.current, cursorRef.current);
      cursorRef.current = null;
    }
  }, [draft.body.text]);

  // ── What the checks and the preview show ──
  const others = (list.data ?? [])
    .filter((t) => t.id !== row.id && t.waba_id === row.waba_id && t.status !== "DELETED")
    .map((t) => ({ name: t.name, ...textOfRow(t) }));
  const problems = validateDraft(draft, { name: row.name, others });
  const errors = problems.filter((p) => p.level === "error");
  const warnings = problems.filter((p) => p.level === "warning");

  const header = draft.header;
  const sampleKey = header && header.format !== "TEXT" ? header.sampleKey : "";
  const sampleQ = useQuery({
    queryKey: templateKeys.sampleUrl(row.id, sampleKey),
    queryFn: () => templatesApi.sampleUrl(row.id),
    enabled: sampleKey !== "" && header?.format === "IMAGE" && !localSample,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const sampleUrl = localSample?.url ?? sampleQ.data ?? null;
  const sampleName = localSample?.name ?? (header && header.format !== "TEXT" ? header.sampleName || null : null);

  const status0 = statusOf(row);
  const examples = draft.body.examples;
  const blankCount = examples.length;

  // ── Edits ──
  const setBody = (text: string): void => update({ ...draft, body: { text, examples: syncExamples(text, draft.body.examples) } });
  const setButton = (i: number, b: DraftButton): void => update({ ...draft, buttons: draft.buttons.map((x, j) => (j === i ? b : x)) });

  function addBlank(): void {
    const at = bodyRef.current?.selectionStart ?? null;
    const r = insertBlank(draft.body.text, at);
    cursorRef.current = r.cursor;
    setBody(r.text);
  }

  async function pickSample(file: File, format: SampleFormat): Promise<void> {
    const problem = sampleProblem(file, format);
    if (problem) {
      toast.error(problem);
      return;
    }
    setUploading(true);
    try {
      const key = await templatesApi.uploadSample(row.id, file);
      setLocalSample({ url: format === "IMAGE" ? URL.createObjectURL(file) : null, name: file.name });
      update({ ...draftRef.current, header: { format, sampleKey: key, sampleMime: file.type, sampleName: file.name } });
    } catch (err) {
      toast.error(err instanceof TemplateFailure ? err.message : "The file did not upload. Try again.");
    } finally {
      setUploading(false);
    }
  }

  // ── Actions ──
  async function openSubmit(): Promise<void> {
    if (errors.length > 0) {
      toast.error("Fix the problems marked in red first.");
      return;
    }
    if (isMetaRow && !dirty && !row.draft) {
      toast.info("Nothing has changed yet.");
      return;
    }
    if (dirty && !(await save(false))) {
      toast.error("We could not save your changes, so nothing was sent. Try again.");
      return;
    }
    setDialog("submit");
  }

  async function submitted(a: SubmitAnswer): Promise<void> {
    setDialog(null);
    const s = a.data.status;
    toast.success(
      s === "APPROVED" ? "Approved. It is ready to use." : s === "REJECTED" ? "WhatsApp refused it straight away. See the reason on the page." : "Sent. WhatsApp is checking it.",
    );
    qc.setQueryData(templateKeys.one(a.data.id), a.data);
    void qc.invalidateQueries({ queryKey: templateKeys.list });
    await onReload(a.notice ?? null);
  }

  async function discard(): Promise<void> {
    setDialog(null);
    try {
      await templatesApi.discardDraft(row.id);
      toast.success("Your unsent changes were thrown away.");
      void qc.invalidateQueries({ queryKey: templateKeys.list });
      await onReload();
    } catch (err) {
      toast.error(err instanceof TemplateFailure ? err.message : "Something went wrong. Please try again.");
    }
  }

  const menu = buttonMenu(draft.buttons);
  const stripStatus: SaveState = elsewhere ? "stopped" : dirty && status === "idle" ? "dirty" : status;
  const canSend = !readOnly && !elsewhere;

  return (
    <div className="tpl-editor">
      <div className="tpl-strip">
        <span className={TONE_PILL[status0.tone]}>{status0.label}</span>
        <span className="tpl-strip__line">{status0.line}</span>
        <span className="tpl-strip__meta">
          {languageName(row.language)} · <code>{row.name}</code>
        </span>
      </div>
      {approved && (
        <p className="tpl-banner tpl-banner--grey">
          You can change an approved template once a day and 10 times in 30 days. Changes left this month: {row.edits_left?.month ?? 10}.
        </p>
      )}
      {row.last_error && (
        <p className="tpl-banner tpl-banner--amber" role="alert">
          {row.last_error}
        </p>
      )}
      {notice && (
        <p className="tpl-banner tpl-banner--amber" role="status">
          {notice}
        </p>
      )}
      {row.correct_category && (
        <p className="tpl-banner tpl-banner--amber">
          WhatsApp will move this to {row.correct_category === "MARKETING" ? "Marketing" : "Order and account updates"}
          {row.category_change_at ? ` on ${lagosDate(row.category_change_at)}` : ""}. If you think that is wrong, ask for a review in WhatsApp Manager within 60 days.
        </p>
      )}
      {!row.editable && (
        <p className="tpl-banner tpl-banner--grey">{row.not_editable_reason ?? "This template cannot be changed here."}</p>
      )}
      {row.editable && saved === null && (
        <p className="tpl-banner tpl-banner--grey">This draft cannot be opened. Delete it and make a new one.</p>
      )}
      {elsewhere && (
        <p className="tpl-banner tpl-banner--amber" role="alert">
          Someone else changed this draft.{" "}
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => void onReload()}>
            Reload
          </button>
        </p>
      )}

      <div className="tpl-cols">
        <fieldset className="tpl-form" disabled={readOnly}>
          <legend className="sr-only">Template</legend>

          <section className="card tpl-section">
            <h2 className="tpl-h">Type</h2>
            <div className="tpl-types">
              {TYPES.map((t) => (
                <label key={t.id} className={`tpl-type${draft.category === t.id ? " is-picked" : ""}`}>
                  <input
                    type="radio"
                    name="tpl-category"
                    checked={draft.category === t.id}
                    disabled={approved}
                    onChange={() => update({ ...draft, category: t.id })}
                  />
                  <span>
                    <strong>{t.title}</strong>
                    <span className="tpl-type__text">{t.text}</span>
                  </span>
                </label>
              ))}
            </div>
            {approved && <p className="field__hint">The type of an approved template cannot be changed.</p>}
          </section>

          <section className="card tpl-section">
            <h2 className="tpl-h">Heading (optional)</h2>
            <div className="tpl-radios" role="radiogroup" aria-label="Heading">
              {(
                [
                  ["NONE", "None"],
                  ["TEXT", "Text"],
                  ["IMAGE", "Picture"],
                  ["VIDEO", "Video"],
                  ["DOCUMENT", "PDF document"],
                ] as const
              ).map(([k, label]) => {
                const current = header === null ? "NONE" : header.format;
                return (
                  <label key={k} className={`tpl-radio${current === k ? " is-picked" : ""}`}>
                    <input type="radio" name="tpl-header" checked={current === k} onChange={() => update(withHeaderKind(draft, k))} />
                    {label}
                  </label>
                );
              })}
            </div>
            {header && header.format === "TEXT" && (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="tpl-head-text">Heading</label>
                  <span className="field__hint">One line above the message. You may use one blank: {"{{1}}"}.</span>
                  <input
                    id="tpl-head-text"
                    className="input"
                    value={header.text}
                    onChange={(e) => update({ ...draft, header: { format: "TEXT", text: e.target.value, example: header.example } })}
                  />
                  <Counter value={header.text} max={TEMPLATE_LIMITS.headerText} />
                </div>
                {blanksIn(header.text).length > 0 && (
                  <div className="field">
                    <label className="field__label" htmlFor="tpl-head-example">Example for {"{{1}}"}</label>
                    <input
                      id="tpl-head-example"
                      className="input"
                      placeholder="MS-10482"
                      value={header.example}
                      onChange={(e) => update({ ...draft, header: { format: "TEXT", text: header.text, example: e.target.value } })}
                    />
                  </div>
                )}
              </>
            )}
            {header && header.format !== "TEXT" && (
              <div className="field">
                <span className="field__label">Sample</span>
                <span className="field__hint">
                  WhatsApp needs a sample to check. Each time you send this template you will attach the real file.{" "}
                  {header.format === "IMAGE" ? "A JPG or PNG up to 5 MB." : header.format === "VIDEO" ? "An MP4 up to 16 MB." : "A PDF up to 16 MB."}
                </span>
                {options.data && !options.data.sample_upload_ready && (
                  <span className="field__error">Sample upload is not set up on this server yet.</span>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept={SAMPLE_ACCEPT[header.format]}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void pickSample(f, header.format as SampleFormat);
                  }}
                />
                <div className="tpl-sample">
                  {sampleUrl && header.format === "IMAGE" && <img src={sampleUrl} alt="The sample picture" className="tpl-sample__thumb" />}
                  {sampleKey !== "" && !(sampleUrl && header.format === "IMAGE") && <span className="pill pill--success">{sampleName ?? "Sample chosen"}</span>}
                  <button type="button" className="btn btn--subtle btn--sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                    <Upload size={13} /> {uploading ? "Uploading…" : sampleKey === "" ? "Choose a sample" : "Replace"}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="card tpl-section">
            <h2 className="tpl-h">Message</h2>
            <div className="field">
              <label className="field__label" htmlFor="tpl-body">Message</label>
              <span className="field__hint">
                Write it as you would say it. Use a blank where something changes for each customer, like their name or order number.
              </span>
              <textarea
                id="tpl-body"
                ref={bodyRef}
                className="textarea"
                rows={8}
                value={draft.body.text}
                onChange={(e) => setBody(e.target.value)}
              />
              <div className="tpl-row-between">
                <button type="button" className="btn btn--subtle btn--sm" onClick={addBlank}>
                  <Plus size={13} /> Add a blank
                </button>
                <Counter value={draft.body.text} max={TEMPLATE_LIMITS.body} />
              </div>
            </div>
          </section>

          {blankCount > 0 && (
            <section className="card tpl-section">
              <h2 className="tpl-h">Examples for the blanks</h2>
              <p className="field__hint">Give a realistic example for each blank. Use made-up details, never a real customer&apos;s.</p>
              {examples.map((ex, i) => (
                <div className="field" key={i}>
                  <label className="field__label" htmlFor={`tpl-ex-${i}`}>
                    {`{{${i + 1}}}`} for example
                  </label>
                  <input
                    id={`tpl-ex-${i}`}
                    className="input"
                    placeholder={examplePlaceholder(i + 1)}
                    value={ex}
                    onChange={(e) => update({ ...draft, body: { text: draft.body.text, examples: examples.map((x, j) => (j === i ? e.target.value : x)) } })}
                  />
                </div>
              ))}
            </section>
          )}

          <section className="card tpl-section">
            <h2 className="tpl-h">Small print (optional)</h2>
            <div className="field">
              <label className="field__label" htmlFor="tpl-footer">Small print</label>
              <span className="field__hint">Grey text under the message, for example your shop name.</span>
              <input id="tpl-footer" className="input" value={draft.footer} onChange={(e) => update({ ...draft, footer: e.target.value })} />
              <Counter value={draft.footer} max={TEMPLATE_LIMITS.footer} />
            </div>
          </section>

          <section className="card tpl-section">
            <h2 className="tpl-h">Buttons (optional)</h2>
            {draft.buttons.map((b, i) => (
              <div className="tpl-button" key={i}>
                <div className="tpl-button__head">
                  <strong>{b.type === "QUICK_REPLY" ? "Reply button" : b.type === "URL" ? "Link button" : b.type === "FLOW" ? "Form button" : "Call button"}</strong>
                  <span className="tpl-button__tools">
                    <button type="button" className="btn btn--ghost btn--sm" aria-label="Move up" disabled={i === 0} onClick={() => update({ ...draft, buttons: moveButton(draft.buttons, i, -1) })}>
                      <ArrowUp size={13} />
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" aria-label="Move down" disabled={i === draft.buttons.length - 1} onClick={() => update({ ...draft, buttons: moveButton(draft.buttons, i, 1) })}>
                      <ArrowDown size={13} />
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => update({ ...draft, buttons: draft.buttons.filter((_, j) => j !== i) })}>
                      <Trash2 size={13} /> Remove
                    </button>
                  </span>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`tpl-b-${i}`}>Label</label>
                  {b.type === "QUICK_REPLY" && <span className="field__hint">The customer taps it to answer in one touch.</span>}
                  <input id={`tpl-b-${i}`} className="input" value={b.text} onChange={(e) => setButton(i, { ...b, text: e.target.value })} />
                  <Counter value={b.text} max={TEMPLATE_LIMITS.buttonText} />
                </div>
                {b.type === "URL" && (
                  <>
                    <div className="field">
                      <label className="field__label" htmlFor={`tpl-bu-${i}`}>Link</label>
                      <span className="field__hint">Opens a web page. The link may end with one blank, for example https://www.mrssamuel.com/order/{"{{1}}"}</span>
                      <input id={`tpl-bu-${i}`} className="input" inputMode="url" value={b.url} onChange={(e) => setButton(i, { ...b, url: e.target.value })} />
                    </div>
                    {urlHasBlank(b.url) && (
                      <div className="field">
                        <label className="field__label" htmlFor={`tpl-be-${i}`}>Example for the end of the link</label>
                        <input id={`tpl-be-${i}`} className="input" placeholder="MS-10482" value={b.example} onChange={(e) => setButton(i, { ...b, example: e.target.value })} />
                      </div>
                    )}
                  </>
                )}
                {b.type === "PHONE_NUMBER" && (
                  <div className="field">
                    <label className="field__label" htmlFor={`tpl-bp-${i}`}>Phone number</label>
                    <span className="field__hint">With the country code, for example +2348012345678.</span>
                    <input id={`tpl-bp-${i}`} className="input" inputMode="tel" value={b.phone} onChange={(e) => setButton(i, { ...b, phone: e.target.value })} />
                  </div>
                )}
                {b.type === "FLOW" &&
                  (() => {
                    const choices = formButtonChoices(formsQ.data ?? [], b.flowKey);
                    const noneLive = formsQ.data !== undefined && !formsQ.data.some((f) => f.live);
                    return (
                      <div className="field">
                        <label className="field__label" htmlFor={`tpl-bf-${i}`}>Which form?</label>
                        <span className="field__hint">The customer taps it to open the form. Only one form button per template.</span>
                        {(choices.length > 0 || !noneLive) && (
                          <select id={`tpl-bf-${i}`} className="select" value={b.flowKey} disabled={formsQ.isLoading} onChange={(e) => setButton(i, { ...b, flowKey: e.target.value })}>
                            <option value="">{formsQ.isLoading ? "Loading…" : "Choose a form"}</option>
                            {choices.map((c) => (
                              <option key={c.key} value={c.key}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        )}
                        {noneLive && <span className="field__hint">No form is live yet. Publish one under Forms first.</span>}
                        {formsQ.error ? <span className="field__error">{humanizeError(formsQ.error)}</span> : null}
                      </div>
                    );
                  })()}
              </div>
            ))}
            <details className="tpl-menu">
              <summary className="btn btn--subtle btn--sm">
                <Plus size={13} /> Add a button
              </summary>
              <ul>
                {menu.map((m) => (
                  <li key={m.kind}>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={m.disabled !== null}
                      onClick={(e) => {
                        if (m.kind === "FLOW") setWantForms(true);
                        update({ ...draft, buttons: [...draft.buttons, newButton(m.kind as ButtonKind)] });
                        (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                      }}
                    >
                      {m.label}
                    </button>
                    {m.disabled && <span className="field__hint">{m.disabled}</span>}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        </fieldset>

        <aside className="tpl-side">
          <TemplatePreview draft={draft} sampleUrl={sampleUrl} sampleName={sampleName} />
          <TemplateChecks problems={problems} />
        </aside>
      </div>

      <div className="tpl-bar">
        <button type="button" className="btn btn--ghost" disabled={!dirty || status === "saving" || elsewhere} onClick={() => void save(true)}>
          Save draft
        </button>
        <button type="button" className="btn btn--primary" disabled={!canSend} onClick={() => void openSubmit()}>
          {isMetaRow ? "Send changes to WhatsApp" : "Send to WhatsApp for approval"}
        </button>
        <button type="button" className="btn btn--subtle tpl-only-narrow" onClick={() => setDialog("preview")}>
          <Eye size={14} /> Preview
        </button>
        {isMetaRow && row.draft && (
          <button type="button" className="btn btn--ghost" onClick={() => setDialog("discard")}>
            Discard changes
          </button>
        )}
        <span className="tpl-bar__status" role="status">
          {saveStatusText(stripStatus)}
        </span>
        <span className="tpl-bar__spacer" />
        <button type="button" className="tpl-delete" onClick={() => setDialog("delete")}>
          Delete
        </button>
      </div>

      {dialog === "submit" && stampRef.current && (
        <SubmitDialog
          row={row}
          draft={draft}
          stamp={stampRef.current}
          warnings={warnings}
          sampleUrl={sampleUrl}
          sampleName={sampleName}
          onClose={() => setDialog(null)}
          onDone={(a) => void submitted(a)}
        />
      )}
      {dialog === "delete" && (
        <DeleteTemplateDialog
          row={row}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast.success("Template deleted.");
            void qc.invalidateQueries({ queryKey: templateKeys.list });
            void navigate({ to: "/templates" });
          }}
        />
      )}
      {dialog === "discard" && (
        <ConfirmModal title="Throw away your unsent changes?" confirmLabel="Throw them away" busyLabel="Working…" tone="danger" onConfirm={() => void discard()} onCancel={() => setDialog(null)}>
          <p style={{ margin: 0 }}>The template goes back to what WhatsApp holds now. This cannot be undone.</p>
        </ConfirmModal>
      )}
      {dialog === "preview" && (
        <Modal title="Preview" onClose={() => setDialog(null)} maxWidth={420}>
          <TemplatePreview draft={draft} sampleUrl={sampleUrl} sampleName={sampleName} />
        </Modal>
      )}
    </div>
  );
}
