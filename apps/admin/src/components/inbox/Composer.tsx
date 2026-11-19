import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Paperclip, MessageCircle, MessageSquareText, FileText, X, StickyNote, Clock } from "lucide-react";
import { waWindowRemainingMs } from "@ms/shared";
import { Modal } from "../Modal.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { humanizeError } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import {
  countTemplateParams,
  fillTemplate,
  humanTemplateName,
  languageName,
  sendTypeForMime,
  shouldSendTyping,
  templateBodyText,
  templateParamsComplete,
  windowText,
} from "../../lib/inbox-logic.js";
import type { ConversationDetail, InboxTemplate, QuickReply } from "../../lib/inbox-types.js";

interface Props {
  conv: ConversationDetail;
  can: (cap: string) => boolean;
  onSent: () => void;
}

/** Reply box: WhatsApp text/file/template, or an internal note. */
export function Composer({ conv, can, onSent }: Props): JSX.Element | null {
  const canReply = can("inbox.reply") && conv.can_use_number;
  const canNote = can("inbox.notes");
  // Replies go out on WhatsApp from a phone line; Messenger and Instagram replies arrive with spec 02.
  const phoneLine = (conv.number?.kind ?? "phone") === "phone";
  const waNumber = phoneLine && conv.number?.channels !== "voice";
  const [mode, setMode] = useState<"reply" | "note">(canReply && waNumber ? "reply" : "note");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastTyping = useRef<number | null>(null);

  // Recompute the 24h window every 30s so it closes on screen without a refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const remaining = conv.lastInboundWaAt ? waWindowRemainingMs(conv.lastInboundWaAt, new Date(now)) : 0;
  const win = windowText(remaining);

  // Reset the draft when switching conversations.
  useEffect(() => {
    setText("");
    setFile(null);
    setMode(canReply && waNumber ? "reply" : "note");
    lastTyping.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  if (!canReply && !canNote) return null;

  const replyMode = mode === "reply" && canReply && waNumber;
  const freeTextBlocked = replyMode && !win.open;

  function onType(v: string): void {
    setText(v);
    if (mode !== "reply" || !v) return;
    const t = Date.now();
    if (shouldSendTyping(lastTyping.current, t)) {
      lastTyping.current = t;
      void inboxApi.typing(conv.id).catch(() => undefined);
    }
  }

  async function send(): Promise<void> {
    const body = text.trim();
    if (busy) return;
    if (mode === "note") {
      if (!body) return;
      setBusy(true);
      try {
        await inboxApi.addNote(conv.id, body);
        setText("");
        onSent();
      } catch {
        /* api() already showed the error */
      } finally {
        setBusy(false);
      }
      return;
    }
    if (freeTextBlocked) return;
    if (!body && !file) return;
    setBusy(true);
    try {
      if (file) {
        const up = await inboxApi.upload(file);
        await inboxApi.sendMedia(conv.id, {
          type: sendTypeForMime(file.type || "application/octet-stream"),
          media_key: up.object_key,
          media_token: up.media_token,
          mime: file.type || "application/octet-stream",
          filename: file.name,
          ...(body ? { caption: body.slice(0, 1024) } : {}),
        });
        setFile(null);
      } else {
        await inboxApi.sendText(conv.id, body);
      }
      setText("");
      onSent();
    } catch (err) {
      // Upload errors (the raw PUT) don't go through api(); surface them here.
      if (!(err instanceof Error && err.name === "ApiError")) toast.error(humanizeError(err));
      onSent(); // a failed send still lands in the timeline in red
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends on a keyboard; on phones Enter is a new line (tap Send instead).
    const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !coarse) {
      e.preventDefault();
      void send();
    }
  }

  // Shown instead of the reply box once WhatsApp's 24-hour window has closed.
  const windowClosed = canReply && waNumber && !win.open;
  const closedNotice = (hidden: boolean): JSX.Element => (
        <div className="ibx-comp__closed" aria-hidden={hidden || undefined} style={hidden ? { visibility: "hidden" } : undefined}>
          <div className="ibx-comp__closed-text">
            It's more than 24 hours since the customer last wrote, so WhatsApp only accepts a template.{" "}
            {can("inbox.templates") ? "Send one to restart the chat." : "Ask a supervisor to send one."}
          </div>
          {can("inbox.templates") && (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowTemplates(true)}>
              Send a template
            </button>
          )}
        </div>
  );

  return (
    <div className={`ibx-comp${mode === "note" ? " ibx-comp--note" : ""}`}>
      <div className="ibx-comp__top">
        <div className="ibx-comp__modes" role="tablist" aria-label="Reply or note">
          {canReply && waNumber && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === "reply"}
              className={`ibx-tab${mode === "reply" ? " is-active" : ""}`}
              onClick={() => setMode("reply")}
            >
              <MessageCircle size={13} aria-hidden /> WhatsApp reply
            </button>
          )}
          {canNote && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === "note"}
              className={`ibx-tab${mode === "note" ? " is-active" : ""}`}
              onClick={() => setMode("note")}
            >
              <StickyNote size={13} aria-hidden /> Internal note
            </button>
          )}
        </div>
      </div>
      {/* One status line in both tabs, so the box is the same height whichever is open. */}
      <div className="ibx-comp__status">
        {mode === "note" ? (
          <span className="ibx-comp__hint">Only staff can see notes.</span>
        ) : replyMode ? (
          <span className={`ibx-comp__window ibx-comp__window--${win.open ? "open" : "closed"}`}>
            <Clock size={13} aria-hidden /> {win.open ? win.text : "Reply window closed"}
          </span>
        ) : null}
      </div>
      {phoneLine && !waNumber && mode === "reply" && (
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>This number is for calls only — WhatsApp replies aren't possible.</div>
      )}
      {!phoneLine && (
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Replies on this channel are not switched on yet.</div>
      )}
      {!conv.can_use_number && can("inbox.reply") && (
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>You don't have access to reply from {conv.number?.label ?? "this number"}.</div>
      )}

      {file && replyMode && (
        <div className="ibx-attach">
          <FileText size={14} aria-hidden />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)
          </span>
          <button type="button" className="btn btn--ghost btn--sm" aria-label="Remove file" onClick={() => setFile(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="ibx-comp__body">
      {/* Kept (invisibly) behind the note box too, so the box is the same height in both tabs. */}
      {windowClosed && !freeTextBlocked && closedNotice(true)}
      {freeTextBlocked && (
        <div className="ibx-comp__row" aria-hidden style={{ visibility: "hidden" }}>
          <textarea className="textarea" rows={2} tabIndex={-1} readOnly />
        </div>
      )}
      {freeTextBlocked ? (
        closedNotice(false)
      ) : (
        <div className="ibx-comp__row">
          {replyMode && (
            <>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/*,audio/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setFile(f);
                  e.target.value = "";
                }}
              />
              <button type="button" className="btn btn--ghost btn--sm" aria-label="Attach a file" title="Attach a file" onClick={() => fileRef.current?.click()}>
                <Paperclip size={16} />
              </button>
              <button type="button" className="btn btn--ghost btn--sm" aria-label="Quick replies" title="Quick replies" onClick={() => setShowQuick(true)}>
                <MessageSquareText size={16} />
              </button>
              {can("inbox.templates") && (
                <button type="button" className="btn btn--ghost btn--sm" title="Send a template" onClick={() => setShowTemplates(true)}>
                  <FileText size={16} />
                </button>
              )}
            </>
          )}
          <textarea
            className="textarea"
            rows={2}
            placeholder={mode === "note" ? "Write a note only staff can see…" : file ? "Add a caption (optional)…" : "Type a reply…"}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKey}
            aria-label={mode === "note" ? "Internal note" : "Reply"}
            maxLength={mode === "note" ? 4000 : file ? 1024 : 4096}
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy || (!text.trim() && !(file && replyMode))}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : mode === "note" ? "Add note" : "Send"}
          </button>
        </div>
      )}
      </div>

      {showQuick && (
        <QuickReplyPicker
          onClose={() => setShowQuick(false)}
          onPick={(qr) => {
            setText((t) => (t ? `${t}\n${qr.body}` : qr.body));
            setShowQuick(false);
          }}
        />
      )}
      {showTemplates && (
        <TemplatePicker
          conv={conv}
          onClose={() => setShowTemplates(false)}
          onSent={() => {
            setShowTemplates(false);
            onSent();
          }}
        />
      )}
    </div>
  );
}

function QuickReplyPicker({ onPick, onClose }: { onPick: (q: QuickReply) => void; onClose: () => void }): JSX.Element {
  const q = useQuery({ queryKey: inboxKeys.quickReplies, queryFn: inboxApi.quickReplies, staleTime: 5 * 60_000 });
  const [filter, setFilter] = useState("");
  const rows = (q.data ?? []).filter(
    (r) => !filter || `${r.title} ${r.body}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Modal title="Quick replies" onClose={onClose}>
      <input className="input" placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 10 }} />
      {q.isLoading ? (
        <div>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No quick replies</div>
          An admin can add them in Inbox settings.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className="card card--hoverable"
              style={{ textAlign: "left", padding: 10, cursor: "pointer" }}
              onClick={() => onPick(r)}
            >
              <div style={{ fontWeight: 700 }}>{r.title}</div>
              <div style={{ fontSize: 13, color: "var(--ink-soft)", whiteSpace: "pre-wrap" }}>{r.body.slice(0, 200)}</div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function TemplatePicker({ conv, onClose, onSent }: { conv: ConversationDetail; onClose: () => void; onSent: () => void }): JSX.Element {
  const q = useQuery({ queryKey: inboxKeys.templates, queryFn: inboxApi.templates, staleTime: 5 * 60_000 });
  const approved = (q.data ?? []).filter((t) => t.status.toUpperCase() === "APPROVED");
  const [pick, setPick] = useState<InboxTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const count = pick ? Math.max(pick.param_count, countTemplateParams(pick.components)) : 0;
  const body = pick ? templateBodyText(pick.components) : null;

  function choose(t: InboxTemplate): void {
    setPick(t);
    const n = Math.max(t.param_count, countTemplateParams(t.components));
    // Pre-fill {{1}} with the customer's first name — the usual greeting slot.
    const first = conv.customer?.name?.trim().split(/\s+/)[0] ?? "";
    setParams(Array.from({ length: n }, (_, i) => (i === 0 ? first : "")));
  }

  async function send(): Promise<void> {
    if (!pick) return;
    setBusy(true);
    try {
      await inboxApi.sendTemplate(conv.id, { name: pick.name, language: pick.language, params: params.slice(0, count) });
      onSent();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Send a template" onClose={onClose} maxWidth={560}>
      {q.isLoading ? (
        <div>Loading…</div>
      ) : approved.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No approved templates</div>
          Templates are created in WhatsApp Manager, then synced in Inbox settings.
        </div>
      ) : !pick ? (
        <div style={{ display: "grid", gap: 6 }}>
          {approved.map((t) => (
            <button
              key={t.id}
              type="button"
              className="card card--hoverable"
              style={{ textAlign: "left", padding: 10, cursor: "pointer" }}
              onClick={() => choose(t)}
            >
              <div style={{ fontWeight: 700 }}>
                {humanTemplateName(t.name)} <span className="pill" style={{ fontSize: 10 }}>{languageName(t.language)}</span>
              </div>
              <div className="ibx-raw">{t.name}</div>
              <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{(templateBodyText(t.components) ?? "").slice(0, 160)}</div>
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <button type="button" className="btn btn--ghost btn--sm" style={{ justifySelf: "start" }} onClick={() => setPick(null)}>
            ← Pick another
          </button>
          {params.slice(0, count).map((v, i) => (
            <label key={i} className="field">
              <span className="field__label">Fill in {`{{${i + 1}}}`}</span>
              <input
                className="input"
                value={v}
                maxLength={1024}
                onChange={(e) => setParams((ps) => ps.map((p, j) => (j === i ? e.target.value : p)))}
              />
            </label>
          ))}
          <div className="card card--soft" style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>
            <div className="t-eyebrow" style={{ marginBottom: 4 }}>Preview</div>
            {body ? fillTemplate(body, params) : `Template "${pick.name}"`}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !templateParamsComplete(params, count)}
              onClick={() => void send()}
            >
              {busy ? "Sending…" : "Send template"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
