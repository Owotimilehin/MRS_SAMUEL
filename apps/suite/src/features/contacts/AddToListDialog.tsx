/**
 * Put the chosen contacts on a list picked by hand (suite spec 14, 7.2): an
 * existing one, or a new one. "Everyone who matches" is sent as the filter, never as ids.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { DataState } from "@admin/components/DataState.js";
import { toast } from "@admin/lib/toast.js";
import type { ContactListView } from "@ms/shared";
import { contactKeys, contactsApi, failureText } from "./contacts-api.js";
import { addToListBody, selectionCount, type Selection } from "./contacts-logic.js";

export function AddToListDialog({ selection, onClose, onDone }: { selection: Selection; onClose: () => void; onDone: (list: ContactListView) => void }): JSX.Element {
  const lists = useQuery({ queryKey: contactKeys.lists(false), queryFn: () => contactsApi.lists(false), refetchOnWindowFocus: false });
  const fixed = (lists.data ?? []).filter((l) => l.kind === "static");
  const [listId, setListId] = useState<string>("new");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = selectionCount(selection);

  async function go(): Promise<void> {
    if (listId === "new" && !name.trim()) {
      setError("Give the list a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const list = listId === "new" ? await contactsApi.createList({ name: name.trim(), kind: "static" }) : fixed.find((l) => l.id === listId)!;
      const r = await contactsApi.addToList(list.id, addToListBody(selection));
      toast.success(
        r.already > 0
          ? `Added ${r.added} to “${list.name}”. ${r.already} ${r.already === 1 ? "was" : "were"} already on it.`
          : `Added ${r.added} to “${list.name}”.`,
      );
      onDone(list);
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Add ${n} contact${n === 1 ? "" : "s"} to a list`} onClose={busy ? () => undefined : onClose} maxWidth={500}>
      <DataState loading={lists.isLoading} error={lists.error} onRetry={() => void lists.refetch()}>
        <div className="ct-form">
          <fieldset className="ct-radios">
            <legend className="field__label">Which list?</legend>
            {fixed.map((l) => (
              <label key={l.id} className={`ct-radio${listId === l.id ? " is-picked" : ""}`}>
                <input type="radio" name="ct-list-pick" checked={listId === l.id} onChange={() => setListId(l.id)} />
                <span>
                  {l.name}
                  <small>
                    {l.count} {l.count === 1 ? "person" : "people"}
                  </small>
                </span>
              </label>
            ))}
            <label className={`ct-radio${listId === "new" ? " is-picked" : ""}`}>
              <input type="radio" name="ct-list-pick" checked={listId === "new"} onChange={() => setListId("new")} />
              <span>A new list</span>
            </label>
          </fieldset>
          {listId === "new" && (
            <div className="field">
              <label className="field__label" htmlFor="ct-list-new-name">Name</label>
              <input id="ct-list-new-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          <p className="ct-soft">Lists that fill themselves from rules are not shown here: change their rules instead.</p>
          {error && (
            <p className="field__error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="ct-dialog-buttons">
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void go()}>
            {busy ? "Adding…" : "Add to list"}
          </button>
        </div>
      </DataState>
    </Modal>
  );
}
