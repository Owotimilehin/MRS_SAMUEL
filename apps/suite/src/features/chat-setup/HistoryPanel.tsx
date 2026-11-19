import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DataState } from "@admin/components/DataState.js";
import { toast } from "@admin/lib/toast.js";
import type { ChatSetupConfig } from "@ms/shared";
import { chatSetupApi, chatSetupKeys, type ChatSetupView } from "./chat-setup-api.js";
import { lagosDateTime, statusWord } from "./chat-setup-logic.js";

/** Past versions: who published what, and when. "Use as draft" copies one back. */
export function HistoryPanel({
  accountId,
  disabled,
  onView,
  onRestored,
}: {
  accountId: string;
  disabled: boolean;
  onView: (version: number, config: ChatSetupConfig) => void;
  onRestored: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const q = useQuery({ queryKey: chatSetupKeys.history(accountId), queryFn: () => chatSetupApi.history(accountId), enabled: open });
  const rows = q.data ?? [];

  async function restore(version: number): Promise<void> {
    setBusy(version);
    try {
      const view = await chatSetupApi.restore(accountId, version);
      qc.setQueryData<ChatSetupView>(chatSetupKeys.view(accountId), view);
      toast.success("Copied into your draft");
      onRestored();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="card cs-block" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cs-summary">Past versions</summary>
      {open && (
        <DataState
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          isEmpty={rows.length === 0}
          emptyTitle="Nothing published yet"
          emptyHint="Each publish will be listed here."
        >
          <ul className="cs-history">
            {rows.map((r) => (
              <li key={r.version}>
                <div>
                  {lagosDateTime(r.at)} &middot; {r.by_name ?? "Someone"} &middot; {statusWord(r.status)}
                </div>
                {r.error_message && <div className="cs-fine">{r.error_message}</div>}
                <div className="cs-row cs-row--actions">
                  <button type="button" className="btn btn--subtle btn--sm" onClick={() => onView(r.version, r.config)}>
                    View
                  </button>
                  <button type="button" className="btn btn--subtle btn--sm" disabled={disabled || busy === r.version} onClick={() => void restore(r.version)}>
                    {busy === r.version ? "Copying…" : "Use as draft"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </DataState>
      )}
    </details>
  );
}
