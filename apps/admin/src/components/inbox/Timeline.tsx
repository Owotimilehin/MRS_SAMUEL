import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, PhoneIncoming, PhoneOutgoing, PhoneMissed, Play, Download, FileText, Trash2, Voicemail, ShoppingBag } from "lucide-react";
import { ConfirmModal } from "../ConfirmModal.js";
import { FlowResponseCardView, FlowSentRow } from "./FlowCards.js";
import { inboxApi } from "../../lib/inbox-api.js";
import { useCallsHref, useCommentHref } from "../../lib/app-frame.js";
import { humanizeError } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import {
  autoMessageLabel,
  callOutcomeLabel,
  formatDuration,
  groupTimelineByDay,
  humanTemplateName,
  mediaKind,
  messageTicks,
  sendProblem,
  staffLabel,
  timelineKey,
  timeOfDay,
  UNCONFIRMED_TEXT,
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

interface TimelineProps {
  items: TimelineItem[];
  canDownload: boolean;
  /** May permanently delete call recordings. */
  canDeleteRecordings: boolean;
  /** There are older items on the server than the oldest one shown. */
  hasMore: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** Something in the timeline changed on the server (e.g. a recording was deleted). */
  onChanged: () => void;
  /** May act on a form answer (inbox.reply). Without it the card shows no buttons. */
  canReply?: boolean;
  /** May copy a form answer to the notes (inbox.notes). */
  canNote?: boolean;
}

export function Timeline({
  items,
  canDownload,
  canDeleteRecordings,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  onChanged,
  canReply = false,
  canNote = false,
}: TimelineProps): JSX.Element {
  // In the suite calls have their own section (Calls), so the chat shows messages and notes only.
  const callsSeparate = useCallsHref() !== null;
  const days = useMemo(
    () => groupTimelineByDay(callsSeparate ? items.filter((it) => it.kind !== "call") : items),
    [items, callsSeparate],
  );
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);
  const lastFirst = useRef<string | null>(null);
  const firstKey = items[0] ? timelineKey(items[0]) : null;

  // Stay pinned to the newest message unless the person scrolled up to read.
  // When older messages are added on top, keep what they were reading in place:
  // the content above grew, so move the scroll down by exactly that much.
  const heightBefore = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prepended = lastCount.current > 0 && firstKey !== lastFirst.current && items.length > lastCount.current;
    if (prepended && !stick.current) {
      el.scrollTop += el.scrollHeight - heightBefore.current;
    } else if (stick.current || lastCount.current === 0) {
      el.scrollTop = el.scrollHeight;
    }
    lastCount.current = items.length;
    lastFirst.current = firstKey;
    heightBefore.current = el.scrollHeight;
  }, [items.length, firstKey]);

  return (
    <div
      ref={ref}
      className="ibx-timeline"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        heightBefore.current = el.scrollHeight;
      }}
    >
      {hasMore && (
        <button
          type="button"
          className="btn btn--subtle btn--sm ibx-earlier"
          disabled={loadingEarlier}
          onClick={() => {
            // Reading history: don't jump to the newest message when it loads.
            const el = ref.current;
            if (el) {
              stick.current = false;
              heightBefore.current = el.scrollHeight;
            }
            onLoadEarlier();
          }}
        >
          {loadingEarlier ? "Loading…" : "Load earlier messages"}
        </button>
      )}
      {days.length === 0 && (
        <div style={{ margin: "auto", color: "var(--ink-soft)", fontSize: 14 }}>No messages yet.</div>
      )}
      {days.map((d) => (
        <div key={d.key} style={{ display: "contents" }}>
          <div className="ibx-day">{d.label}</div>
          {d.items.map((it) =>
            it.kind === "message" && it.data.direction === "in" && it.data.flow_response ? (
              <FlowResponseCardView
                key={`m${it.data.id}`}
                response={it.data.flow_response}
                at={it.data.created_at}
                canReply={canReply}
                canNote={canNote}
                onChanged={onChanged}
              />
            ) : it.kind === "message" ? (
              <MessageBubble key={`m${it.data.id}`} m={it.data} />
            ) : it.kind === "call" ? (
              <CallCard
                key={`c${it.data.id}`}
                call={it.data}
                canDownload={canDownload}
                canDelete={canDeleteRecordings}
                onChanged={onChanged}
              />
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
  // Messenger and Instagram rows have their own rendering (spec 02, 7.4); WhatsApp is unchanged.
  if (m.channel === "messenger" || m.channel === "instagram") return <MetaMessageBubble m={m} />;
  const problem = sendProblem(m);
  const ticks =
    problem === "unconfirmed" ? { marks: "?", read: false, label: "Not confirmed" } : messageTicks(m.status);
  // A form we sent (spec 07): the button and the form's name go under the text.
  const flowSent = m.direction === "out" && m.flow_sent ? m.flow_sent : null;
  return (
    <div className={`ibx-msg ibx-msg--${m.direction}${problem ? ` ibx-msg--${problem}` : ""}`}>
      {m.direction === "out" && m.sender_name && (
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", marginBottom: 2 }}>{staffLabel(m.sender_name)}</div>
      )}
      {m.direction === "out" && !m.sender_name && autoMessageLabel(m.auto) && (
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-soft)", marginBottom: 2 }}>{autoMessageLabel(m.auto)}</div>
      )}
      {m.template_name && (
        <div style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 2 }}>Template: {humanTemplateName(m.template_name)}</div>
      )}
      {(m.has_media || m.media_pending) && <MessageMedia m={m} />}
      {/* A filled-in lead form (suite spec 13): a normal incoming bubble, marked so it is not taken for a WhatsApp message. */}
      {m.type === "lead" && (
        <div className="ibx-msg__sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ClipboardList size={12} aria-hidden /> Lead form
        </div>
      )}
      {m.body && (
        <div>
          {/* A cart sent from the catalogue (suite spec 08). */}
          {m.type === "order" && <ShoppingBag size={13} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />}
          {m.body}
        </div>
      )}
      {!m.body && !m.has_media && !m.media_pending && !flowSent && (
        <div style={{ color: "var(--ink-soft)", fontStyle: "italic" }}>
          {m.type === "reaction" ? "Reacted to a message" : m.type === "location" ? "📍 Shared a location" : `Unsupported message (${m.type})`}
        </div>
      )}
      {flowSent && <FlowSentRow flow={flowSent} />}
      {problem === "failed" && <div className="ibx-msg__error">Not sent{m.error_message ? `: ${m.error_message}` : ""}</div>}
      {problem === "unconfirmed" && <div className="ibx-msg__warn">{UNCONFIRMED_TEXT}</div>}
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

/** Above a message that was sent as the private reply to a comment (suite spec 03): which comment. */
function CommentRefLine({ commentRef }: { commentRef: NonNullable<TimelineMessage["comment_ref"]> }): JSX.Element {
  const href = useCommentHref();
  const excerpt = commentRef.excerpt?.trim();
  const text = `Private reply to a comment${excerpt ? `: “${excerpt}”` : ""}`;
  return (
    <div className="ibx-msg__caption" style={{ marginTop: 0, marginBottom: 2 }}>
      {href && commentRef.thread_id ? <a href={href(commentRef.thread_id)}>{text}</a> : text}
    </div>
  );
}

/** A Messenger or Instagram message (spec 02, table 7.4). */
function MetaMessageBubble({ m }: { m: TimelineMessage }): JSX.Element {
  // Where the customer came from: a quiet centred line, not a bubble.
  if (m.type === "referral") return <div className="ibx-system-line">{m.body}</div>;
  const channel = m.channel === "instagram" ? "instagram" : "messenger";
  const problem = sendProblem(m);
  const ticks =
    problem === "unconfirmed" ? { marks: "?", read: false, label: "Not confirmed" } : messageTicks(m.status, channel);
  const showMedia = !m.deleted && (m.has_media || m.media_pending);
  return (
    <div className={`ibx-msg ibx-msg--${m.direction}${problem ? ` ibx-msg--${problem}` : ""}`}>
      {m.comment_ref && <CommentRefLine commentRef={m.comment_ref} />}
      {m.direction === "out" && m.external_sender && <div className="ibx-msg__sub">Sent from the Facebook or Instagram app</div>}
      {m.direction === "out" && !m.external_sender && m.sender_name && (
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", marginBottom: 2 }}>{staffLabel(m.sender_name)}</div>
      )}
      {m.story_reply && !m.deleted && <div className="ibx-msg__sub">Replied to your story</div>}
      {m.deleted ? (
        <div className="ibx-msg__deleted">The customer deleted this message.</div>
      ) : m.type === "story_mention" ? (
        <div>
          Mentioned you in their story.{" "}
          {m.link ? (
            <a href={m.link} target="_blank" rel="noreferrer">
              View story
            </a>
          ) : (
            <span className="ibx-msg__deleted" style={{ fontStyle: "normal" }}>
              The story is no longer available.
            </span>
          )}
          <div className="ibx-msg__caption">Stories disappear after 24 hours.</div>
        </div>
      ) : (
        <>
          {showMedia && <MessageMedia m={m} />}
          {m.type === "interactive" && m.body && !m.tap_caption ? (
            <div>
              <span className="ibx-msg__deleted" style={{ fontStyle: "normal" }}>Tapped: </span>
              {m.body}
            </div>
          ) : (
            m.body && <div>{m.body}</div>
          )}
          {m.type === "share" && m.link && (
            <a href={m.link} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          {m.tap_caption && <div className="ibx-msg__caption">{m.tap_caption}</div>}
          {!m.body && !m.has_media && !m.media_pending && m.type !== "share" && (
            <div style={{ color: "var(--ink-soft)", fontStyle: "italic" }}>{m.type === "reaction" ? "Reacted to a message" : "Message"}</div>
          )}
        </>
      )}
      {m.advert && <span className="ibx-msg__advert">From an advert: {m.advert}</span>}
      {problem === "failed" && <div className="ibx-msg__error">Not sent{m.error_message ? `: ${m.error_message}` : ""}</div>}
      {problem === "unconfirmed" && <div className="ibx-msg__warn">{UNCONFIRMED_TEXT}</div>}
      <div className="ibx-msg__meta">
        <span>{timeOfDay(m.created_at)}</span>
        {m.edited && !m.deleted && <span>Edited</span>}
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

function CallCard({
  call,
  canDownload,
  canDelete,
  onChanged,
}: {
  call: TimelineCall;
  canDownload: boolean;
  canDelete: boolean;
  onChanged: () => void;
}): JSX.Element {
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
        <RecordingBlock key={r.id} rec={r} canDownload={canDownload} canDelete={canDelete} onChanged={onChanged} />
      ))}
    </div>
  );
}

export function RecordingBlock({
  rec,
  canDownload,
  canDelete,
  onChanged,
}: {
  rec: TimelineRecording;
  canDownload: boolean;
  canDelete: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const label = rec.kind === "voicemail" ? "voicemail" : "recording";

  async function remove(): Promise<void> {
    setDeleting(true);
    try {
      await inboxApi.deleteRecording(rec.id);
      setSrc(null);
      setConfirming(false);
      toast.success(`The ${label} was deleted.`);
      onChanged();
    } catch {
      /* toast shown by api() */
    } finally {
      setDeleting(false);
    }
  }

  if (rec.status === "deleted") {
    return (
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)", fontStyle: "italic" }}>
        {rec.kind === "voicemail" ? "Voicemail deleted" : "Recording deleted"}
      </div>
    );
  }

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
        {canDelete && rec.status !== "pending" && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(true)}>
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmModal
          title={`Delete this ${label}?`}
          confirmLabel={`Delete ${label}`}
          busyLabel="Deleting…"
          tone="danger"
          busy={deleting}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove()}
        >
          <p style={{ margin: 0 }}>This permanently deletes the audio, transcript and summary.</p>
          <p style={{ margin: "8px 0 0", color: "var(--ink-soft)", fontSize: 13 }}>
            The call itself stays in the chat history. This can't be undone.
          </p>
        </ConfirmModal>
      )}
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
      <div className="ibx-note__tag">Internal note · not sent to the customer</div>
      <div>{note.body}</div>
      <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 4 }}>
        {staffLabel(note.author_name)} · {timeOfDay(note.created_at)}
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
