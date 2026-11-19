import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Phone, PhoneOff, Mic, MicOff, Grid3x3, PhoneOutgoing, PhoneForwarded, Pause, Play, X } from "lucide-react";
import { useCan } from "../../lib/auth.js";
import {
  acceptIncoming,
  declineIncoming,
  hangUp,
  initVoice,
  sendDigits,
  setAvailable,
  startCall,
  toggleHold,
  toggleMute,
  transferActive,
  useVoice,
} from "../../lib/inbox-voice.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { api } from "../../lib/api.js";
import { contactName, formatDuration, prettyPhone } from "../../lib/inbox-logic.js";
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
  // Hide the whole bar until the server says calling is set up.
  const setup = useQuery({
    queryKey: ["inbox", "voice", "status"],
    enabled: canAnswer || canCall,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => api<{ data: { configured: boolean } }>("/inbox/voice/status", {}, { silentError: true }),
  });
  const configured = setup.data?.data.configured === true;
  const [keypad, setKeypad] = useState(false);
  const [dialOpen, setDialOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [, tick] = useState(0);

  // Answerers who left themselves "available" get the phone back on every load.
  useEffect(() => {
    useVoice.setState({ canAnswer, canCall });
    if (configured && canAnswer && useVoice.getState().available) void initVoice({ canAnswer, canCall });
  }, [canAnswer, canCall, configured]);

  // Re-render each second while a call is connected, for the timer.
  useEffect(() => {
    if (v.active?.state !== "open") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [v.active?.state]);

  useEffect(() => {
    if (!v.active) {
      setKeypad(false);
      setTransferOpen(false);
    }
  }, [v.active]);

  const callerPhone = v.incoming?.from ?? (v.active?.direction === "in" ? v.active.who : null);
  const caller = useCaller(callerPhone, canInbox);
  const callerName = caller.data ? contactName(caller.data.customer_name, caller.data.customer_phone, caller.data.identity_name) : null;

  if (!canAnswer && !canCall) return null;
  if (!configured && !v.active && !v.incoming) return null;

  return (
    <div className="callbar" aria-live="polite">
      {v.incoming && (
        <div className="callbar__card callbar__card--ringing" role="alertdialog" aria-label="Incoming call">
          <div className="t-eyebrow">Incoming call</div>
          <div>
            <div className="callbar__who">{callerName ?? prettyPhone(v.incoming.from)}</div>
            {callerName && <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{prettyPhone(v.incoming.from)}</div>}
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
              {v.active.direction === "in" ? (callerName ?? prettyPhone(v.active.who)) : prettyPhone(v.active.who)}
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              {v.active.state === "connecting"
                ? "Connecting…"
                : v.active.state === "ringing"
                  ? "Ringing…"
                  : formatDuration(v.active.startedAt ? (Date.now() - v.active.startedAt) / 1000 : 0)}
              {v.active.held ? " · on hold" : v.active.muted ? " · muted" : ""}
            </div>
            {v.active.held && (
              <div style={{ fontSize: 12, color: "var(--warning-ink)" }}>
                The customer hears silence and can't hear you. Press Resume to talk again.
              </div>
            )}
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
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={toggleMute}
              aria-pressed={v.active.muted}
              disabled={v.active.held}
              title={v.active.held ? "The call is on hold" : undefined}
            >
              {v.active.muted ? <MicOff size={15} /> : <Mic size={15} />} {v.active.muted && !v.active.held ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => setKeypad((k) => !k)} aria-pressed={keypad}>
              <Grid3x3 size={15} /> Keypad
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={hangUp}>
              <PhoneOff size={15} /> Hang up
            </button>
          </div>
          <div className="callbar__btns">
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={toggleHold}
              aria-pressed={v.active.held}
              disabled={v.active.state !== "open"}
              title="Customer hears silence"
            >
              {v.active.held ? <Play size={15} /> : <Pause size={15} />} {v.active.held ? "Resume" : "Hold"}
            </button>
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => setTransferOpen((o) => !o)}
              aria-expanded={transferOpen}
              disabled={v.active.state !== "open"}
            >
              <PhoneForwarded size={15} /> Transfer
            </button>
          </div>
          {!v.active.held && v.active.state === "open" && (
            <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Hold: the customer hears silence, not music.</div>
          )}
          {transferOpen && v.active.state === "open" && <TransferPicker onDone={() => setTransferOpen(false)} />}
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
        <div className="callbar__pill callbar__pill--idle">
          {canAnswer && (
            <label
              className="callbar__avail"
              title={
                v.available
                  ? "Customer calls ring on this device. Switch off to stop taking calls."
                  : "Switch on to take customer calls on this device."
              }
            >
              <input
                type="checkbox"
                role="switch"
                className={`callbar__switch${v.available && v.status === "loading" ? " is-busy" : ""}`}
                checked={v.available}
                onChange={(e) => void setAvailable(e.target.checked)}
                aria-label="Take customer calls on this device"
              />
              <span>{v.available ? (v.status === "loading" ? "Connecting…" : "Taking calls") : "Take calls: off"}</span>
            </label>
          )}
          {canCall && canInbox && (
            <button
              type="button"
              className="callbar__dial"
              onClick={() => setDialOpen((o) => !o)}
              aria-expanded={dialOpen}
              title="Call a number"
            >
              <PhoneOutgoing size={14} aria-hidden /> Dial
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Pick a team to hand the caller to. Our side of the call ends once it's done. */
function TransferPicker({ onDone }: { onDone: () => void }): JSX.Element {
  const teams = useQuery({ queryKey: inboxKeys.teams, queryFn: inboxApi.teams, staleTime: 5 * 60_000 });
  const active = (teams.data ?? []).filter((t) => t.isActive);
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = active.find((t) => t.id === teamId) ?? null;

  if (teams.isLoading) return <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Loading teams…</div>;
  if (teams.error) {
    return (
      <button type="button" className="btn btn--subtle btn--sm" onClick={() => void teams.refetch()}>
        Couldn't load teams — try again
      </button>
    );
  }
  if (active.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>There are no teams to transfer to yet.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label className="field">
        <span className="field__label">Transfer to team</span>
        <select className="select" value={teamId} disabled={busy} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">Pick a team…</option>
          {active.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="field__hint">The customer rings that team and your side of the call ends.</span>
      </label>
      <div className="callbar__btns">
        <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!chosen || busy}
          onClick={async () => {
            if (!chosen) return;
            setBusy(true);
            const ok = await transferActive(chosen.id, chosen.name);
            setBusy(false);
            if (ok) onDone();
          }}
        >
          {busy ? "Transferring…" : "Transfer call"}
        </button>
      </div>
    </div>
  );
}

function DialCard({ onClose, canInbox }: { onClose: () => void; canInbox: boolean }): JSX.Element {
  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, enabled: canInbox, staleTime: 60_000 });
  // Phone lines that take calls (never a Facebook Page or Instagram account).
  const voiceNumbers = (me.data?.numbers ?? []).filter((n) => (n.kind ?? "phone") === "phone" && n.channels !== "whatsapp");
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
