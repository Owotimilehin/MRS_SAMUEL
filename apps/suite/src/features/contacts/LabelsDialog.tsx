/**
 * Contact labels (suite spec 14, 7.3): set the labels of one contact, or add and
 * remove labels on the ticked contacts. A contact label describes the person
 * and stays with them; chat labels are separate and are managed in the inbox.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { DataState } from "@admin/components/DataState.js";
import { toast } from "@admin/lib/toast.js";
import { CONTACT_LABEL_COLOURS, type ContactLabelColour } from "@ms/shared";
import { contactKeys, contactsApi, failureText, type LabelRow } from "./contacts-api.js";

type Target = { kind: "contact"; customerId: string; current: string[] } | { kind: "bulk"; customerIds: string[] };

export function LabelsDialog({ target, onClose, onDone }: { target: Target; onClose: () => void; onDone: () => void }): JSX.Element {
  const labels = useQuery({ queryKey: contactKeys.labels, queryFn: contactsApi.labels, refetchOnWindowFocus: false });
  return (
    <Modal title={target.kind === "contact" ? "Labels" : `Label ${target.customerIds.length} contact${target.customerIds.length === 1 ? "" : "s"}`} onClose={onClose} maxWidth={520}>
      <DataState loading={labels.isLoading} error={labels.error} onRetry={() => void labels.refetch()}>
        <Body target={target} labels={labels.data ?? []} onClose={onClose} onDone={onDone} />
      </DataState>
    </Modal>
  );
}

function Body({ target, labels, onClose, onDone }: { target: Target; labels: LabelRow[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>(target.kind === "contact" ? target.current : []);
  const [name, setName] = useState("");
  const [colour, setColour] = useState<ContactLabelColour>("green");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const refreshLabels = () => qc.invalidateQueries({ queryKey: contactKeys.labels });

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  const addNew = () =>
    run(async () => {
      if (!name.trim()) {
        setError("Give the label a name.");
        return;
      }
      const made = await contactsApi.createLabel(name.trim(), colour);
      setName("");
      setPicked([...picked, made.id]);
      await refreshLabels();
    });

  const save = () =>
    run(async () => {
      if (target.kind !== "contact") return;
      await contactsApi.setLabels(target.customerId, picked);
      toast.success("Saved.");
      onDone();
    });

  const bulk = (action: "add" | "remove") =>
    run(async () => {
      if (target.kind !== "bulk") return;
      if (picked.length === 0) {
        setError("Choose a label first.");
        return;
      }
      const r = await contactsApi.bulkLabels(target.customerIds, action === "add" ? picked : [], action === "remove" ? picked : []);
      toast.success(action === "add" ? `Label added. ${r.changed} change${r.changed === 1 ? "" : "s"} made.` : `Label removed. ${r.changed} change${r.changed === 1 ? "" : "s"} made.`);
      onDone();
    });

  const remove = (label: LabelRow) =>
    run(async () => {
      await contactsApi.deleteLabel(label.id);
      setDeleting(null);
      setPicked(picked.filter((x) => x !== label.id));
      await refreshLabels();
      await qc.invalidateQueries({ queryKey: contactKeys.all });
    });

  return (
    <>
      <div className="ct-form">
        {labels.length === 0 ? (
          <p className="ct-soft">No labels yet. Make one below, for example “Bulk buyer” or “Events”.</p>
        ) : (
          <ul className="ct-pick-list">
            {labels.map((l) => (
              <li key={l.id}>
                {deleting === l.id ? (
                  <div className="ct-note ct-note--amber">
                    Delete “{l.name}”? It comes off {l.contacts} contact{l.contacts === 1 ? "" : "s"}. The contacts themselves stay.{" "}
                    <button type="button" className="ct-linkish" disabled={busy} onClick={() => void remove(l)}>
                      Yes, delete
                    </button>{" "}
                    <button type="button" className="ct-linkish" disabled={busy} onClick={() => setDeleting(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <label>
                    <input type="checkbox" checked={picked.includes(l.id)} onChange={() => toggle(l.id)} />
                    <span className={`ct-label ct-label--${l.colour}`}>{l.name}</span>
                    <span className="ct-soft" style={{ marginLeft: "auto" }}>
                      {l.contacts}
                    </span>
                    <button type="button" className="ct-linkish" style={{ fontSize: 12 }} onClick={() => setDeleting(l.id)}>
                      Delete
                    </button>
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="ct-form__two">
          <div className="field">
            <label className="field__label" htmlFor="ct-label-new">New label</label>
            <input id="ct-label-new" className="input" maxLength={40} value={name} placeholder="For example: Bulk buyer" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ct-label-colour">Colour</label>
            <div style={{ display: "flex", gap: 8 }}>
              <select id="ct-label-colour" className="select" value={colour} onChange={(e) => setColour(e.target.value as ContactLabelColour)}>
                {CONTACT_LABEL_COLOURS.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn--subtle" disabled={busy || !name.trim()} onClick={() => void addNew()}>
                Add
              </button>
            </div>
          </div>
        </div>
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
        {target.kind === "contact" ? (
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--subtle" disabled={busy || picked.length === 0} onClick={() => void bulk("remove")}>
              Remove from them
            </button>
            <button type="button" className="btn btn--primary" disabled={busy || picked.length === 0} onClick={() => void bulk("add")}>
              Add to them
            </button>
          </>
        )}
      </div>
    </>
  );
}
