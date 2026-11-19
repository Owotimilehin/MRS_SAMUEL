/** Choose which ad account the suite reads (suite spec 12, 7.7). Owner only. Linking only reads at Meta. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { InlineLoader } from "@admin/components/Spinner.js";
import { humanizeError } from "@admin/lib/api.js";
import { adsApi } from "./ads-api.js";

export function LinkAccountDialog({ currentId, onClose, onDone }: { currentId: string | null; onClose: () => void; onDone: () => void }): JSX.Element {
  const q = useQuery({ queryKey: ["ads", "available"], queryFn: adsApi.availableAccounts, retry: false, staleTime: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function link(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await adsApi.link(id);
      onDone();
    } catch (e) {
      setError(humanizeError(e));
      setBusy(null);
    }
  }

  return (
    <Modal title="Choose ad account" onClose={onClose} maxWidth={560}>
      <div className="ads-card">
        {q.isLoading ? <InlineLoader /> : null}
        {q.error ? <div className="ads-strip ads-strip--bad">{humanizeError(q.error)}</div> : null}
        {q.data && q.data.length === 0 ? (
          <p style={{ margin: 0 }}>Meta did not list any ad account for the suite. Assign one to the system user in Business Settings, then try again.</p>
        ) : null}
        {(q.data ?? []).map((a) => (
          <div key={a.id} className="ads-row">
            <div className="ads-row__text">
              <span className="ads-row__label">
                {a.name} · {a.currency} · {a.timezone_name}
              </span>
              <span className="ads-sub">{a.id}</span>
            </div>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null || a.id === currentId} onClick={() => void link(a.id)}>
              {a.id === currentId ? "Linked" : busy === a.id ? "Linking…" : "Use this one"}
            </button>
          </div>
        ))}
        {currentId ? (
          <p className="ads-fine">Choosing a different ad account switches off creating adverts and rules until you turn them on again for the new account.</p>
        ) : null}
        {error ? <div className="ads-strip ads-strip--bad">{error}</div> : null}
      </div>
    </Modal>
  );
}
