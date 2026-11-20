/**
 * The switchboard: every live call and every person who takes calls, live.
 *
 * Owners and managers (calls.switchboard) can pick up a call that is ringing
 * for someone else (it then rings on their own app only), hand a live call to
 * a team or a person, and mark a colleague away or available.
 *
 * Updates arrive on the inbox's live stream (call.updated, call.ringing,
 * presence.updated); the board also refreshes every 15 seconds in case an
 * update was missed, and timers tick every second using the server's clock.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, PhoneForwarded, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { humanizeError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { useInboxEvents } from "@admin/lib/inbox-stream.js";
import { useVoice } from "@admin/lib/inbox-voice.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import "./calls.css";
import { boardApi, boardKeys, type Board, type BoardLine, type BoardStaff } from "./switchboard-api.js";
import {
  LINE_LABEL,
  LINE_TONE,
  STAFF_LABEL,
  STAFF_TONE,
  canPickUp,
  canTransfer,
  lineStaff,
  lineWhere,
  lineWho,
  pillClass,
  presenceAction,
  sortLines,
  sortStaff,
  staffSub,
  summaryLine,
  timer,
  transferPeople,
} from "./switchboard-logic.js";

const LIVE_EVENTS = new Set(["call.updated", "call.ringing", "presence.updated", "reconnected"]);

export function SwitchboardPage(): JSX.Element {
  const can = useCan();
  if (!can("calls.switchboard")) {
    return (
      <Frame title="Switchboard" crumb="Calls">
        <div className="card">You don&apos;t have access to the switchboard. Ask the owner.</div>
      </Frame>
    );
  }
  return <BoardView />;
}

/** Now, by the server's clock, ticking every second. */
function useServerNow(serverNow: string | undefined): number {
  const [tick, setTick] = useState(() => Date.now());
  const offset = useMemo(() => (serverNow ? new Date(serverNow).getTime() - Date.now() : 0), [serverNow]);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return tick + offset;
}

function BoardView(): JSX.Element {
  const qc = useQueryClient();
  const board = useQuery({ queryKey: boardKeys.board, queryFn: boardApi.get, refetchInterval: 15_000 });
  const now = useServerNow(board.data?.now);
  useInboxEvents((e) => {
    if (LIVE_EVENTS.has(e.event)) void qc.invalidateQueries({ queryKey: boardKeys.board });
  });
  const refresh = (): void => void qc.invalidateQueries({ queryKey: boardKeys.board });

  return (
    <Frame title="Switchboard" crumb="Calls">
      <p className="cl-sub">Live calls and who is free, as they happen.</p>
      <DataState loading={board.isLoading} error={board.error} onRetry={() => void board.refetch()}>
        {board.data && <BoardBody board={board.data} now={now} onChanged={refresh} />}
      </DataState>
    </Frame>
  );
}

function BoardBody({ board, now, onChanged }: { board: Board; now: number; onChanged: () => void }): JSX.Element {
  const lines = sortLines(board.lines);
  const staff = sortStaff(board.staff);
  return (
    <div className="cl-cards">
      <div className="cl-count" role="status">
        {summaryLine(board.lines, board.staff)}
      </div>

      <section aria-labelledby="sb-lines">
        <h2 className="t-h2" id="sb-lines" style={{ marginBottom: 8 }}>
          Lines
        </h2>
        {lines.length === 0 ? (
          <div className="empty">No calls right now. New calls appear here the moment they come in.</div>
        ) : (
          <div className="cl-list">
            {lines.map((l) => (
              <LineCard key={l.id} line={l} board={board} now={now} onChanged={onChanged} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="sb-staff">
        <h2 className="t-h2" id="sb-staff" style={{ marginBottom: 8 }}>
          Staff
        </h2>
        {staff.length === 0 ? (
          <div className="empty">Nobody can take calls yet. Give staff “Answer phone calls” in Users.</div>
        ) : (
          <div className="cl-list">
            {staff.map((s) => (
              <StaffRow key={s.id} person={s} onChanged={onChanged} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function LineCard({ line, board, now, onChanged }: { line: BoardLine; board: Board; now: number; onChanged: () => void }): JSX.Element {
  const me = useAuthUser();
  const voice = useVoice();
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const Icon = line.direction === "in" ? PhoneIncoming : PhoneOutgoing;
  const withWho = lineStaff(line);

  async function pickUp(): Promise<void> {
    if (!voice.available) {
      toast.error("Switch on “Taking calls” in the call bar first, so the call can ring here.");
      return;
    }
    setBusy(true);
    try {
      await boardApi.pickUp(line.id);
      toast.success("The call is ringing on your device now. Answer it in the call bar.");
      onChanged();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card cl-row">
      <div className="cl-row__main" style={{ cursor: "default" }}>
        <Icon size={18} aria-hidden className="cl-row__icon" />
        <span className="cl-row__who">
          <span className="cl-row__name">{lineWho(line)}</span>
          <span className="cl-row__sub">{lineWhere(line)}</span>
          <span className="cl-row__sub">{withWho ?? ""}</span>
        </span>
        <span className="cl-row__side">
          <span className={pillClass(LINE_TONE[line.state])}>{LINE_LABEL[line.state]}</span>
          <span className="cl-sb-timer" aria-label={`for ${timer(line.since, now)}`}>
            {timer(line.since, now)}
          </span>
        </span>
      </div>
      <div className="cl-row__details" style={{ paddingTop: 0 }}>
        <div className="cl-sb-actions">
          {canPickUp(line, me.id, board.can_pick_up) && (
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void pickUp()}>
              {busy ? "Picking up…" : "Pick up"}
            </button>
          )}
          {canTransfer(line) && !transferring && (
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => setTransferring(true)}>
              <PhoneForwarded size={14} aria-hidden /> Transfer
            </button>
          )}
          <Link to="/inbox/$conversationId" params={{ conversationId: line.conversation_id }} className="btn btn--ghost btn--sm">
            <MessagesSquare size={14} aria-hidden /> Open the chat
          </Link>
        </div>
        {transferring && (
          <TransferForm
            line={line}
            board={board}
            onDone={() => {
              setTransferring(false);
              onChanged();
            }}
            onCancel={() => setTransferring(false)}
          />
        )}
      </div>
    </div>
  );
}

function TransferForm({
  line,
  board,
  onDone,
  onCancel,
}: {
  line: BoardLine;
  board: Board;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  // "t:<team id>" or "u:<user id>".
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const people = transferPeople(line, board.staff);

  async function send(): Promise<void> {
    if (!to) return;
    setBusy(true);
    try {
      const id = to.slice(2);
      await boardApi.transfer(line.id, to.startsWith("t:") ? { team_id: id } : { user_id: id });
      const name = to.startsWith("t:") ? board.teams.find((t) => t.id === id)?.name : board.staff.find((s) => s.id === id)?.name;
      toast.success(`Transferred to ${name ?? "them"}. The caller is ringing there now.`);
      onDone();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cl-sb-transfer">
      <label className="field" style={{ margin: 0, minWidth: 0 }}>
        <span className="field__label">Transfer to</span>
        <select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a team or a person</option>
          {board.teams.length > 0 && (
            <optgroup label="Teams (rings everyone free in the team)">
              {board.teams.map((t) => (
                <option key={t.id} value={`t:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
          {people.length > 0 && (
            <optgroup label="People who are free">
              {people.map((p) => (
                <option key={p.id} value={`u:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <div className="cl-sb-actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={!to || busy} onClick={() => void send()}>
          {busy ? "Transferring…" : "Transfer"}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="cl-fine">The person on the call is disconnected and the caller hears “Please hold while we transfer your call.”</p>
    </div>
  );
}

function StaffRow({ person, onChanged }: { person: BoardStaff; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const action = presenceAction(person);
  const sub = staffSub(person);

  async function setPresence(available: boolean): Promise<void> {
    setBusy(true);
    try {
      await boardApi.setPresence(person.id, available);
      toast.success(available ? `${person.name} is marked available.` : `${person.name} is marked away. Calls won't ring for them.`);
      onChanged();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card cl-sb-staff">
      <span className="cl-row__who">
        <span className="cl-row__name">{person.name}</span>
        <span className="cl-row__sub">{sub}</span>
      </span>
      <span className="cl-sb-actions" style={{ justifyContent: "flex-end" }}>
        <span className={pillClass(STAFF_TONE[person.state])}>{STAFF_LABEL[person.state]}</span>
        {action && (
          <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => void setPresence(action.available)}>
            {action.label}
          </button>
        )}
      </span>
    </div>
  );
}
