import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Paperclip, MessageSquareText, FileText, X, StickyNote, Clock, ClipboardList, ShoppingBag } from "lucide-react";
import { headerMediaLabel, humanAgentRemainingMs, templateNeeds, uploadProblem, waWindowRemainingMs } from "@ms/shared";
import { ChannelIcon } from "./ChannelIcon.js";
import { ProductPicker } from "./ProductPicker.js";
import { Modal } from "../Modal.js";
import { FlowPicker, FLOW_WINDOW_HINT } from "./FlowPicker.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { humanizeError } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import {
  addHeaderFileLabel,
  channelName,
  fillButtonUrl,
  fillTemplate,
  headerFileProblem,
  headerFileRule,
  humanTemplateName,
  replyState,
  textUsage,
  languageName,
  sendTypeForMime,
  shouldSendTyping,
  templateBodyText,
  templateDraftProblem,
  windowText,
} from "../../lib/inbox-logic.js";
import type { ConversationDetail, InboxTemplate, QuickReply } from "../../lib/inbox-types.js";

interface Props {
  conv: ConversationDetail;
  can: (cap: string) => boolean;
  onSent: () => void;
}

/**
 * Reply box: WhatsApp text/file/template, a Messenger or Instagram reply
 * (spec 02: no templates, no captions, the channel's own limits), or an
 * internal note.
 */
export function Composer({ conv, can, onSent }: Props): JSX.Element | null {
  const canReply = can("inbox.reply") && conv.can_use_number;
  const canNote = can("inbox.notes");
  // WhatsApp replies go out from a phone line; Messenger and Instagram from their Page.
  const phoneLine = (conv.number?.kind ?? "phone") === "phone";
  const waNumber = phoneLine && conv.number?.channels !== "voice";
  const metaLine = !phoneLine && (conv.channel === "messenger" || conv.channel === "instagram");
  const replyLine = waNumber || metaLine;
  const [mode, setMode] = useState<"reply" | "note">(canReply && replyLine ? "reply" : "note");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showFlows, setShowFlows] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  // Products (suite spec 08): WhatsApp only, and only once a catalogue is connected to it.
  const sendable = useQuery({
    queryKey: inboxKeys.catalogueSendable,
    queryFn: inboxApi.catalogueSendable,
    enabled: canReply && waNumber && (conv.channel ?? "whatsapp") === "whatsapp",
    staleTime: 60_000,
    retry: false,
  });
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
  const rs = replyState({
    ...(conv.channel ? { channel: conv.channel } : {}),
    number: conv.number,
    window_remaining_ms: remaining,
    human_agent_remaining_ms: conv.human_agent_enabled && conv.lastInboundWaAt ? humanAgentRemainingMs(conv.lastInboundWaAt, new Date(now)) : 0,
    human_agent_enabled: conv.human_agent_enabled === true,
  });
  const name = channelName(rs.channel);

  // Forms (spec 07) are WhatsApp-only; the button appears once the server lists at least one.
  const flowsQ = useQuery({
    queryKey: inboxKeys.flowsFor(conv.id),
    queryFn: () => inboxApi.flows(conv.id),
    enabled: canReply && waNumber && !metaLine,
    staleTime: 60_000,
  });
  const flows = flowsQ.data ?? [];
  const canSendForm = canReply && waNumber && !metaLine && flows.length > 0;

  // Reset the draft when switching conversations.
  useEffect(() => {
    setText("");
    setFile(null);
    setFileProblem(null);
    setMode(canReply && replyLine ? "reply" : "note");
    setShowFlows(false);
    lastTyping.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  if (!canReply && !canNote) return null;

  const replyMode = mode === "reply" && canReply && replyLine;
  // WhatsApp: outside 24 h only a template. Messenger/Instagram: closed (or switched off) means no reply at all.
  const freeTextBlocked = replyMode && (metaLine ? rs.mode === "closed" || rs.mode === "off" : !win.open);
  const usage = textUsage(text, rs.textLimit);
  const tooLong = replyMode && metaLine && usage.over;

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
    if (freeTextBlocked || tooLong) return;
    if (!body && !file) return;
    setBusy(true);
    try {
      if (file && metaLine) {
        // No captions on Messenger/Instagram: the file first, then the text as its own message.
        const up = await inboxApi.upload(file, conv.id);
        await inboxApi.sendMedia(conv.id, {
          type: sendTypeForMime(file.type || "application/octet-stream"),
          media_key: up.object_key,
          media_token: up.media_token,
          mime: file.type || "application/octet-stream",
          filename: file.name,
        });
        setFile(null);
        if (body) await inboxApi.sendText(conv.id, body);
      } else if (file) {
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

  // Shown instead of the reply box once the reply window has closed.
  const windowClosed = canReply && (waNumber ? !win.open : metaLine && (rs.mode === "closed" || rs.mode === "off"));
  const closedNotice = (hidden: boolean): JSX.Element =>
    metaLine ? (
      <MetaClosedNotice conv={conv} hidden={hidden} rsMode={rs.mode} statusText={rs.statusText} name={name} closedWindow={rs.closedWindow} canNote={canNote} onNote={() => setMode("note")} />
    ) : (
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
          {canSendForm && (
            <>
              <button type="button" className="btn btn--subtle btn--sm" disabled title={FLOW_WINDOW_HINT}>
                <ClipboardList size={14} aria-hidden /> Send a form
              </button>
              <div style={{ flexBasis: "100%", fontSize: 12, color: "var(--ink-soft)" }}>
                {FLOW_WINDOW_HINT}
              </div>
            </>
          )}
        </div>
  );

  return (
    <div className={`ibx-comp${mode === "note" ? " ibx-comp--note" : ""}`}>
      <div className="ibx-comp__top">
        <div className="ibx-comp__modes" role="tablist" aria-label="Reply or note">
          {canReply && replyLine && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === "reply"}
              className={`ibx-tab${mode === "reply" ? " is-active" : ""}`}
              onClick={() => setMode("reply")}
            >
              <ChannelIcon channel={rs.channel} size={13} /> {rs.tabLabel}
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
        ) : replyMode && metaLine ? (
          <span className={`ibx-comp__window ibx-comp__window--${rs.mode === "open" ? "open" : "closed"}`} style={rs.mode === "human_agent" ? { color: "#92400E" } : undefined}>
            <Clock size={13} aria-hidden /> {rs.mode === "off" ? "Replies switched off" : rs.statusText}
          </span>
        ) : replyMode ? (
          <span className={`ibx-comp__window ibx-comp__window--${win.open ? "open" : "closed"}`}>
            <Clock size={13} aria-hidden /> {win.open ? win.text : "Reply window closed"}
          </span>
        ) : null}
      </div>
      {mode === "reply" && metaLine && rs.banner && (
        <div className="ibx-composer__banner" role="alert">
          {rs.banner}
        </div>
      )}
      {phoneLine && !waNumber && mode === "reply" && (
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>This number is for calls only — WhatsApp replies aren't possible.</div>
      )}
      {!phoneLine && !metaLine && (
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
                accept={rs.accept}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  // Messenger/Instagram: check the channel's rules before any upload.
                  const problem = metaLine ? uploadProblem(rs.channel, { type: f.type || "application/octet-stream", size: f.size }) : null;
                  setFileProblem(problem);
                  if (!problem) setFile(f);
                }}
              />
              <button type="button" className="btn btn--ghost btn--sm" aria-label="Attach a file" title="Attach a file" onClick={() => fileRef.current?.click()}>
                <Paperclip size={16} />
              </button>
              <button type="button" className="btn btn--ghost btn--sm" aria-label="Quick replies" title="Quick replies" onClick={() => setShowQuick(true)}>
                <MessageSquareText size={16} />
              </button>
              {can("inbox.templates") && rs.canTemplate && (
                <button type="button" className="btn btn--ghost btn--sm" title="Send a template" onClick={() => setShowTemplates(true)}>
                  <FileText size={16} />
                </button>
              )}
              {canSendForm && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label="Send a form"
                  title={win.open ? "Send a form" : FLOW_WINDOW_HINT}
                  disabled={!win.open}
                  onClick={() => setShowFlows(true)}
                >
                  <ClipboardList size={16} />
                </button>
              )}
              {!metaLine && sendable.data?.catalog_id && (
                <button type="button" className="btn btn--ghost btn--sm" aria-label="Send products" title="Send products" onClick={() => setShowProducts(true)}>
                  <ShoppingBag size={16} />
                </button>
              )}
            </>
          )}
          <textarea
            className="textarea"
            rows={2}
            placeholder={
              mode === "note"
                ? "Write a note only staff can see…"
                : file
                  ? rs.canCaption
                    ? "Add a caption (optional)…"
                    : "Add a message (sent separately)…"
                  : "Type a reply…"
            }
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKey}
            aria-label={mode === "note" ? "Internal note" : "Reply"}
            maxLength={mode === "note" ? 4000 : metaLine ? (rs.channel === "messenger" ? 1999 : undefined) : file ? 1024 : 4096}
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy || tooLong || (!text.trim() && !(file && replyMode))}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : mode === "note" ? "Add note" : "Send"}
          </button>
        </div>
      )}
      </div>
      {replyMode && fileProblem && <div className="ibx-composer__problem" role="alert">{fileProblem}</div>}
      {replyMode && metaLine && rs.textLimit.unit === "bytes" && usage.used >= 800 && (
        <div className={`ibx-composer__count${usage.over ? " is-over" : ""}`} aria-live="polite">
          {usage.used} / {rs.textLimit.max}
          {usage.over ? ` · Too long for ${name}. Shorten it or send it in two parts.` : ""}
        </div>
      )}

      {showQuick && (
        <QuickReplyPicker
          onClose={() => setShowQuick(false)}
          onPick={(qr) => {
            setText((t) => (t ? `${t}\n${qr.body}` : qr.body));
            setShowQuick(false);
          }}
        />
      )}
      {showFlows && canSendForm && win.open && (
        <FlowPicker
          conversationId={conv.id}
          flows={flows}
          canTest={can("templates.manage")}
          onClose={() => setShowFlows(false)}
          onSent={() => {
            setShowFlows(false);
            onSent();
          }}
        />
      )}
      {showProducts && !metaLine && (
        <ProductPicker
          conv={conv}
          onClose={() => setShowProducts(false)}
          onSent={() => {
            setShowProducts(false);
            onSent();
          }}
        />
      )}
      {/* Templates are WhatsApp-only (Messenger and Instagram have none). */}
      {showTemplates && !metaLine && (
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
  const [headerParam, setHeaderParam] = useState("");
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const needs = pick ? templateNeeds(pick.components, pick.category) : null;
  const count = needs?.bodyParams ?? 0;
  const body = pick ? templateBodyText(pick.components) : null;
  const problem = needs ? templateDraftProblem(needs, { params, headerParam, buttonParams, hasFile: !!file }) : null;

  // A local preview of the chosen picture (never uploaded until Send).
  const [filePreview, setFilePreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setFilePreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function choose(t: InboxTemplate): void {
    const n = templateNeeds(t.components, t.category);
    if (!n.sendable) return;
    setPick(t);
    // Pre-fill {{1}} with the customer's first name — the usual greeting slot.
    const first = conv.customer?.name?.trim().split(/\s+/)[0] ?? "";
    setParams(Array.from({ length: n.bodyParams }, (_, i) => (i === 0 ? first : "")));
    setHeaderParam("");
    setButtonParams({});
    setFile(null);
  }

  function onFile(f: File | undefined): void {
    if (!f || !needs?.headerMedia) return;
    const why = headerFileProblem(needs.headerMedia, f);
    if (why) {
      toast.error(why);
      return;
    }
    setFile(f);
  }

  async function send(): Promise<void> {
    if (!pick || !needs || problem) return;
    setBusy(true);
    try {
      let headerMedia: { media_key: string; media_token: string; mime: string; filename?: string } | undefined;
      if (needs.headerMedia && file) {
        const up = await inboxApi.upload(file);
        headerMedia = { media_key: up.object_key, media_token: up.media_token, mime: file.type, filename: file.name };
      }
      await inboxApi.sendTemplate(conv.id, {
        name: pick.name,
        language: pick.language,
        params: params.slice(0, count),
        ...(needs.headerParams > 0 ? { header_param: headerParam.trim() } : {}),
        ...(headerMedia ? { header_media: headerMedia } : {}),
        ...(needs.urlButtons.length
          ? { button_params: needs.urlButtons.map((b) => ({ index: b.index, text: (buttonParams[b.index] ?? "").trim() })) }
          : {}),
      });
      onSent();
    } catch (err) {
      // Upload errors (the raw PUT) don't go through api(); the rest already showed a toast.
      if (!(err instanceof Error && err.name === "ApiError")) toast.error(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  const mediaWord = needs?.headerMedia ? headerMediaLabel(needs.headerMedia) : "";

  return (
    <Modal title="Send a template" onClose={onClose} maxWidth={560}>
      {q.isLoading ? (
        <div>Loading…</div>
      ) : approved.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No approved templates</div>
          Templates are created in WhatsApp Manager, then synced in Inbox settings.
        </div>
      ) : !pick || !needs ? (
        <div style={{ display: "grid", gap: 6 }}>
          {approved.map((t) => {
            const n = templateNeeds(t.components, t.category);
            return (
              <button
                key={t.id}
                type="button"
                className={`card${n.sendable ? " card--hoverable" : ""}`}
                style={{ textAlign: "left", padding: 10, cursor: n.sendable ? "pointer" : "not-allowed", opacity: n.sendable ? 1 : 0.6 }}
                disabled={!n.sendable}
                onClick={() => choose(t)}
              >
                <div style={{ fontWeight: 700 }}>
                  {humanTemplateName(t.name)} <span className="pill" style={{ fontSize: 10 }}>{languageName(t.language)}</span>
                </div>
                <div className="ibx-raw">{t.name}</div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{(templateBodyText(t.components) ?? "").slice(0, 160)}</div>
                {!n.sendable ? (
                  <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>{n.reason}.</div>
                ) : n.headerMedia ? (
                  <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>You'll add a {headerMediaLabel(n.headerMedia)} before sending.</div>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <button type="button" className="btn btn--ghost btn--sm" style={{ justifySelf: "start" }} onClick={() => setPick(null)}>
            ← Pick another
          </button>

          {needs.headerMedia && (
            <div className="field">
              <span className="field__label">{mediaWord.charAt(0).toUpperCase() + mediaWord.slice(1)} for this message</span>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept={headerFileRule(needs.headerMedia).accept}
                onChange={(e) => {
                  onFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {file ? (
                <div className="ibx-attach">
                  <FileText size={14} aria-hidden />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)
                  </span>
                  <button type="button" className="btn btn--ghost btn--sm" aria-label={`Remove ${mediaWord}`} onClick={() => setFile(null)} disabled={busy}>
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn--subtle btn--sm" style={{ justifySelf: "start" }} onClick={() => fileRef.current?.click()}>
                  <Paperclip size={14} aria-hidden /> {addHeaderFileLabel(needs.headerMedia)}
                </button>
              )}
              <span className="field__hint">
                This template is sent with a {mediaWord} at the top. {headerFileRule(needs.headerMedia).hint}.
              </span>
            </div>
          )}

          {needs.headerParams > 0 && (
            <label className="field">
              <span className="field__label">Fill in the blank in the heading</span>
              <input className="input" value={headerParam} maxLength={60} onChange={(e) => setHeaderParam(e.target.value)} />
            </label>
          )}

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

          {needs.urlButtons.map((b) => (
            <label key={b.index} className="field">
              <span className="field__label">End of the link for the "{b.text}" button</span>
              <input
                className="input"
                value={buttonParams[b.index] ?? ""}
                maxLength={2000}
                onChange={(e) => setButtonParams((bp) => ({ ...bp, [b.index]: e.target.value }))}
              />
              <span className="field__hint" style={{ wordBreak: "break-all" }}>
                The button opens {fillButtonUrl(b.url, buttonParams[b.index] ?? "")}
              </span>
            </label>
          ))}

          <div className="card card--soft" style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>
            <div className="t-eyebrow" style={{ marginBottom: 4 }}>Preview</div>
            {needs.headerMedia &&
              (filePreview ? (
                <img src={filePreview} alt="" style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 10, display: "block", marginBottom: 6 }} />
              ) : (
                <div
                  style={{
                    border: "1px dashed var(--line)",
                    borderRadius: 10,
                    padding: "14px 10px",
                    marginBottom: 6,
                    textAlign: "center",
                    fontSize: 13,
                    color: "var(--ink-soft)",
                  }}
                >
                  {file ? file.name : `Your ${mediaWord} goes here`}
                </div>
              ))}
            {needs.headerText && <div style={{ fontWeight: 700, marginBottom: 4 }}>{fillTemplate(needs.headerText, [headerParam])}</div>}
            {body ? fillTemplate(body, params) : `Template "${pick.name}"`}
            {needs.footerText && <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 6 }}>{needs.footerText}</div>}
            {needs.buttonLabels.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {needs.buttonLabels.map((label, i) => (
                  <span key={i} className="pill">
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {problem && <span className="field__hint">{problem}</span>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" disabled={busy || !!problem} onClick={() => void send()}>
              {busy ? "Sending…" : "Send template"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Messenger/Instagram: shown in place of the reply box when the reply window
 * has closed or the line is switched off (spec 02, 7.3).
 */
function MetaClosedNotice(p: {
  conv: ConversationDetail;
  hidden: boolean;
  rsMode: string;
  statusText: string;
  name: string;
  closedWindow: string;
  canNote: boolean;
  onNote: () => void;
}): JSX.Element {
  const customerId = p.conv.customer?.id ?? p.conv.customerId;
  const hasPhone = !!p.conv.customer?.phone;
  const contact = useQuery({
    queryKey: inboxKeys.contact(customerId),
    queryFn: () => inboxApi.contact(customerId),
    enabled: hasPhone && !p.hidden && p.rsMode === "closed",
    staleTime: 60_000,
  });
  const waChat = contact.data?.conversations.find((c) => c.channel === "whatsapp");
  return (
    <div className="ibx-comp__closed ibx-composer__closed" aria-hidden={p.hidden || undefined} style={p.hidden ? { visibility: "hidden" } : undefined}>
      {p.rsMode === "off" ? (
        <div className="ibx-comp__closed-text">{p.statusText}</div>
      ) : (
        <div className="ibx-comp__closed-text">
          <strong>You can't reply here right now.</strong> {p.name} only lets a business reply within {p.closedWindow} of the
          customer's last message. What you can do: wait for them to write again (the box opens by itself); message them on
          WhatsApp or call if you have their number; or add a note for the team.
        </div>
      )}
      <div className="ibx-composer__closed-actions">
        {p.canNote && (
          <button type="button" className="btn btn--subtle btn--sm" onClick={p.onNote} tabIndex={p.hidden ? -1 : undefined}>
            Add a note
          </button>
        )}
        {p.rsMode === "closed" && waChat && (
          <Link to="/inbox/$conversationId" params={{ conversationId: waChat.id }} className="btn btn--primary btn--sm" tabIndex={p.hidden ? -1 : undefined}>
            Open their WhatsApp chat
          </Link>
        )}
      </div>
    </div>
  );
}
