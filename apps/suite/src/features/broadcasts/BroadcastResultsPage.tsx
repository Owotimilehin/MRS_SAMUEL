/** Broadcast results (suite spec 14, 7.10): what happened, who it reached, why some failed, and orders afterwards. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, MessageSquare } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { groupThousands, type BroadcastDetail } from "@ms/shared";
import { broadcastKeys, broadcastsApi, failureText } from "./broadcasts-api.js";
import { eventLine, lagosWhen, ordersLine, RESULT_LABEL, resultTiles, statusPill, stopBanner, waitingBanner } from "./broadcasts-logic.js";
import { ConfirmSendDialog } from "./ConfirmSendDialog.js";
import "./broadcasts.css";

const FILTERS = [
  { key: "", label: "Everyone" },
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered" },
  { key: "read", label: "Read" },
  { key: "failed", label: "Failed" },
  { key: "unknown", label: "Not confirmed" },
  { key: "skipped", label: "Left out" },
  { key: "pending", label: "Waiting" },
] as const;

function People({ id, canExport }: { id: string; canExport: boolean }): JSX.Element {
  const [state, setState] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return (
    <section className="card bc-card">
      <div className="bc-row">
        <h3>People</h3>
        <span className="bc-spacer" />
        {canExport && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => broadcastsApi.download(id).catch((err: unknown) => toast.error(failureText(err)))}
          >
            <Download size={16} aria-hidden="true" /> Download
          </button>
        )}
      </div>
      <div className="bc-seg" role="tablist" aria-label="Filter by result">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={state === f.key}
            onClick={() => {
              setState(f.key);
              setCursors([null]);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="table bc-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Result</th>
              <th>Sent</th>
              <th>Replied</th>
              <th aria-label="Conversation" />
            </tr>
          </thead>
          <tbody>
            {cursors.map((c, i) => (
              <PeoplePage key={`${state}:${c ?? "first"}`} id={id} state={state} cursor={c} last={i === cursors.length - 1} onMore={(next) => setCursors((x) => [...x, next])} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PeoplePage({ id, state, cursor, last, onMore }: { id: string; state: string; cursor: string | null; last: boolean; onMore: (c: string) => void }): JSX.Element {
  const q = useQuery({ queryKey: [...broadcastKeys.recipients(id, state), cursor], queryFn: () => broadcastsApi.recipients(id, state, cursor), refetchOnWindowFocus: false });
  if (q.isLoading)
    return (
      <tr>
        <td colSpan={6}>Loading…</td>
      </tr>
    );
  if (q.error)
    return (
      <tr>
        <td colSpan={6}>{failureText(q.error)}</td>
      </tr>
    );
  const rows = q.data?.recipients ?? [];
  if (rows.length === 0 && !cursor)
    return (
      <tr>
        <td colSpan={6} className="bc-soft">
          Nobody here.
        </td>
      </tr>
    );
  return (
    <>
      {rows.map((r) => (
        <tr key={r.id}>
          <td>
            {r.customer_id ? (
              <Link to="/contacts/$customerId" params={{ customerId: r.customer_id }} className="bc-name">
                {r.name?.trim() || "No name"}
              </Link>
            ) : (
              <span className="bc-soft">Deleted on request</span>
            )}
          </td>
          <td data-label="Phone">{r.phone ?? "—"}</td>
          <td data-label="Result">
            {RESULT_LABEL[r.state] ?? r.state}
            {r.opted_out_at ? " · asked to stop" : ""}
            {r.plain_reason && <div className="bc-faint">{r.plain_reason}</div>}
          </td>
          <td data-label="Sent">{lagosWhen(r.sent_at)}</td>
          <td data-label="Replied">{r.replied_at ? lagosWhen(r.replied_at) : "—"}</td>
          <td>
            {r.conversation_id && (
              <Link to="/inbox/$conversationId" params={{ conversationId: r.conversation_id }} className="btn btn--icon btn--sm" aria-label="Open the conversation">
                <MessageSquare size={16} aria-hidden="true" />
              </Link>
            )}
          </td>
        </tr>
      ))}
      {last && q.data?.next_cursor && (
        <tr>
          <td colSpan={6}>
            <button type="button" className="bc-link" onClick={() => onMore(q.data!.next_cursor!)}>
              Show more
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

function Actions({ d, waiting }: { d: BroadcastDetail; waiting: number }): JSX.Element | null {
  const qc = useQueryClient();
  const [ask, setAsk] = useState<"pause" | "cancel" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: broadcastKeys.all });
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      toast.success(done);
      setAsk(null);
    } catch (err) {
      toast.error(failureText(err));
    } finally {
      setBusy(false);
    }
  };
  if (!d.can.pause && !d.can.resume && !d.can.cancel) return null;
  return (
    <div className="bc-row">
      {d.can.pause && (
        <button type="button" className="btn" onClick={() => setAsk("pause")}>
          Pause
        </button>
      )}
      {d.can.resume && (
        <button type="button" className="btn btn--primary" onClick={() => setAsk("resume")}>
          Resume
        </button>
      )}
      {d.can.cancel && (
        <button type="button" className="btn" onClick={() => setAsk("cancel")}>
          Cancel broadcast
        </button>
      )}
      {ask === "pause" && (
        <ConfirmModal title="Pause this broadcast?" confirmLabel="Pause" busyLabel="Pausing…" busy={busy} onCancel={() => setAsk(null)} onConfirm={() => void run(() => broadcastsApi.pause(d.id), "Paused.")}>
          <p>
            {groupThousands(waiting)} {waiting === 1 ? "person has" : "people have"} not been sent it yet.
          </p>
        </ConfirmModal>
      )}
      {ask === "cancel" && (
        <ConfirmModal
          title="Cancel for good?"
          tone="danger"
          confirmLabel="Cancel broadcast"
          busyLabel="Cancelling…"
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={() => void run(() => broadcastsApi.cancel(d.id), "Cancelled.")}
        >
          <p>
            {groupThousands(waiting)} {waiting === 1 ? "person" : "people"} will not get it. People who already got it are not affected.
          </p>
        </ConfirmModal>
      )}
      {ask === "resume" && (
        <ConfirmSendDialog
          mode="resume"
          count={waiting}
          templateName={d.template_name ?? ""}
          listName={d.list_name ?? ""}
          lineLabel={d.line_label ?? "your number"}
          whenText="now"
          scheduled={false}
          exampleText={d.preview_text}
          skipped={0}
          sendFrom={d.send_from}
          sendUntil={d.send_until}
          rate={d.rate_per_minute}
          onClose={() => setAsk(null)}
          onConfirm={async (n) => {
            await broadcastsApi.resume(d.id, n);
            await refresh();
            toast.success("Sending again.");
            setAsk(null);
          }}
        />
      )}
    </div>
  );
}

export function BroadcastResultsPage({ broadcastId }: { broadcastId: string }): JSX.Element {
  const can = useCan();
  const live = (s: string | undefined) => (s === "sending" ? 15_000 : false);
  const detail = useQuery({ queryKey: broadcastKeys.one(broadcastId), queryFn: () => broadcastsApi.get(broadcastId), refetchInterval: (q) => live(q.state.data?.status) });
  const results = useQuery({
    queryKey: broadcastKeys.results(broadcastId),
    queryFn: () => broadcastsApi.results(broadcastId),
    refetchInterval: () => live(detail.data?.status),
  });
  const d = detail.data;
  const r = results.data;
  const pill = d ? statusPill(d.status, d.scheduled_at) : null;
  const waitingText = d?.status === "sending" ? waitingBanner(d.waiting, d.send_from) : null;

  return (
    <Frame title={d?.name ?? "Broadcast"} crumb="Broadcasts" pageName="Results" actions={d ? <Actions d={d} waiting={d.counts.waiting} /> : undefined}>
      <div className="bc-page">
        <div>
          <Link to="/broadcasts" className="bc-link">
            ← All broadcasts
          </Link>
        </div>
        {detail.error && <p className="bc-notice bc-notice--red">{failureText(detail.error)}</p>}
        {d && pill && (
          <div className="bc-row">
            <span className={`pill pill--${pill.tone}`}>{pill.label}</span>
            {d.confirmed_at && (
              <span className="bc-soft">
                Confirmed by {d.confirmed_by_name ?? "someone"} on {lagosWhen(d.confirmed_at)} for {groupThousands(d.confirmed_count ?? 0)} people
              </span>
            )}
            <span className="bc-soft">
              · {d.list_name ?? "—"} · {d.template_name ?? "—"} · {d.line_label ?? "—"}
            </span>
            {d.status === "draft" && d.can.edit && (
              <Link to="/broadcasts/$broadcastId/edit" params={{ broadcastId }} className="btn btn--sm">
                Open the draft
              </Link>
            )}
          </div>
        )}
        {d?.status === "stopped" &&
          (() => {
            const b = stopBanner(d.stop_reason, d.stop_detail);
            return (
              <div className="bc-notice bc-notice--red" role="alert">
                <strong>{b.title}</strong>
                {b.detail && <span>{b.detail}</span>}
                <span>{b.todo}</span>
              </div>
            );
          })()}
        {waitingText && <p className="bc-notice">{waitingText}</p>}
        {results.error && <p className="bc-notice bc-notice--red">{failureText(results.error)}</p>}
        {r && (
          <>
            <div className="bc-tiles">
              {resultTiles(r.counts).map((t) => (
                <div className="card bc-tile" key={t.key} title={t.help}>
                  <span className="bc-tile__label">{t.label}</span>
                  <span className="bc-tile__value">{groupThousands(t.value)}</span>
                  <span className="bc-tile__share">{t.share}</span>
                  {t.help && <span className="bc-faint">{t.help}</span>}
                </div>
              ))}
            </div>
            <section className="card bc-card">
              <h3>Orders afterwards</h3>
              <p className="bc-num">{ordersLine(r.orders)}</p>
              <p className="bc-soft">
                This shows who ordered after the message, not proof that the message was the reason. Orders at the counter with no name are not counted, and nor is a
                customer who orders under a different phone number.
              </p>
              <p className="bc-faint">“Read” is the least number who read it: some people turn read receipts off.</p>
            </section>
            {(r.failures.length > 0 || r.skipped.length > 0) && (
              <section className="card bc-card">
                <h3>Why some did not get it</h3>
                <div className="table-wrap">
                  <table className="table bc-table">
                    <thead>
                      <tr>
                        <th>Reason</th>
                        <th>People</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.failures.map((f) => (
                        <tr key={`f${f.code ?? "none"}`}>
                          <td>Failed: {f.plain}</td>
                          <td data-label="People" className="bc-num">
                            {groupThousands(f.count)}
                          </td>
                        </tr>
                      ))}
                      {r.skipped.map((s) => (
                        <tr key={`s${s.reason}`}>
                          <td>Left out: {s.plain}</td>
                          <td data-label="People" className="bc-num">
                            {groupThousands(s.count)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <People id={broadcastId} canExport={can("inbox.export")} />
            <section className="card bc-card">
              <h3>What happened</h3>
              {r.events.length === 0 ? (
                <p className="bc-soft">Nothing yet.</p>
              ) : (
                <ul className="bc-events">
                  {r.events.map((e, i) => (
                    <li key={i}>
                      <span>{eventLine(e)}</span>
                      <span className="bc-faint">{lagosWhen(e.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Frame>
  );
}
