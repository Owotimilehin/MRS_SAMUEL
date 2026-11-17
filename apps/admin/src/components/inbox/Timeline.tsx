import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Play, Download, FileText, Voicemail } from "lucide-react";
import { inboxApi } from "../../lib/inbox-api.js";
import { humanizeError } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import {
  callOutcomeLabel,
  formatDuration,
  groupTimelineByDay,
  mediaKind,
  messageTicks,
  timeOfDay,
} from "../../lib/inbox-logic.js";
import type { TimelineCall, TimelineItem, TimelineMessage, TimelineNote, TimelineRecording } from "../../lib/inbox-types.js";

/** Open a signed link in a new tab without tripping popup blockers. */
async function openSigned(getUrl: () => Promise<string>): Promise<void> {
  const w = window.open("", "_blank");
  try {
    const url = await getUrl();
    if (w) w.location.href = url;
    else window.location.href = url;
  } catch (err) {
    w?.close();
    toast.error(humanizeError(err));
  }
}

export function Timeline({ items, canDownload }: { items: TimelineItem[]; canDownload: boolean }): JSX.Element {
  const days = useMemo(() => groupTimelineByDay(items), [items]);
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);

  // Stay pinned to the newest message unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current || lastCount.current === 0) el.scrollTop = el.scrollHeight;
    lastCount.current = items.length;
  }, [items.length]);

  return (
    <div
      ref={ref}
      className="ibx-timeline"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {days.length === 0 && (
        <div style={{ margin: "auto", color: "var(--ink-soft)", fontSize: 14 }}>No messages yet.</div>
      )}
      {days.map((d) => (
        <div key={d.key} style={{ display: "contents" }}>
          <div className="ibx-day">{d.label}</div>
          {d.items.map((it) =>
            it.kind === "message" ? (
              <MessageBubble key={`m${it.data.id}`} m={it.data} />
            ) : it.kind === "call" ? (
              <CallCard key={`c${it.data.id}`} call={it.data} canDownload={canDownload} />
            ) : (
              <NoteCard key={`n${it.data.id}`} note={it.data} />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

function MessageBubble({ m }: { m: TimelineMessage }): JSX.Element {
  const failed = m.status === "failed";
  const ticks = messageTicks(m.status);
  return (
    <div className={`ibx-msg ibx-msg--${m.direction}${failed ? " ibx-msg--failed" : ""}`}>
      {m.direction === "out" && m.sender_name && (
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", marginBottom: 2 }}>{m.sender_name}</div>
      )}
      {m.template_name && (
        <div style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 2 }}>Template: {m.template_name}</div>
      )}
      {(m.has_media || m.media_pending) && <MessageMedia m={m} />}
      {m.body && <div>{m.body}</div>}
      {!m.body && !m.has_media && !m.media_pending && (
        <div style={{ color: "var(--ink-soft)", fontStyle: "italic" }}>
          {m.type === "reaction" ? "Reacted to a message" : m.type === "location" ? "📍 Shared a location" : `Unsupported message (${m.type})`}
        </div>
      )}
      {failed && <div className="ibx-msg__error">Not sent{m.error_message ? `: ${m.error_message}` : ""}</div>}
      <div className="ibx-msg__meta">
        <span>{timeOfDay(m.created_at)}</span>
        {m.direction === "out" && ticks.marks && (
          <span className={ticks.read ? "ibx-msg__ticks--read" : undefined} title={ticks.label} aria-label={ticks.label}>
            {ticks.marks}
          </span>
        )}
      </div>
    </div>
  );
}

function MessageMedia({ m }: { m: TimelineMessage }): JSX.Element {
  const kind = mediaKind(m.type, m.media_mime);
  const inline = kind !== "document" && m.has_media;
  const media = useQuery({
    queryKey: ["inbox", "media", m.id],
    queryFn: () => inboxApi.mediaUrl(m.id),
    enabled: inline,
    // Signed links last 10 minutes; refresh a little before that.
    staleTime: 8 * 60_000,
    gcTime: 9 * 60_000,
  });

  if (m.media_pending) {
    return <div style={{ fontSize: 13, color: "var(--ink-soft)", fontStyle: "italic" }}>Downloading {kind}…</div>;
  }
  if (kind === "document") {
    return (
      <button
        type="button"
        className="btn btn--subtle btn--sm"
        style={{ marginBottom: 4 }}
        onClick={() => void openSigned(async () => (await inboxApi.mediaUrl(m.id)).url)}
      >
        <FileText size={15} /> {m.media_filename ?? "Open document"}
      </button>
    );
  }
  if (media.isLoading) return <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>Loading {kind}…</div>;
  if (media.error || !media.data) {
    return (
      <button type="button" className="btn btn--subtle btn--sm" onClick={() => void media.refetch()}>
        Couldn't load {kind} — try again
      </button>
    );
  }
  const url = media.data.url;
  if (kind === "image") {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img className="ibx-media" src={url} alt={m.body ?? "Photo"} loading="lazy" onError={() => void media.refetch()} />
      </a>
    );
  }
  if (kind === "audio") return <audio controls preload="none" src={url} />;
  return <video controls preload="metadata" src={url} />;
}

function CallCard({ call, canDownload }: { call: TimelineCall; canDownload: boolean }): JSX.Element {
  const missed = call.outcome === "missed" || call.outcome === "after_hours" || call.outcome === "failed";
  const Icon = missed ? PhoneMissed : call.outcome === "voicemail" ? Voicemail : call.direction === "in" ? PhoneIncoming : PhoneOutgoing;
  return (
    <div className="ibx-call">
      <div className="ibx-call__row">
        <Icon size={16} color={missed ? "var(--danger)" : "var(--accent)"} aria-hidden />
        <strong>{call.direction === "in" ? "Incoming call" : "Outgoing call"}</strong>
        <span className={`pill ${missed ? "pill--danger" : call.outcome === "answered" ? "pill--success" : "pill--warning"}`}>
          {callOutcomeLabel(call.outcome, call.direction)}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-soft)" }}>{timeOfDay(call.started_at)}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>
        {call.duration_s ? `Lasted ${formatDuration(call.duration_s)}` : null}
        {call.answered_by ? `${call.duration_s ? " · " : ""}${call.direction === "in" ? "Answered" : "Made"} by ${call.answered_by}` : null}
        {call.ivr_choice ? ` · Pressed ${call.ivr_choice}` : null}
      </div>
      {call.recordings.map((r) => (
        <RecordingBlock key={r.id} rec={r} canDownload={canDownload} />
      ))}
    </div>
  );
}

function RecordingBlock({ rec, canDownload }: { rec: TimelineRecording; canDownload: boolean }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const label = rec.kind === "voicemail" ? "voicemail" : "recording";

  async function play(): Promise<void> {
    setLoading(true);
    try {
      setSrc(await inboxApi.recordingUrl(rec.id));
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <div className="ibx-call__row">
        {rec.playable ? (
          src ? (
            <audio controls autoPlay src={src} style={{ width: "100%", maxWidth: 360 }} onError={() => setSrc(null)} />
          ) : (
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => void play()} disabled={loading}>
              <Play size={14} /> {loading ? "Loading…" : `Play ${label}`} {rec.duration_s ? `(${formatDuration(rec.duration_s)})` : ""}
            </button>
          )
        ) : rec.status === "pending" ? (
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>The {label} is still being saved…</span>
        ) : rec.status === "failed" ? (
          <span style={{ fontSize: 12, color: "var(--danger-ink)" }}>The {label} couldn't be saved.</span>
        ) : null}
        {canDownload && rec.playable && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void openSigned(() => inboxApi.recordingUrl(rec.id, true))}
          >
            <Download size={14} /> Download
          </button>
        )}
      </div>
      {rec.summary && (
        <details>
          <summary>Call summary (AI)</summary>
          <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
            <div>{rec.summary.summary}</div>
            {rec.summary.call_reason && (
              <div>
                <strong>Reason:</strong> {rec.summary.call_reason}
              </div>
            )}
            {rec.summary.action_items?.length > 0 && (
              <div>
                <strong>To do:</strong>
                <ul style={{ margin: "2px 0 0 18px" }}>
                  {rec.summary.action_items.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {rec.summary.sentiment && (
              <div>
                <strong>Mood:</strong> {rec.summary.sentiment}
              </div>
            )}
          </div>
        </details>
      )}
      {rec.transcript && (
        <details>
          <summary>Transcript</summary>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 6, maxHeight: 240, overflowY: "auto" }}>{rec.transcript}</div>
        </details>
      )}
    </div>
  );
}

function NoteCard({ note }: { note: TimelineNote }): JSX.Element {
  return (
    <div className="ibx-note">
      <div className="ibx-note__tag">Internal note — not sent to the customer</div>
      <div>{note.body}</div>
      <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 4 }}>
        {note.author_name ?? "Staff"} · {timeOfDay(note.created_at)}
      </div>
    </div>
  );
}

/** Live "X is typing…" line under the timeline. */
export function TypingLine({ name }: { name: string | null }): JSX.Element {
  const [dots, setDots] = useState("");
  useEffect(() => {
    if (!name) return;
    const t = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 400);
    return () => clearInterval(t);
  }, [name]);
  return <div className="ibx-typing" aria-live="polite">{name ? `${name} is typing${dots}` : ""}</div>;
}
