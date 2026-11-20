/** The live switchboard: /v1/inbox/switchboard. */
import { api } from "@admin/lib/api.js";

export type LineState = "ringing" | "waiting" | "on_call" | "on_hold";
export type StaffState = "available" | "on_call" | "away" | "offline";

export interface BoardLine {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  state: LineState;
  /** When the current state began (the timer counts from here). */
  since: string;
  started_at: string;
  customer_name: string | null;
  customer_phone: string | null;
  number_label: string;
  number_e164: string;
  team_id: string | null;
  team_name: string | null;
  ivr_choice: string | null;
  /** Who is talking (in: answered by; out: the caller). */
  staff_id: string | null;
  staff_name: string | null;
  /** Ringing for just this person (picked up or transferred from the board). */
  ringing_for_id: string | null;
  ringing_for: string | null;
  /** Supervisor tools (beta): who is listening in, how, and whether their app has joined. */
  monitor_user_id: string | null;
  monitor_name: string | null;
  monitor_mode: MonitorMode | null;
  monitor_connected: boolean;
}

export type MonitorMode = "listen" | "whisper" | "join";

/** The owner's "Use call queue and supervisor tools (beta)" switch. */
export interface CallFeatures {
  enabled: boolean;
  hold_audio_key: string | null;
  max_wait_s: number;
}

export interface BoardStaff {
  id: string;
  name: string;
  state: StaffState;
  /** Their live call, when it is one the viewer can see. */
  call_id: string | null;
  last_seen_at: string | null;
  /** The manager who marked them away, if one did. */
  away_set_by: string | null;
  teams: string[];
}

export interface Board {
  /** Server time, so timers don't drift with a wrong computer clock. */
  now: string;
  lines: BoardLine[];
  staff: BoardStaff[];
  teams: { id: string; name: string }[];
  can_pick_up: boolean;
  /** The call queue and listening in are switched on (owner's beta switch). */
  queue_and_supervisor_tools: boolean;
}

const B = "/inbox/switchboard";
const post = (path: string, body: unknown = {}) =>
  api<{ ok: true }>(`${B}${path}`, { method: "POST", body: JSON.stringify(body) }, { silentError: true });

export const boardKeys = { board: ["calls", "switchboard"] as const, features: ["calls", "call-features"] as const };

export const boardApi = {
  get: async () => (await api<{ data: Board }>(B)).data,
  pickUp: (callId: string) => post(`/calls/${callId}/pickup`),
  /** Call queue (beta): ring the longest-waiting caller on my app. */
  takeNext: () => post("/queue/take-next"),
  transfer: (callId: string, to: { team_id: string } | { user_id: string }) => post(`/calls/${callId}/transfer`, to),
  setPresence: (userId: string, available: boolean) => post(`/staff/${userId}/presence`, { available }),
  /** Supervisor tools (beta). */
  listen: (callId: string, mode: MonitorMode) => post(`/calls/${callId}/listen`, { mode }),
  setMode: (callId: string, mode: MonitorMode) => post(`/calls/${callId}/monitor`, { mode }),
  stopListening: (callId: string) => post(`/calls/${callId}/listen/stop`),
};

export const callFeaturesApi = {
  get: async () => (await api<{ data: CallFeatures }>("/inbox/call-features")).data,
  save: async (v: CallFeatures) =>
    (await api<{ data: CallFeatures }>("/inbox/call-features", { method: "PUT", body: JSON.stringify(v) })).data,
};
