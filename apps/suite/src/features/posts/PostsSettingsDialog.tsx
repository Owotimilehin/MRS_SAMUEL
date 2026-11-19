/**
 * Posts settings (suite spec 09, 7.6): the owner's switch for scheduled publishing.
 * Off by default (foundation correction C6). Only the owner sees the gear that opens this.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { toast } from "@admin/lib/toast.js";
import { postsApi, postsKeys } from "./posts-api.js";

export function PostsSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: postsKeys.settings, queryFn: postsApi.settings });
  const [choice, setChoice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const on = choice ?? q.data?.scheduled_enabled ?? false;

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const saved = await postsApi.saveSettings(on);
      qc.setQueryData(postsKeys.settings, saved);
      await qc.invalidateQueries({ queryKey: postsKeys.accounts });
      toast.success(saved.scheduled_enabled ? "Scheduled posts will go out by themselves." : "Scheduling is switched off.");
      onClose();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Posts settings" onClose={onClose} maxWidth={520}>
      {q.isLoading ? (
        <p className="po-fine">Loading…</p>
      ) : q.error ? (
        <div className="po-strip po-strip--bad">We couldn't load the settings. Close this and try again.</div>
      ) : (
        <div className="po-block">
          <label className="po-switch">
            <input type="checkbox" role="switch" checked={on} onChange={(e) => setChoice(e.target.checked)} />
            <span>Let scheduled posts go out by themselves</span>
          </label>
          <p className="po-fine" style={{ fontSize: 13 }}>
            When this is on, a post that someone has checked and scheduled is sent at its time without anyone pressing a button. When it is off,
            nothing can be scheduled and posts already scheduled will not go out.
          </p>
        </div>
      )}
      <div className="po-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy || q.isLoading || !!q.error || choice === null}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
