import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Phone, PhoneOff, Mic, MicOff, Grid3x3, PhoneOutgoing, X } from "lucide-react";
import { useCan } from "../../lib/auth.js";
import {
  acceptIncoming,
  declineIncoming,
  hangUp,
  initVoice,
  sendDigits,
  setAvailable,
  startCall,
  toggleMute,
  useVoice,
} from "../../lib/inbox-voice.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { contactName, formatDuration } from "../../lib/inbox-logic.js";
import { toE164 } from "@ms/shared";
import "./inbox.css";

/** Who is this number? Best-effort lookup in the inbox (people with inbox.view only). */
function useCaller(phone: string | null, enabled: boolean) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return useQuery({
    queryKey: ["inbox", "caller", digits],
    enabled: enabled && digits.length >= 6,
    staleTime: 60_000,
    queryFn: async () => {
      const page = await inboxApi.conversations({ status: "all", view: "all", q: digits });
      return page.data[0] ?? null;
    },
  });
}

/**
 * Global phone controls, mounted in the Shell for people who can answer or make
 * calls: an availability switch, the ringing popup, in-call controls and a
 * dialler. The Twilio SDK only loads once it's actually needed.
 */
export function CallBar(): JSX.Element | null {
  const can = useCan();
  const canAnswer = can("calls.answer");
  const canCall = can("calls.outbound");
  const canInbox = can("inbox.view");
  const v = useVoice();
  const [keypad, setKeypad] = useState(false);
  const [dialOpen, setDialOpen] = useState(false);
  const [, tick] = useState(0);

  // Answerers who left themselves "available" get the phone back on every load.
  useEffect(() => {
    useVoice.setState({ canAnswer, canCall });
    if (canAnswer && useVoice.getState().available) void initVoice({ canAnswer, canCall });
  }, [canAnswer, canCall]);

  // Re-render each second while a call is connected, for the timer.
  useEffect(() => {
    if (v.active?.state !== "open") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [v.active?.state]);

  useEffect(() => {
    if (!v.active) setKeypad(false);
  }, [v.active]);

  const callerPhone = v.incoming?.from ?? (v.active?.direction === "in" ? v.active.who : null);
  const caller = useCaller(callerPhone, canInbox);
  const callerName = caller.data ? contactName(caller.data.customer_name, caller.data.customer_phone) : null;

  if (!canAnswer && !canCall) return null;

  return (
    <div className="callbar" aria-live="polite">
      {v.incoming && (
        <div className="callbar__card callbar__card--ringing" role="alertdialog" aria-label="Incoming call">
          <div className="t-eyebrow">Incoming call</div>
          <div>
            <div className="callbar__who">{callerName ?? v.incoming.from}</div>
            {callerName && <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{v.incoming.from}</div>}
            {caller.data && (
              <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>On {caller.data.number_label}</div>
            )}
          </div>
          <div className="callbar__btns">
            <button type="button" className="btn btn--call" onClick={() => void acceptIncoming()}>
              <Phone size={16} /> Answer
            </button>
            <button type="button" className="btn btn--danger" onClick={declineIncoming}>
              <PhoneOff size={16} /> Decline
            </button>
          </div>
        </div>
      )}

      {v.active && (
        <div className="callbar__card" role="region" aria-label="Call in progress">
          <div className="t-eyebrow">{v.active.direction === "in" ? "On a call" : "Calling"}</div>
          <div>
            <div className="callbar__who">
              {v.active.direction === "in" ? (callerName ?? v.active.who) : v.active.who}
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              {v.active.state === "connecting"
                ? "Connecting…"
                : v.active.state === "ringing"
                  ? "Ringing…"
                  : formatDuration(v.active.startedAt ? (Date.now() - v.active.startedAt) / 1000 : 0)}
              {v.active.muted ? " · muted" : ""}
            </div>
            {caller.data && v.active.direction === "in" && (
              <Link to="/inbox/$conversationId" params={{ conversationId: caller.data.id }} style={{ fontSize: 12 }}>
                Open their chat
              </Link>
            )}
          </div>
          {keypad && (
            <div className="callbar__keypad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((d) => (
                <button key={d} type="button" className="btn btn--subtle btn--sm" onClick={() => sendDigits(d)}>
                  {d}
                </button>
              ))}
            </div>
          )}
          <div className="callbar__btns">
            <button type="button" className="btn btn--subtle btn--sm" onClick={toggleMute} aria-pressed={v.active.muted}>
              {v.active.muted ? <MicOff size={15} /> : <Mic size={15} />} {v.active.muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => setKeypad((k) => !k)} aria-pressed={keypad}>
              <Grid3x3 size={15} /> Keypad
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={hangUp}>
              <PhoneOff size={15} /> Hang up
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn--ghost btn--sm" disabled title="Coming soon">
              Hold (soon)
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled title="Coming soon">
              Transfer (soon)
            </button>
          </div>
        </div>
      )}

      {dialOpen && !v.active && <DialCard onClose={() => setDialOpen(false)} canInbox={canInbox} />}

      {v.message && !v.active && !v.incoming && (
        <div className="callbar__pill" role="status" style={{ fontWeight: 500, maxWidth: 320 }}>
          <span style={{ fontSize: 12 }}>{v.message}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label="Dismiss"
            onClick={() => useVoice.setState({ message: null })}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {!v.active && !v.incoming && (
        <div className="callbar__pill">
          {canAnswer && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <span className={`callbar__dot${v.available && v.status === "ready" ? " callbar__dot--on" : ""}`} />
              <span>{v.available ? (v.status === "loading" ? "Connecting…" : "Taking calls") : "Not taking calls"}</span>
              <input
                type="checkbox"
                checked={v.available}
                onChange={(e) => void setAvailable(e.target.checked)}
                aria-label="Available for calls"
              />
            </label>
          )}
          {canCall && canInbox && (
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => setDialOpen((o) => !o)}
              aria-expanded={dialOpen}
              title="Call a number"
            >
              <PhoneOutgoing size={15} /> Dial
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DialCard({ onClose, canInbox }: { onClose: () => void; canInbox: boolean }): JSX.Element {
  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, enabled: canInbox, staleTime: 60_000 });
  const voiceNumbers = (me.data?.numbers ?? []).filter((n) => n.channels !== "whatsapp");
  const [to, setTo] = useState("");
  const [numberId, setNumberId] = useState("");
  const chosen = numberId || voiceNumbers[0]?.id || "";
  const e164 = toE164(to);

  return (
    <div className="callbar__card" role="dialog" aria-label="Call a number">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="t-eyebrow">Call a number</div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <label className="field">
        <span className="field__label">Customer's phone</span>
        <input className="input" inputMode="tel" placeholder="0803 123 4567" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      {voiceNumbers.length > 1 && (
        <label className="field">
          <span className="field__label">Call from</span>
          <select className="select" value={chosen} onChange={(e) => setNumberId(e.target.value)}>
            {voiceNumbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {voiceNumbers.length === 0 && !me.isLoading && (
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>You don't have a business number you can call from.</div>
      )}
      <button
        type="button"
        className="btn btn--call"
        disabled={!e164 || !chosen}
        onClick={() => {
          if (!e164) return;
          void startCall({ to: e164, numberId: chosen, who: e164 });
          onClose();
        }}
      >
        <Phone size={16} /> Call
      </button>
    </div>
  );
}
