/** Calls for /v1/inbox/calls (the Calls list) and the voice set-up check. */
import { api } from "@admin/lib/api.js";
import type { TimelineRecording } from "@admin/lib/inbox-types.js";
import { callsQuery } from "./calls-logic.js";

/** Every outcome the server stores ("information": the caller picked a menu option that only plays a message). */
export type CallOutcome = "in_progress" | "answered" | "missed" | "voicemail" | "after_hours" | "information" | "failed";

export interface CallRow {
  id: string;
  conversation_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  from_e164: string;
  to_e164: string;
  number_id: string;
  number_label: string;
  direction: "in" | "out";
  outcome: CallOutcome;
  ivr_choice: string | null;
  duration_s: number | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  answered_by_id: string | null;
  answered_by: string | null;
  started_by_id: string | null;
  started_by: string | null;
  recordings: TimelineRecording[];
}

export interface CallPage {
  data: CallRow[];
  /** Pass as `before` to get the next (older) page. Null on the last page. */
  next_before: string | null;
}

export interface CallFilters {
  /** Lagos days, YYYY-MM-DD, both inclusive. */
  from?: string;
  to?: string;
  number?: string;
  staff?: string;
  outcome?: CallOutcome;
  direction?: "in" | "out";
}

export const callKeys = {
  all: ["calls"] as const,
  list: (f: CallFilters) => ["calls", "list", f] as const,
  voiceStatus: ["calls", "voice-status"] as const,
};

export const callsApi = {
  list: (f: CallFilters, before?: string) => api<CallPage>(`/inbox/calls?${callsQuery(f, before)}`),
  /** Is calling set up on this server (Twilio keys present)? */
  voiceConfigured: async () =>
    (await api<{ data: { configured: boolean } }>("/inbox/voice/status", {}, { silentError: true })).data.configured,
};
