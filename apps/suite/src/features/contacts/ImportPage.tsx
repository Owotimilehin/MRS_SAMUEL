/**
 * Import contacts from a spreadsheet (suite spec 14, 7.6), in four steps:
 * choose a file, match the columns, say where the people came from, and check
 * before saving. Nothing is saved until the last button, and nothing the shop
 * already holds is ever overwritten.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { Frame } from "@admin/lib/app-frame.js";
import { IMPORT_FIELDS, type CustomerSourceValue, type ImportField, type ImportMapping, type ImportRowView } from "@ms/shared";
import { contactKeys, contactsApi, failureText, type ImportPreview, type ImportStatus, type ImportUpload } from "./contacts-api.js";
import {
  FIRST_REACHED,
  IMPORT_FIELD_TEXT,
  fileProblem,
  importConfirmText,
  importProgressText,
  lagosToday,
  mappingProblem,
  rejectionReasonText,
  sourceStepProblem,
} from "./contacts-logic.js";
import "./contacts.css";

type Step = 1 | 2 | 3 | 4;
type Tab = "new" | "matched" | "rejected";
const STEPS = ["Choose a file", "Match the columns", "Say where they came from", "Check before saving"];

function readAsText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file, "utf-8");
  });
}

export function ImportPage(): JSX.Element {
  const qc = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<ImportUpload | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [source, setSource] = useState({
    sourceLabel: "",
    customerSource: "walkup_anonymous" as CustomerSourceValue,
    consentYes: false,
    consentMethod: "",
    consentWording: "",
    consentDate: lagosToday(new Date()),
    fillBlanks: false,
    listId: "",
    labelId: "",
  });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [tab, setTab] = useState<Tab>("new");
  const [confirming, setConfirming] = useState(false);
  const [started, setStarted] = useState(false);

  const lists = useQuery({ queryKey: contactKeys.lists(false), queryFn: () => contactsApi.lists(false), refetchOnWindowFocus: false });
  const labels = useQuery({ queryKey: contactKeys.labels, queryFn: contactsApi.labels, refetchOnWindowFocus: false });
  const importId = upload?.id ?? "none";
  // While the worker saves the rows, ask how far it has got every two seconds.
  const status = useQuery({
    queryKey: contactKeys.importOne(importId),
    enabled: started && !!upload,
    queryFn: () => contactsApi.importStatus(importId),
    refetchInterval: (q) => {
      const s = (q.state.data as ImportStatus | undefined)?.status;
      return s === "applied" || s === "failed" || s === "cancelled" ? false : 2000;
    },
  });
  const tabRows = useQuery({
    queryKey: [...contactKeys.importOne(importId), "rows", tab, preview?.new ?? 0, preview?.matched ?? 0, preview?.rejected ?? 0],
    enabled: step === 4 && !!upload && !!preview && !started,
    refetchOnWindowFocus: false,
    queryFn: async () => (await contactsApi.importStatus(importId, tab)).rows,
  });
  const finished = status.data?.status === "applied";
  useEffect(() => {
    if (finished) void qc.invalidateQueries({ queryKey: contactKeys.all });
  }, [finished, qc]);

  async function chooseFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    const text = await readAsText(file);
    const problem = fileProblem({ name: file.name, size: file.size }, text);
    if (problem || text === null) {
      setError(problem ?? "We couldn't read this file. Save it again as “CSV UTF-8”.");
      return;
    }
    setBusy(true);
    try {
      const up = await contactsApi.uploadImport(file.name, text);
      setUpload(up);
      setMapping(up.suggested_mapping);
      setPreview(null);
      setStep(2);
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  function toStep3(): void {
    const problem = mappingProblem(mapping);
    setError(problem);
    if (!problem) setStep(3);
  }

  async function check(): Promise<void> {
    if (!upload) return;
    const problem = sourceStepProblem({ ...source, hasPhoneColumn: !!mapping.phone });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const clean = Object.fromEntries(Object.entries(mapping).filter(([, header]) => !!header)) as ImportMapping;
      const p = await contactsApi.previewImport(upload.id, {
        mapping: clean,
        source_label: source.sourceLabel.trim(),
        customer_source: source.customerSource,
        consent_declared: source.consentYes ? "marketing_whatsapp" : "none",
        ...(source.consentYes
          ? { consent_method: source.consentMethod.trim(), consent_wording: source.consentWording.trim(), consent_collected_on: source.consentDate }
          : {}),
        fill_blanks: source.fillBlanks,
        ...(source.labelId ? { label_id: source.labelId } : {}),
        ...(source.listId ? { list_id: source.listId } : {}),
      });
      setPreview(p);
      setTab(p.new > 0 ? "new" : p.matched > 0 ? "matched" : "rejected");
      setStep(4);
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!upload || !preview) return;
    setBusy(true);
    setError(null);
    try {
      await contactsApi.applyImport(upload.id, preview.new, preview.matched);
      setConfirming(false);
      setStarted(true);
    } catch (err) {
      setConfirming(false);
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  const seeThem = (): void => {
    const to = source.listId ? `/contacts?list=${encodeURIComponent(source.listId)}` : source.labelId ? `/contacts?label=${encodeURIComponent(source.labelId)}` : "/contacts?sort=added";
    router.history.push(to);
  };
  const setField = (field: ImportField, header: string) => setMapping({ ...mapping, [field]: header || undefined });
  const willImport = (preview?.new ?? 0) + (preview?.matched ?? 0);
  const fixedLists = (lists.data ?? []).filter((l) => l.kind === "static");

  return (
    <Frame title="Import contacts" crumb="Contacts">
      <div className="ct-page">
        <div>
          <Link to="/contacts" className="ct-linkish">
            ← All contacts
          </Link>
        </div>
        <ol className="ct-steps" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} className={step === i + 1 ? "is-now" : step > i + 1 ? "is-done" : ""} aria-current={step === i + 1 ? "step" : undefined}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>
        {error && (
          <p className="ct-error" role="alert">
            {error}
          </p>
        )}

        {step === 1 && (
          <section className="card ct-card" aria-label="Choose a file">
            <h2 className="ct-card__h">Choose a file</h2>
            <p className="ct-intro">Choose a spreadsheet saved as CSV. The first row must be the column names. Up to 5,000 rows.</p>
            <div>
              <input type="file" accept=".csv,text/csv" aria-label="Choose a CSV file" disabled={busy} onChange={(e) => void chooseFile(e.target.files?.[0])} />
            </div>
            {busy && <p className="ct-soft">Reading the file…</p>}
            <p className="ct-soft">Nothing is saved until you have checked the rows and pressed Import.</p>
          </section>
        )}

        {step === 2 && upload && (
          <section className="card ct-card" aria-label="Match the columns">
            <h2 className="ct-card__h">Match the columns</h2>
            <p className="ct-intro">
              {upload.total_rows} row{upload.total_rows === 1 ? "" : "s"}. Say which column of your file holds each detail.
            </p>
            <div className="ct-map">
              <div className="ct-form">
                {IMPORT_FIELDS.map((field) => (
                  <div className="field" key={field}>
                    <label className="field__label" htmlFor={`ct-map-${field}`}>
                      {IMPORT_FIELD_TEXT[field]}
                    </label>
                    <select id={`ct-map-${field}`} className="select" value={mapping[field] ?? ""} onChange={(e) => setField(field, e.target.value)}>
                      <option value="">Not in this file</option>
                      {upload.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="ct-sample">
                <p className="ct-soft">The first rows of your file:</p>
                <table className="table">
                  <thead>
                    <tr>
                      {upload.headers.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {upload.sample.map((cells, i) => (
                      <tr key={i}>
                        {upload.headers.map((h, j) => (
                          <td key={h}>{cells[j] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="ct-dialog-buttons">
              <button type="button" className="btn btn--subtle" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="btn btn--primary" onClick={toStep3}>
                Next
              </button>
            </div>
          </section>
        )}

        {step === 3 && upload && (
          <section className="card ct-card" aria-label="Say where they came from">
            <h2 className="ct-card__h">Say where they came from</h2>
            <div className="ct-form">
              <div className="ct-form__two">
                <div className="field">
                  <label className="field__label" htmlFor="ct-imp-where">Where did you get this list?</label>
                  <input
                    id="ct-imp-where"
                    className="input"
                    maxLength={80}
                    placeholder="For example: order book, event sign-up sheet"
                    value={source.sourceLabel}
                    onChange={(e) => setSource({ ...source, sourceLabel: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="ct-imp-source">How did these people first reach the business?</label>
                  <select
                    id="ct-imp-source"
                    className="select"
                    value={source.customerSource}
                    onChange={(e) => setSource({ ...source, customerSource: e.target.value as CustomerSourceValue })}
                  >
                    {FIRST_REACHED.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <fieldset className="ct-radios">
                <legend className="field__label">Did these people agree to get promotions on WhatsApp?</legend>
                <label className={`ct-radio${!source.consentYes ? " is-picked" : ""}`}>
                  <input type="radio" name="ct-imp-consent" checked={!source.consentYes} onChange={() => setSource({ ...source, consentYes: false })} /> No, or I&apos;m not sure
                </label>
                <label className={`ct-radio${source.consentYes ? " is-picked" : ""}`}>
                  <input type="radio" name="ct-imp-consent" checked={source.consentYes} onChange={() => setSource({ ...source, consentYes: true })} /> Yes, every person on
                  this list agreed
                </label>
              </fieldset>
              {source.consentYes && (
                <>
                  <div className="ct-form__two">
                    <div className="field">
                      <label className="field__label" htmlFor="ct-imp-how">How did they agree?</label>
                      <input
                        id="ct-imp-how"
                        className="input"
                        maxLength={300}
                        placeholder="For example: ticked a box on the sign-up sheet"
                        value={source.consentMethod}
                        onChange={(e) => setSource({ ...source, consentMethod: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor="ct-imp-when">When?</label>
                      <input id="ct-imp-when" className="input" type="date" value={source.consentDate} onChange={(e) => setSource({ ...source, consentDate: e.target.value })} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="ct-imp-told">What were they told?</label>
                    <textarea
                      id="ct-imp-told"
                      className="textarea"
                      maxLength={1000}
                      placeholder="For example: “Send me offers from Mrs. Samuel Fruit Juice on WhatsApp”"
                      value={source.consentWording}
                      onChange={(e) => setSource({ ...source, consentWording: e.target.value })}
                    />
                  </div>
                  <p className="ct-note ct-note--amber">You are stating that every person on this list agreed. Your name is recorded with this import.</p>
                </>
              )}
              <div className="field">
                <span className="field__label">For contacts we already have:</span>
                <label className="ct-check">
                  <input type="checkbox" checked={source.fillBlanks} onChange={(e) => setSource({ ...source, fillBlanks: e.target.checked })} />
                  Fill in details that are missing (name, email, address). Nothing we already hold is changed.
                </label>
              </div>
              <div className="ct-form__two">
                <div className="field">
                  <label className="field__label" htmlFor="ct-imp-list">Add everyone to a list (optional)</label>
                  <select id="ct-imp-list" className="select" value={source.listId} onChange={(e) => setSource({ ...source, listId: e.target.value })}>
                    <option value="">No list</option>
                    {fixedLists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="ct-imp-label">Give everyone a label (optional)</label>
                  <select id="ct-imp-label" className="select" value={source.labelId} onChange={(e) => setSource({ ...source, labelId: e.target.value })}>
                    <option value="">No label</option>
                    {(labels.data ?? []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="ct-dialog-buttons">
              <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => setStep(2)}>
                Back
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void check()}>
                {busy ? "Checking…" : "Check the rows"}
              </button>
            </div>
          </section>
        )}

        {step === 4 && upload && preview && (
          <section className="card ct-card" aria-label="Check before saving">
            <h2 className="ct-card__h">Check before saving</h2>
            <div className="ct-tiles" role="tablist" aria-label="Rows">
              {(
                [
                  ["new", "New contacts", preview.new],
                  ["matched", "Already contacts", preview.matched],
                  ["rejected", "Rows we can't use", preview.rejected],
                ] as const
              ).map(([id, label, n]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={`ct-tile${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)}>
                  <span className="ct-tile__n">{n}</span>
                  <span className="ct-tile__label">{label}</span>
                </button>
              ))}
            </div>
            {tab === "rejected" && preview.reasons.length > 0 && (
              <ul className="ct-lines">
                {preview.reasons.map((r) => (
                  <li key={r.reason}>
                    {r.count} · {rejectionReasonText(r.reason)}
                  </li>
                ))}
              </ul>
            )}
            {!started && <ImportRows rows={tabRows.data ?? preview.rows.filter((r) => r.outcome === tab)} loading={tabRows.isLoading} />}

            {!started ? (
              <>
                <p className="ct-note">Nothing has been saved yet.</p>
                <div className="ct-dialog-buttons">
                  <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => setStep(3)}>
                    Back
                  </button>
                  <button type="button" className="btn btn--primary" disabled={busy || willImport === 0} onClick={() => setConfirming(true)}>
                    Import {willImport} contact{willImport === 1 ? "" : "s"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={status.data?.status === "failed" ? "ct-error" : "ct-note"} role="status">
                  {importProgressText({
                    status: status.data?.status ?? "applying",
                    applied: status.data?.applied_rows ?? 0,
                    total: willImport,
                    added: status.data?.new ?? preview.new,
                    already: status.data?.matched ?? preview.matched,
                  })}
                </p>
                {finished && (
                  <div className="ct-dialog-buttons">
                    <button type="button" className="btn btn--primary" onClick={seeThem}>
                      See them
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>

      {confirming && preview && (
        <ConfirmModal title="Import contacts" confirmLabel="Import" busyLabel="Starting…" busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void apply()}>
          <p style={{ margin: 0 }}>{importConfirmText(preview.new, preview.matched, source.fillBlanks)}</p>
          {source.consentYes && (
            <p style={{ margin: "10px 0 0" }}>You are stating that every person on this list agreed to promotions on WhatsApp. Your name is recorded with this import.</p>
          )}
        </ConfirmModal>
      )}
    </Frame>
  );
}

function ImportRows({ rows, loading }: { rows: ImportRowView[]; loading: boolean }): JSX.Element {
  if (loading) return <p className="ct-soft">Loading the rows…</p>;
  if (rows.length === 0) return <p className="ct-soft">No rows here.</p>;
  return (
    <div className="table-wrap" style={{ maxHeight: "50vh", overflowY: "auto" }}>
      <table className="table ct-table ct-table--plain">
        <thead>
          <tr>
            <th>Row</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row_no}>
              <td data-label="Row">{r.row_no}</td>
              <td data-label="Name">{r.name ?? "—"}</td>
              <td data-label="Phone">{r.phone ?? "—"}</td>
              <td data-label="Email">{r.email ?? "—"}</td>
              <td data-label="Note">
                {r.reason ?? ""}
                {r.outcome === "matched" && r.matched_name && r.matched_name !== r.name ? ` (we know them as ${r.matched_name})` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 200 && <p className="ct-soft" style={{ padding: "8px 12px" }}>Showing the first 200 rows.</p>}
    </div>
  );
}
