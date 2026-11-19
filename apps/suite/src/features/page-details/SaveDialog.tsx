import { useState } from "react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import type { PageEditable, PageEditableKey } from "@ms/shared";
import { pageDetailsApi, SaveFailure, type PageDetailsView, type SaveAnswer } from "./page-details-api.js";
import { beforeAfterRows } from "./page-details-logic.js";

function Lines({ lines }: { lines: string[] }): JSX.Element {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </>
  );
}

/** The before-and-after confirm (foundation rule 7). "Save to Facebook" sends confirm: true and only the changed fields. */
export function SaveDialog({
  view,
  live,
  form,
  keys,
  changes,
  onClose,
  onAnswer,
  onFailure,
}: {
  view: PageDetailsView;
  live: PageEditable;
  form: PageEditable;
  keys: PageEditableKey[];
  /** The changed fields only, as typed (the server tidies them). */
  changes: Partial<PageEditable>;
  onClose: () => void;
  onAnswer: (a: SaveAnswer) => void;
  onFailure: (f: SaveFailure) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const rows = beforeAfterRows(live, form);
  const expected: Partial<PageEditable> = {};
  for (const k of keys) (expected as Record<string, unknown>)[k] = live[k];

  async function go(): Promise<void> {
    setBusy(true);
    try {
      onAnswer(await pageDetailsApi.save(view.account.id, expected, changes));
    } catch (err) {
      onFailure(err instanceof SaveFailure ? err : new SaveFailure(0, "Something went wrong. Please try again.", false, null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title="Save these changes to Facebook?"
      confirmLabel="Save to Facebook"
      busyLabel="Saving…"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => void go()}
    >
      <p style={{ margin: "0 0 10px" }}>
        These details are public. They change on your Facebook Page <strong>{view.page?.name ?? view.account.label}</strong> straight away.
      </p>
      <table className="table pd-diff">
        <thead>
          <tr>
            <th>Detail</th>
            <th>Now on Facebook</th>
            <th>After saving</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td data-label="Now"><Lines lines={r.now} /></td>
              <td data-label="After"><Lines lines={r.after} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </ConfirmModal>
  );
}
