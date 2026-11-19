/** Lists (suite spec 14, 7.5): groups of contacts, picked by hand or kept up to date by a saved filter. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { groupThousands } from "@ms/shared";
import { contactKeys, contactsApi, failureText } from "./contacts-api.js";
import { lagosDate } from "./contacts-logic.js";
import "./contacts.css";

export function ListsPage(): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const manage = can("contacts.manage");
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const lists = useQuery({ queryKey: contactKeys.lists(archived), queryFn: () => contactsApi.lists(archived), refetchOnWindowFocus: false });
  const rows = lists.data ?? [];

  return (
    <Frame title="Lists" crumb="Contacts">
      <div className="ct-page">
        <div>
          <Link to="/contacts" className="ct-linkish">
            ← All contacts
          </Link>
        </div>
        <p className="ct-intro">Groups of contacts. Pick them by hand, or save a filter that keeps itself up to date.</p>
        <div className="ct-toolbar">
          {manage && (
            <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New list
            </button>
          )}
          <label className="ct-check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived lists
          </label>
        </div>
        <DataState
          loading={lists.isLoading}
          error={lists.error}
          isEmpty={rows.length === 0}
          emptyTitle="No lists yet"
          emptyHint="Tick contacts on the Contacts page and press “Add to list”, or filter and press “Save as a list”."
          onRetry={() => void lists.refetch()}
        >
          <div className="table-wrap">
            <table className="table ct-table ct-table--plain">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>People</th>
                  <th>Made by</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="is-clickable" onClick={() => void navigate({ to: "/contacts/lists/$listId", params: { listId: l.id } })}>
                    <td>
                      <Link to="/contacts/lists/$listId" params={{ listId: l.id }} className="ct-name" onClick={(e) => e.stopPropagation()}>
                        {l.name}
                      </Link>
                      {l.archived_at && <span className="ct-tag">Archived</span>}
                      {l.description && <div className="ct-soft">{l.description}</div>}
                    </td>
                    <td data-label="Kind">{l.kind === "smart" ? "Fills itself" : "Picked by hand"}</td>
                    <td data-label="People">{groupThousands(l.count)}</td>
                    <td data-label="Made by">{l.created_by_name ?? "—"}</td>
                    <td data-label="Updated">{lagosDate(l.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
      </div>
      {creating && (
        <NewListDialog
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: contactKeys.all });
            void navigate({ to: "/contacts/lists/$listId", params: { listId: id } });
          }}
        />
      )}
    </Frame>
  );
}

function NewListDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!name.trim()) {
      setError("Give the list a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const list = await contactsApi.createList({ name: name.trim(), kind: "static", ...(description.trim() ? { description: description.trim() } : {}) });
      onDone(list.id);
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New list" onClose={busy ? () => undefined : onClose} maxWidth={480}>
      <div className="ct-form">
        <div className="field">
          <label className="field__label" htmlFor="ct-newlist-name">Name</label>
          <input id="ct-newlist-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-newlist-desc">What is it for? (optional)</label>
          <input id="ct-newlist-desc" className="input" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <p className="ct-soft">
          This makes an empty list you fill by hand. For a list that fills itself, set filters on the Contacts page and press “Save as a list”.
        </p>
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
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Make list"}
        </button>
      </div>
    </Modal>
  );
}
