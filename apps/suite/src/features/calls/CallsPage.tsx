/**
 * Calls: every phone call in and out, newest first, with filters. Each call
 * can be opened to play its recording or voicemail, read the AI summary and
 * transcript, and jump to the customer's chat. Calls still show in the chat's
 * timeline too; this page is the same calls in one list.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, MessagesSquare, PhoneIncoming, PhoneMissed, PhoneOutgoing, Voicemail } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { RecordingBlock } from "@admin/components/inbox/Timeline.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";
import { formatDuration } from "@admin/lib/inbox-logic.js";
import { useInboxEvents } from "@admin/lib/inbox-stream.js";
import "@admin/components/inbox/inbox.css";
import "./calls.css";
import { callKeys, callsApi, type CallFilters, type CallOutcome, type CallRow } from "./calls-api.js";
import {
  OUTCOME_OPTIONS,
  callerName,
  countLine,
  customerNumber,
  emptyText,
  filtersProblem,
  isFiltered,
  lagosWhen,
  outcomeLabel,
  outcomeTone,
  staffLine,
} from "./calls-logic.js";

export function CallsPage(): JSX.Element {
  const can = useCan();
  if (!can("inbox.view")) {
    return (
      <Frame title="Calls">
        <div className="card">You don&apos;t have access to calls. Ask the owner.</div>
      </Frame>
    );
  }
  return <CallsList />;
}

function CallsList(): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const [filters, setFilters] = useState<CallFilters>({});
  const [open, setOpen] = useState<string | null>(null);
  const set = <K extends keyof CallFilters>(k: K, v: CallFilters[K] | ""): void =>
    setFilters((f) => {
      const next = { ...f };
      if (v) next[k] = v as CallFilters[K];
      else delete next[k];
      return next;
    });

  const problem = filtersProblem(filters);
  const list = useInfiniteQuery({
    queryKey: callKeys.list(filters),
    queryFn: ({ pageParam }) => callsApi.list(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    enabled: !problem,
    refetchInterval: 60_000,
  });
  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, staleTime: 60_000 });
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff, staleTime: 5 * 60_000 });
  const configured = useQuery({ queryKey: callKeys.voiceStatus, queryFn: callsApi.voiceConfigured, staleTime: 5 * 60_000, retry: false });

  // A call starting, being answered or ending refreshes the list.
  useInboxEvents((e) => {
    if (e.event === "call.updated" || e.event === "reconnected") void qc.invalidateQueries({ queryKey: callKeys.all });
  });

  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const callNumbers = (me.data?.numbers ?? []).filter((n) => (n.kind ?? "phone") === "phone" && n.channels !== "whatsapp");
  const filtered = isFiltered(filters);

  return (
    <Frame title="Calls">
      <p className="cl-sub">Every phone call in and out. Times are Lagos time. Calls also show in each customer&apos;s chat.</p>

      <div className="cl-filters">
        <label className="field">
          <span className="field__label">From</span>
          <input className="input" type="date" value={filters.from ?? ""} max={filters.to || undefined} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">To</span>
          <input className="input" type="date" value={filters.to ?? ""} min={filters.from || undefined} onChange={(e) => set("to", e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Business number</span>
          <select className="select" value={filters.number ?? ""} onChange={(e) => set("number", e.target.value)}>
            <option value="">All numbers</option>
            {callNumbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Staff</span>
          <select className="select" value={filters.staff ?? ""} onChange={(e) => set("staff", e.target.value)}>
            <option value="">Anyone</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Outcome</span>
          <select className="select" value={filters.outcome ?? ""} onChange={(e) => set("outcome", e.target.value as CallOutcome | "")}>
            <option value="">Any outcome</option>
            {OUTCOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Direction</span>
          <select className="select" value={filters.direction ?? ""} onChange={(e) => set("direction", e.target.value as "in" | "out" | "")}>
            <option value="">In and out</option>
            <option value="in">Incoming</option>
            <option value="out">Outgoing</option>
          </select>
        </label>
        {filtered && (
          <button type="button" className="btn btn--ghost btn--sm cl-clear" onClick={() => setFilters({})}>
            Clear filters
          </button>
        )}
      </div>

      {problem ? (
        <div className="empty">{problem}</div>
      ) : list.error && !list.isLoading ? (
        <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
          <div>We couldn&apos;t load the calls. Check your connection and try again.</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void list.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <DataState loading={list.isLoading} error={null} onRetry={() => void list.refetch()}>
          {rows.length === 0 ? (
            <div className="empty">{emptyText({ configured: configured.data ?? null, filtered })}</div>
          ) : (
            <>
              <div className="cl-count">{countLine(rows.length, !!list.hasNextPage)}</div>
              <div className="cl-list">
                {rows.map((c) => (
                  <CallRowCard
                    key={c.id}
                    call={c}
                    open={open === c.id}
                    onToggle={() => setOpen((o) => (o === c.id ? null : c.id))}
                    canDownload={can("recordings.download")}
                    canDelete={can("recordings.delete")}
                    onChanged={() => void qc.invalidateQueries({ queryKey: callKeys.all })}
                  />
                ))}
              </div>
              {list.hasNextPage && (
                <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                  <button type="button" className="btn btn--subtle btn--sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {list.isFetchingNextPage ? "Loading…" : "Show older calls"}
                  </button>
                </div>
              )}
            </>
          )}
        </DataState>
      )}
    </Frame>
  );
}

function CallRowCard({
  call,
  open,
  onToggle,
  canDownload,
  canDelete,
  onChanged,
}: {
  call: CallRow;
  open: boolean;
  onToggle: () => void;
  canDownload: boolean;
  canDelete: boolean;
  onChanged: () => void;
}): JSX.Element {
  const tone = outcomeTone(call.outcome);
  const Icon =
    tone === "danger" ? PhoneMissed : call.outcome === "voicemail" ? Voicemail : call.direction === "in" ? PhoneIncoming : PhoneOutgoing;
  const who = staffLine(call);
  const name = callerName(call);
  const number = customerNumber(call);
  const hasRecording = call.recordings.some((r) => r.status !== "deleted");
  const hasSummary = call.recordings.some((r) => r.summary || r.transcript);
  const detailsId = `call-${call.id}`;
  return (
    <div className="card cl-row">
      <button type="button" className="cl-row__main" aria-expanded={open} aria-controls={detailsId} onClick={onToggle}>
        <Icon size={18} aria-hidden className={`cl-row__icon cl-row__icon--${tone}`} />
        <span className="cl-row__who">
          <span className="cl-row__name">{name}</span>
          <span className="cl-row__sub">
            {name !== number && number ? `${number} · ` : ""}
            {call.direction === "in" ? "Incoming" : "Outgoing"} · {call.number_label}
          </span>
          <span className="cl-row__sub">
            {[who, call.duration_s ? formatDuration(call.duration_s) : null, call.ivr_choice ? `Pressed ${call.ivr_choice}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className="cl-row__side">
          <span>{lagosWhen(call.started_at)}</span>
          <span className="cl-row__tags">
            {hasRecording && <span className="ibx-chip">{call.recordings.some((r) => r.kind === "voicemail") ? "Voicemail" : "Recording"}</span>}
            {hasSummary && <span className="ibx-chip">Summary</span>}
            <span className={`pill pill--${tone}`}>{outcomeLabel(call.outcome, call.direction)}</span>
            {open ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
          </span>
        </span>
      </button>
      {open && (
        <div className="cl-row__details" id={detailsId}>
          {call.recordings.length === 0 ? (
            <div className="cl-fine">No recording for this call.</div>
          ) : (
            call.recordings.map((r) => (
              <RecordingBlock key={r.id} rec={r} canDownload={canDownload} canDelete={canDelete} onChanged={onChanged} />
            ))
          )}
          <div>
            <Link to="/inbox/$conversationId" params={{ conversationId: call.conversation_id }} className="btn btn--subtle btn--sm">
              <MessagesSquare size={14} aria-hidden /> Open the chat
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
