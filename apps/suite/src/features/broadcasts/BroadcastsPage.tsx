/** Broadcasts list (suite spec 14, 7.8): one approved WhatsApp message sent to a list of contacts. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, Settings2 } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { broadcastKeys, broadcastsApi } from "./broadcasts-api.js";
import { countsLine, lagosWhen, statusPill } from "./broadcasts-logic.js";
import { BroadcastSettingsDialog } from "./BroadcastSettingsDialog.js";
import "./broadcasts.css";

export function BroadcastsPage(): JSX.Element {
  const can = useCan();
  const navigate = useNavigate();
  const sender = can("broadcasts.send");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const list = useQuery({
    queryKey: broadcastKeys.list,
    queryFn: broadcastsApi.list,
    // Refresh every 15 seconds while anything is sending.
    refetchInterval: (q) => ((q.state.data ?? []).some((b) => b.status === "sending") ? 15_000 : false),
  });
  const settings = useQuery({ queryKey: broadcastKeys.settings, queryFn: broadcastsApi.settings, refetchOnWindowFocus: false });
  const health = useQuery({ queryKey: broadcastKeys.health, queryFn: broadcastsApi.health, enabled: sender, refetchOnWindowFocus: false, staleTime: 5 * 60_000 });
  const rows = list.data ?? [];
  const problems = health.data?.problems ?? [];

  return (
    <Frame
      title="Broadcasts"
      subtitle="One approved WhatsApp message sent to a list of contacts."
      actions={
        sender ? (
          <div className="bc-row">
            <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={16} aria-hidden="true" /> Broadcast settings
            </button>
            <Link to="/broadcasts/new" className="btn btn--primary">
              <Plus size={16} aria-hidden="true" /> New broadcast
            </Link>
          </div>
        ) : undefined
      }
    >
      <div className="bc-page">
        {settings.data && !settings.data.enabled && (
          <div className="bc-notice bc-notice--amber">
            <span>Broadcasts are switched off. You can prepare and test one, but nothing is sent to customers until the owner switches them on.</span>
            {sender && (
              <span>
                <button type="button" className="bc-link" onClick={() => setSettingsOpen(true)}>
                  Broadcast settings
                </button>
              </span>
            )}
          </div>
        )}
        {problems.length > 0 && (
          <div className="bc-notice bc-notice--red">
            <span>WhatsApp is not ready to send broadcasts: {problems.map((p) => p.plain).join("; ")}.</span>
          </div>
        )}
        <DataState
          loading={list.isLoading}
          error={list.error}
          isEmpty={rows.length === 0}
          emptyTitle="No broadcasts yet."
          emptyHint={sender ? "Press “New broadcast” to send an approved message to one of your lists." : "Broadcasts the owner sends will show here."}
          onRetry={() => void list.refetch()}
        >
          <div className="card">
            <div className="table-wrap">
              <table className="table bc-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>List</th>
                    <th>Template</th>
                    <th>Results</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => {
                    const pill = statusPill(b.status, b.scheduled_at);
                    const go = () =>
                      b.status === "draft" && sender
                        ? void navigate({ to: "/broadcasts/$broadcastId/edit", params: { broadcastId: b.id } })
                        : void navigate({ to: "/broadcasts/$broadcastId", params: { broadcastId: b.id } });
                    return (
                      <tr key={b.id} className="is-clickable" onClick={go}>
                        <td>
                          <button type="button" className="bc-link bc-name" style={{ textDecoration: "none" }} onClick={(e) => (e.stopPropagation(), go())}>
                            {b.name}
                          </button>
                        </td>
                        <td data-label="Status">
                          <span className={`pill pill--${pill.tone}`}>{pill.label}</span>
                        </td>
                        <td data-label="List">{b.list_name ?? "—"}</td>
                        <td data-label="Template">{b.template_name ?? "—"}</td>
                        <td data-label="Results" className="bc-num">
                          {b.status === "draft" ? "—" : countsLine(b.counts)}
                        </td>
                        <td data-label="Date">{lagosWhen(b.started_at ?? b.scheduled_at ?? b.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </DataState>
      </div>
      {settingsOpen && <BroadcastSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </Frame>
  );
}
