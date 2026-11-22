/** Calls for /v1/inbox/calls: the call log, the call-back list and the metrics (22 Nov 2026). */
import { api } from "@admin/lib/api.js";
import type { CallOutcome, TimelineRecording } from "@admin/lib/inbox-types.js";

export interface CallRow {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  outcome: CallOutcome;
  from_e164: string;
  to_e164: string;
  ivr_choice: string | null;
  started_at: string;
  answered_at: string | null;
  wait_s: number | null;
  duration_s: number | null;
  followup_sent_at: string | null;
  /** When the customer was called back, or called again and got through. Null = not returned. */
  returned_at: string | null;
  line: string;
  phone_number_id: string;
  answered_by: string | null;
  customer: { id: string; name: string | null; phone: string | null };
  recordings: TimelineRecording[];
}

export interface CallPage {
  data: CallRow[];
  has_more: boolean;
  next_before: string | null;
}

export interface CallbackRow extends CallRow {
  /** How many times this customer tried without getting through, in the window. */
  attempts: number;
}

export interface CallMetrics {
  totals: {
    total: number;
    inbound: number;
    outbound: number;
    answered_in: number;
    missed_in: number;
    voicemail: number;
    after_hours: number;
    information: number;
    avg_wait_s: number | null;
    avg_duration_s: number | null;
    talk_s: number;
    returned: number;
    median_return_s: number | null;
  } | null;
  per_day: { day: string; inbound: number; outbound: number; answered: number; missed: number }[];
  heat: { dow: number; hour: number; calls: number; missed: number }[];
  staff: { user_id: string; name: string; answered: number; made: number; talk_s: number; avg_wait_s: number | null }[];
  menu: { choice: string | null; calls: number }[];
  definitions: { missed: string; returned: string };
}

export interface CallFilters {
  from?: string;
  to?: string;
  direction?: "in" | "out";
  /** A call result, including "information" (the menu only played a message). */
  outcome?: string;
  customer?: string;
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const callKeys = {
  all: ["calls"] as const,
  list: (f: CallFilters) => ["calls", "list", f] as const,
  callbacks: ["calls", "callbacks"] as const,
  metrics: (from: string, to: string) => ["calls", "metrics", from, to] as const,
};

export const callsApi = {
  list: (f: CallFilters, before?: string) =>
    api<CallPage>(`/inbox/calls${qs({ ...f, before } as Record<string, string | undefined>)}`),
  callbacks: () => api<{ data: CallbackRow[]; count: number; window_days: number }>("/inbox/calls/callbacks"),
  metrics: async (from: string, to: string) =>
    (await api<{ data: CallMetrics }>(`/inbox/calls/metrics${qs({ from, to })}`)).data,
};
