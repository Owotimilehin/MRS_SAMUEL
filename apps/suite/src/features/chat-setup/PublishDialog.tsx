import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { ApiError } from "@admin/lib/api.js";
import { toast } from "@admin/lib/toast.js";
import type { ChatSetupConfig } from "@ms/shared";
import { chatSetupApi, chatSetupKeys, type ChatSetupView } from "./chat-setup-api.js";
import { diffSetup, liveNotes, type DiffCell } from "./chat-setup-logic.js";

function Cell({ cell }: { cell: DiffCell }): JSX.Element {
  if (cell.kind === "text") return <>{cell.text ?? "None"}</>;
  if (cell.kind === "flag") return <>{cell.on ? "On" : "Off"}</>;
  if (cell.items.length === 0) return <>None</>;
  return (
    <ol className="cs-list">
      {cell.items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ol>
  );
}

/**
 * The confirmation before anything is sent to Meta (foundation rule 7): exactly what changes,
 * and only what changes. "Publish now" sends confirm: true.
 */
export function PublishDialog({
  view,
  version,
  config,
  onClose,
}: {
  view: ChatSetupView;
  version: number;
  /** What will be live afterwards. */
  config: ChatSetupConfig;
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const kindName = view.account.kind === "messenger" ? "Messenger" : "Instagram";
  const rows = diffSetup(view.live?.config ?? null, config, view.account.kind);
  const notes = liveNotes(view);

  async function go(): Promise<void> {
    setBusy(true);
    try {
      const answer = await chatSetupApi.publish(view.account.id, version);
      qc.setQueryData<ChatSetupView>(chatSetupKeys.view(view.account.id), answer.view);
      await qc.invalidateQueries({ queryKey: chatSetupKeys.history(view.account.id) });
      // A 502 is not an error screen: the red strip on the page says what went wrong.
      if (answer.ok) toast.success("Published. Customers see the new set-up.");
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      await qc.invalidateQueries({ queryKey: chatSetupKeys.all(view.account.id) });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title="Publish chat set-up?"
      confirmLabel="Publish now"
      busyLabel="Publishing…"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => void go()}
    >
      <p style={{ margin: "0 0 10px" }}>
        This changes what customers see on <strong>{view.account.label}</strong> ({kindName}) straight away.
      </p>
      {rows.length === 0 ? (
        <p style={{ margin: 0 }}>Nothing about the visible set-up changes.</p>
      ) : (
        <div className="table-wrap">
          <table className="table cs-diff">
            <thead>
              <tr>
                <th />
                <th>Now</th>
                <th>After publishing</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row">{r.label}</th>
                  <td data-label="Now">
                    <Cell cell={r.now} />
                  </td>
                  <td data-label="After publishing">
                    <Cell cell={r.after} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notes.map((n) => (
        <p key={n.text} className="cs-note">
          {n.text}
        </p>
      ))}
    </ConfirmModal>
  );
}
