import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import type { WaProfileFields } from "@ms/shared";
import { waProfileApi, WaSaveFailure, type WaSaveAnswer } from "./whatsapp-profile-api.js";

interface Row {
  field: keyof WaProfileFields;
  label: string;
  before: string;
  after: string;
}

function Lines({ text }: { text: string }): JSX.Element {
  if (text === "") return <em>(empty)</em>;
  return (
    <>
      {text.split("\n").map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </>
  );
}

/**
 * The before-and-after confirm (foundation rule 7, spec 05 section 7.5). "Save to WhatsApp" sends
 * what the person typed and what the page loaded; the server checks nothing moved in between.
 */
export function ProfileConfirmDialog({
  numberId,
  live,
  form,
  rows,
  onClose,
  onSaved,
  onChangedElsewhere,
  onUnsure,
}: {
  numberId: string;
  /** What the page loaded: sent as `expected`. */
  live: WaProfileFields;
  /** What the person typed. */
  form: WaProfileFields;
  rows: Row[];
  onClose: () => void;
  onSaved: (a: WaSaveAnswer) => void;
  onChangedElsewhere: (f: WaSaveFailure) => void;
  /** A timeout or a Meta-side failure: the page reloads what WhatsApp holds. */
  onUnsure: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onSaved(await waProfileApi.save(numberId, form, live));
    } catch (err) {
      const f = err instanceof WaSaveFailure ? err : new WaSaveFailure(0, "Something went wrong. Please try again.", false, null);
      if (f.changedElsewhere) {
        onChangedElsewhere(f);
        return;
      }
      if (f.status === 0 || f.status >= 500) onUnsure();
      setError(f.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Save these changes to WhatsApp?" onClose={busy ? () => undefined : onClose} maxWidth={620}>
      <p style={{ margin: "0 0 10px" }}>Customers will see the new details straight away.</p>
      <div className="wp-diff-wrap">
        <table className="table wp-diff">
          <thead>
            <tr>
              <th>
                <span className="sr-only">Detail</span>
              </th>
              <th>Now</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.field}>
                <th scope="row">{r.label}</th>
                <td>
                  <Lines text={r.before} />
                </td>
                <td>
                  <Lines text={r.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <div className="field__error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      <div className="wp-dialog-buttons">
        <button type="button" className="btn btn--subtle" disabled={busy} onClick={onClose}>
          Go back
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void go()}>
          {busy ? "Saving…" : "Save to WhatsApp"}
        </button>
      </div>
    </Modal>
  );
}
