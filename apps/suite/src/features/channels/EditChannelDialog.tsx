import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { inboxKeys } from "@admin/lib/inbox-api.js";
import { toast } from "@admin/lib/toast.js";
import { channelKeys, channelsApi, type ChannelRow, type NamedOption } from "./channels-api.js";
import { connectedToText } from "./channels-logic.js";

/** Rename a Page or Instagram account, and choose its team and opening hours (spec 01, 7.4). */
export function EditChannelDialog({
  row,
  teams,
  hoursProfiles,
  onClose,
}: {
  row: ChannelRow;
  teams: NamedOption[];
  hoursProfiles: NamedOption[];
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [label, setLabel] = useState(row.label);
  const [teamId, setTeamId] = useState(row.default_team_id ?? "");
  const [hoursId, setHoursId] = useState(row.hours_profile_id ?? "");
  const [busy, setBusy] = useState(false);
  const ready = label.trim().length > 0 && label.trim().length <= 60;

  // A team or hours profile that was switched off still shows as the current choice.
  const teamOptions = row.default_team_id && !teams.some((t) => t.id === row.default_team_id)
    ? [...teams, { id: row.default_team_id, name: row.team_name ?? "Current team" }]
    : teams;

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await channelsApi.update(row.id, {
        label: label.trim(),
        default_team_id: teamId || null,
        hours_profile_id: hoursId || null,
      });
      toast.success("Saved.");
      await Promise.all([
        qc.invalidateQueries({ queryKey: channelKeys.list }),
        qc.invalidateQueries({ queryKey: inboxKeys.me }),
      ]);
      onClose();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${row.label}`} onClose={onClose}>
      <div style={{ display: "grid", gap: 10 }}>
        <label className="field">
          <span className="field__label">Name in the inbox</span>
          <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Team for new chats</span>
          <select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">No team</option>
            {teamOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Opening hours</span>
          <select className="select" value={hoursId} onChange={(e) => setHoursId(e.target.value)}>
            <option value="">Always open</option>
            {hoursProfiles.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{connectedToText(row)}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button type="button" className="btn btn--subtle" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!ready || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
