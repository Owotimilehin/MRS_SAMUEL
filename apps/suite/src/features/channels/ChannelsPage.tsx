/**
 * Channels (suite spec 01, 7.2): every place customers reach us. Phone lines
 * are listed and changed under Settings; a Facebook Page and its Instagram
 * account are connected, renamed, checked and switched off here.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Facebook, Instagram, Phone, Plus } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { inboxKeys } from "@admin/lib/inbox-api.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import { channelKeys, channelsApi, type ChannelRow } from "./channels-api.js";
import { healthDotOf, secondLine, statusOf, usedForText } from "./channels-logic.js";
import { metaHealthApi, metaHealthKeys, type MetaHealth } from "./meta-health-api.js";
import { ConnectDialog } from "./ConnectDialog.js";
import { EditChannelDialog } from "./EditChannelDialog.js";

const KIND_ICON = { phone: Phone, messenger: Facebook, instagram: Instagram } as const;

export function ChannelsPage(): JSX.Element {
  const can = useCan();
  if (!can("channels.manage")) {
    return (
      <Frame title="Channels">
        <div className="card">
          You don&apos;t have access to Channels. Ask the owner to give your account the permission &quot;Connect and set up
          channels&quot;.
        </div>
      </Frame>
    );
  }
  return <ChannelsList />;
}

function ChannelsList(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: channelKeys.list, queryFn: channelsApi.list });
  // Same key as the banner in SuiteShell, so both show the same check.
  const health = useQuery({ queryKey: metaHealthKeys.all, queryFn: metaHealthApi.get, staleTime: 60_000, retry: false });
  const [connectOpen, setConnectOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelRow | null>(null);
  const [switchingOff, setSwitchingOff] = useState<ChannelRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const rows = q.data?.data ?? [];
  const teams = q.data?.teams ?? [];
  const hoursProfiles = q.data?.hours_profiles ?? [];

  const refresh = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: channelKeys.list }),
      qc.invalidateQueries({ queryKey: channelKeys.available }),
      qc.invalidateQueries({ queryKey: inboxKeys.me }),
    ]);
  };

  async function check(row: ChannelRow): Promise<void> {
    setBusy(row.id);
    try {
      const r = await channelsApi.check(row.id);
      setProblems((p) => {
        const next = { ...p };
        if (r.ok) delete next[row.id];
        else next[row.id] = `${row.label}: ${r.problem ?? "Something is wrong with this connection."}`;
        return next;
      });
      if (r.ok) toast.success(`${row.label}: connected.`);
      await qc.invalidateQueries({ queryKey: channelKeys.list });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  async function setActive(row: ChannelRow, on: boolean): Promise<void> {
    setBusy(row.id);
    try {
      await channelsApi.update(row.id, { is_active: on });
      if (on) toast.success(`${row.label} is on.`);
      setSwitchingOff(null);
      await refresh();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  return (
    <Frame
      title="Channels"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setConnectOpen(true)}>
          <Plus size={14} aria-hidden /> Connect Facebook or Instagram
        </button>
      }
    >
      <p style={{ color: "var(--ink-soft)", margin: "0 0 12px" }}>
        The places customers can reach you. New chats from each one go to the team you choose.
      </p>
      <section className="card ibx-settings">
        <DataState
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          isEmpty={rows.length === 0}
          emptyTitle="No channels yet"
          emptyHint="Connect your Facebook Page or add a phone line in Settings."
        >
          <div className="table-wrap">
            <table className="table ibx-stack">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Used for</th>
                  <th>Team</th>
                  <th>Hours</th>
                  <th>Status</th>
                  <th className="table__num">Open chats</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const Icon = KIND_ICON[row.kind] ?? Phone;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 700 }}>
                          <Icon size={16} aria-hidden /> {row.label}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--ink-soft)", overflowWrap: "anywhere" }}>{secondLine(row)}</div>
                        {problems[row.id] && (
                          <div className="field__error" role="alert" style={{ marginTop: 4 }}>
                            {problems[row.id]}
                          </div>
                        )}
                      </td>
                      <td data-label="Used for">{usedForText(row)}</td>
                      <td data-label="Team">{row.team_name ?? "No team"}</td>
                      <td data-label="Hours">{row.hours_profile_name ?? "Always open"}</td>
                      <td data-label="Status">
                        <StatusCell row={row} health={health.data} />
                      </td>
                      <td className="table__num" data-label="Open chats">
                        {row.open_conversations}
                      </td>
                      <td className="ibx-stack__actions">
                        <div className="ibx-actions">
                          {row.kind === "phone" ? (
                            <>
                              {row.channels !== "voice" && (
                                <Link
                                  to="/channels/$accountId/whatsapp-profile"
                                  params={{ accountId: row.id }}
                                  className="btn btn--subtle btn--sm"
                                >
                                  Business profile
                                </Link>
                              )}
                              <Link to="/inbox/settings" className="btn btn--subtle btn--sm">
                                Change in Settings
                              </Link>
                            </>
                          ) : (
                            <>
                              <Link
                                to="/channels/$accountId/chat-setup"
                                params={{ accountId: row.id }}
                                className="btn btn--subtle btn--sm"
                              >
                                Chat set-up
                              </Link>
                              <Link
                                to="/channels/$accountId/page"
                                params={{ accountId: row.id }}
                                className="btn btn--subtle btn--sm"
                              >
                                {row.kind === "instagram" ? "Profile" : "Page details"}
                              </Link>
                              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setEditing(row)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn--subtle btn--sm"
                                disabled={busy === row.id}
                                onClick={() => void check(row)}
                              >
                                {busy === row.id ? "Checking…" : "Check connection"}
                              </button>
                              {row.is_active ? (
                                <button type="button" className="btn btn--subtle btn--sm" disabled={busy === row.id} onClick={() => setSwitchingOff(row)}>
                                  Switch off
                                </button>
                              ) : (
                                <button type="button" className="btn btn--subtle btn--sm" disabled={busy === row.id} onClick={() => void setActive(row, true)}>
                                  Switch on
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DataState>
      </section>
      <section className="card" style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Before customers outside the team can message you</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--ink-soft)" }}>
          <li>Meta must verify the business.</li>
          <li>Meta must review the app (the technical lead submits this).</li>
          <li>Until then, only people added as testers can be answered.</li>
        </ul>
      </section>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 12 }}>
        Staff who only see some channels will not see chats from a new one until you tick it for them in{" "}
        <Link to="/inbox/settings">Settings</Link>, Staff access.
      </p>

      {connectOpen && <ConnectDialog teams={teams} hoursProfiles={hoursProfiles} onClose={() => setConnectOpen(false)} />}
      {editing && (
        <EditChannelDialog row={editing} teams={teams} hoursProfiles={hoursProfiles} onClose={() => setEditing(null)} />
      )}
      {switchingOff && (
        <ConfirmModal
          title={`Switch off ${switchingOff.label}?`}
          confirmLabel="Switch off"
          busyLabel="Switching off…"
          busy={busy === switchingOff.id}
          onCancel={() => setSwitchingOff(null)}
          onConfirm={() => void setActive(switchingOff, false)}
        >
          <p style={{ margin: 0 }}>
            New messages on this channel will stop coming into the inbox. Chats you already have stay where they are. You can
            switch it back on at any time.
          </p>
        </ConfirmModal>
      )}
    </Frame>
  );
}

/** Status column: on/off, and for a Page or Instagram account whether messages come in (spec 02, 7.6). */
function StatusCell({ row, health }: { row: ChannelRow; health: MetaHealth | undefined }): JSX.Element {
  const st = statusOf(row);
  const cls = st.tone === "off" ? "pill" : `pill pill--${st.tone}`;
  // The dot from the hourly Meta check (Watchdog). Its reason is shown unless the row already says the same.
  const dot = row.is_active ? healthDotOf(health?.items, row.id) : null;
  const why = dot?.why && dot.why !== st.detail ? dot.why : null;
  return (
    <>
      <span className={cls}>{st.text}</span>
      {st.detail && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}>{st.detail}</div>}
      {dot && (
        <div style={{ marginTop: 6 }}>
          <span
            className={`health-dot health-dot--${dot.status}`}
            title={health?.checked_at ? `Last checked ${new Date(health.checked_at).toLocaleString("en-NG")}` : undefined}
          >
            {dot.text}
          </span>
          {why && <div className="health-dot__why">{why}</div>}
        </div>
      )}
    </>
  );
}
