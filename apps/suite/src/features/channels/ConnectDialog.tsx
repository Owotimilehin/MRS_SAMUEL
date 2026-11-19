import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { humanizeError } from "@admin/lib/api.js";
import { inboxKeys } from "@admin/lib/inbox-api.js";
import { toast } from "@admin/lib/toast.js";
import { channelKeys, channelsApi, type AvailablePage, type NamedOption } from "./channels-api.js";
import {
  connectReady,
  connectedToast,
  emptySelection,
  toggleBox,
  type ConnectKind,
  type ConnectSelection,
} from "./channels-logic.js";

/** Pick a Facebook Page and/or its Instagram account and connect them (spec 01, 7.3). */
export function ConnectDialog({
  teams,
  hoursProfiles,
  onClose,
}: {
  teams: NamedOption[];
  hoursProfiles: NamedOption[];
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const available = useQuery({ queryKey: channelKeys.available, queryFn: channelsApi.available, retry: false });
  const [lookedUp, setLookedUp] = useState<AvailablePage | null>(null);
  const [pageIdText, setPageIdText] = useState("");
  const [lookUpBusy, setLookUpBusy] = useState(false);
  const [lookUpError, setLookUpError] = useState<string | null>(null);
  const [sel, setSel] = useState<ConnectSelection>(emptySelection);
  const [teamId, setTeamId] = useState("");
  const [hoursId, setHoursId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pages: AvailablePage[] = available.data?.length ? available.data : lookedUp ? [lookedUp] : [];
  const ready = connectReady(sel);

  function tick(pageId: string, kind: ConnectKind, on: boolean): void {
    setSel((s) => toggleBox(s, pageId, kind, on));
    setSaveError(null);
  }

  async function lookUp(): Promise<void> {
    setLookUpBusy(true);
    setLookUpError(null);
    try {
      setLookedUp(await channelsApi.lookUp(pageIdText.trim()));
    } catch (err) {
      setLookUpError(humanizeError(err));
    } finally {
      setLookUpBusy(false);
    }
  }

  async function connect(): Promise<void> {
    if (!ready || !sel.pageId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const rows = await channelsApi.connect({
        page_id: sel.pageId,
        messenger: sel.messenger,
        instagram: sel.instagram,
        ...(sel.messenger ? { label_messenger: sel.labels.messenger.trim() } : {}),
        ...(sel.instagram ? { label_instagram: sel.labels.instagram.trim() } : {}),
        default_team_id: teamId || null,
        hours_profile_id: hoursId || null,
      });
      toast.success(connectedToast(rows.map((r) => r.label)));
      await Promise.all([
        qc.invalidateQueries({ queryKey: channelKeys.list }),
        qc.invalidateQueries({ queryKey: channelKeys.available }),
        qc.invalidateQueries({ queryKey: inboxKeys.me }),
      ]);
      onClose();
    } catch (err) {
      setSaveError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  }

  const labelField = (kind: ConnectKind): JSX.Element => (
    <label className="field" key={kind}>
      <span className="field__label">Name in the inbox{sel.messenger && sel.instagram ? ` (${kind === "messenger" ? "Facebook" : "Instagram"})` : ""}</span>
      <input
        className="input"
        value={sel.labels[kind]}
        maxLength={60}
        onChange={(e) => setSel((s) => ({ ...s, labels: { ...s.labels, [kind]: e.target.value } }))}
      />
    </label>
  );

  let body: JSX.Element;
  if (available.isLoading) {
    body = <div style={{ color: "var(--ink-soft)" }}>Looking up your Pages…</div>;
  } else if (available.error) {
    body = (
      <div style={{ display: "grid", gap: 10 }}>
        <div className="field__error" role="alert">{humanizeError(available.error)}</div>
        <button type="button" className="btn btn--subtle btn--sm" style={{ justifySelf: "start" }} onClick={() => void available.refetch()}>
          Try again
        </button>
      </div>
    );
  } else {
    body = (
      <div style={{ display: "grid", gap: 14 }}>
        {(available.data ?? []).length === 0 && (
          <div style={{ display: "grid", gap: 8 }}>
            <div>We couldn't find any Pages for this account.</div>
            <label className="field">
              <span className="field__label">Facebook Page ID</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  inputMode="numeric"
                  value={pageIdText}
                  onChange={(e) => setPageIdText(e.target.value.replace(/\D/g, ""))}
                />
                <button
                  type="button"
                  className="btn btn--subtle"
                  disabled={lookUpBusy || pageIdText.length < 5}
                  onClick={() => void lookUp()}
                >
                  {lookUpBusy ? "Looking…" : "Look up"}
                </button>
              </div>
              <span className="field__hint">You can find the Page ID in Facebook under the Page's About, Page transparency.</span>
            </label>
            {lookUpError && <div className="field__error" role="alert">{lookUpError}</div>}
          </div>
        )}
        {pages.length > 0 && (
          <div style={{ display: "grid", gap: 10 }}>
            <div className="t-eyebrow">Choose what to connect</div>
            {pages.map((p) => (
              <PageBlock key={p.page_id} page={p} sel={sel} onTick={tick} />
            ))}
          </div>
        )}
        {(sel.messenger || sel.instagram) && (
          <div style={{ display: "grid", gap: 10 }}>
            {sel.messenger && labelField("messenger")}
            {sel.instagram && labelField("instagram")}
            <label className="field">
              <span className="field__label">Team for new chats</span>
              <select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">No team</option>
                {teams.map((t) => (
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
          </div>
        )}
        {saveError && (
          <div style={{ display: "grid", gap: 8 }}>
            <div className="field__error" role="alert">{saveError}</div>
            <button type="button" className="btn btn--subtle btn--sm" style={{ justifySelf: "start" }} disabled={!ready || saving} onClick={() => void connect()}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal title="Connect Facebook or Instagram" onClose={onClose} maxWidth={560}>
      <div style={{ maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>{body}</div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button type="button" className="btn btn--subtle" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!ready || saving} onClick={() => void connect()}>
          {saving ? "Connecting…" : "Connect"}
        </button>
      </div>
    </Modal>
  );
}

function PageBlock({
  page,
  sel,
  onTick,
}: {
  page: AvailablePage;
  sel: ConnectSelection;
  onTick: (pageId: string, kind: ConnectKind, on: boolean) => void;
}): JSX.Element {
  const mine = sel.pageId === page.page_id;
  const hint = { fontSize: 12, color: "var(--ink-soft)", marginLeft: 24 } as const;
  return (
    <div className="card card--soft" style={{ display: "grid", gap: 8 }}>
      <div>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={page.messenger_connected || (mine && sel.messenger)}
            disabled={page.messenger_connected || !page.can_message}
            onChange={(e) => onTick(page.page_id, "messenger", e.target.checked)}
          />
          <span>
            <strong>Facebook Page: {page.name}</strong> — messages sent to the Page on Messenger
          </span>
        </label>
        {page.messenger_connected ? (
          <div style={hint}>Already connected</div>
        ) : !page.can_message ? (
          <div style={hint}>We don't have messaging rights on this Page. Ask the technical lead.</div>
        ) : null}
      </div>
      {page.instagram ? (
        <div>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={page.instagram.connected || (mine && sel.instagram)}
              disabled={page.instagram.connected}
              onChange={(e) => onTick(page.page_id, "instagram", e.target.checked)}
            />
            <span>
              <strong>Instagram: @{page.instagram.username ?? page.instagram.id}</strong> — direct messages to this account
            </span>
          </label>
          {page.instagram.connected && <div style={hint}>Already connected</div>}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>No Instagram account is linked to this Page.</div>
      )}
    </div>
  );
}
