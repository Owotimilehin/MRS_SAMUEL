/**
 * Save the filters as a list (suite spec 14, 7.5): one that keeps itself up to
 * date, or a fixed list of the people who match today.
 */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { toast } from "@admin/lib/toast.js";
import { describeContactFilter, groupThousands, type ContactListView } from "@ms/shared";
import { contactsApi, failureText, type LabelRow } from "./contacts-api.js";
import { smartListProblem, toContactFilter, type FilterState } from "./contacts-logic.js";

export function SaveListDialog({
  state,
  labels,
  total,
  onClose,
  onDone,
}: {
  state: FilterState;
  labels: LabelRow[];
  /** How many people match now; null while it is not known. */
  total: number | null;
  onClose: () => void;
  onDone: (list: ContactListView) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"smart" | "static">("smart");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filter = toContactFilter(state);
  const lines = describeContactFilter(filter, Object.fromEntries(labels.map((l) => [l.id, l.name])));
  const smartProblem = smartListProblem(state);
  const blocked = kind === "smart" ? smartProblem : null;

  async function save(): Promise<void> {
    if (!name.trim()) {
      setError("Give the list a name.");
      return;
    }
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === "smart") {
        const list = await contactsApi.createList({ name: name.trim(), kind: "smart", filter });
        toast.success(`Saved “${list.name}”. It will keep itself up to date.`);
        onDone(list);
      } else {
        const list = await contactsApi.createList({ name: name.trim(), kind: "static" });
        const r = await contactsApi.addToList(list.id, { filter });
        toast.success(`Saved “${list.name}” with ${r.added} ${r.added === 1 ? "person" : "people"}.`);
        onDone(list);
      }
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Save as a list" onClose={busy ? () => undefined : onClose} maxWidth={520}>
      <div className="ct-form">
        <div className="field">
          <label className="field__label" htmlFor="ct-save-name">Name</label>
          <input id="ct-save-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset className="ct-radios">
          <legend className="field__label">What kind of list?</legend>
          <label className={`ct-radio${kind === "smart" ? " is-picked" : ""}`}>
            <input type="radio" name="ct-save-kind" checked={kind === "smart"} onChange={() => setKind("smart")} />
            <span>
              Keep it up to date
              <small>People join and leave the list by themselves as they start or stop matching.</small>
            </span>
          </label>
          <label className={`ct-radio${kind === "static" ? " is-picked" : ""}`}>
            <input type="radio" name="ct-save-kind" checked={kind === "static"} onChange={() => setKind("static")} />
            <span>
              Just the people who match today
              <small>A fixed list. You can add or remove people later.</small>
            </span>
          </label>
        </fieldset>
        <div className="ct-note">
          <strong>{lines.length ? lines.join(" · ") : "Everyone"}</strong>
          <div>{total === null ? "Counting…" : `${groupThousands(total)} ${total === 1 ? "person matches" : "people match"} now.`}</div>
        </div>
        {(error ?? blocked) && (
          <p className="field__error" role="alert">
            {error ?? blocked}
          </p>
        )}
      </div>
      <div className="ct-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || !!blocked} onClick={() => void save()}>
          {busy ? "Saving…" : "Save list"}
        </button>
      </div>
    </Modal>
  );
}
