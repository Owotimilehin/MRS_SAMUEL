/** Calls for /v1/leads (suite spec 13). */
import { api } from "@admin/lib/api.js";

export type LeadStatus = "new" | "contacted" | "won" | "lost";
export type LostReason = "not_interested" | "no_answer" | "wrong_number" | "duplicate" | "test" | "other";
export type FollowUpBlock = "no_phone" | "no_line" | "no_consent" | "no_template" | "already_sent" | "no_permission";

export interface LeadRow {
  id: string;
  received_at: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  form_id: string;
  form_name: string;
  ad_name: string | null;
  campaign_name: string | null;
  platform: string | null;
  is_organic: boolean | null;
  is_backfill: boolean;
  status: LeadStatus;
  lost_reason: LostReason | null;
  assignee: { id: string; name: string } | null;
  customer_id: string | null;
  /** Null unless you may see the conversation. */
  conversation_id: string | null;
  whatsapp_consent: boolean;
  followup_sent_at: string | null;
  first_contacted_at: string | null;
}

export interface LeadAnswer {
  key: string;
  label: string;
  values: string[];
}

export interface LeadConsent {
  form_name: string;
  privacy_policy_url: string | null;
  disclaimers: { key: string; text: string; is_checked: boolean }[];
  captured_at: string;
}

export interface LeadDetail extends LeadRow {
  answers: LeadAnswer[];
  consent: LeadConsent | null;
  note: string | null;
  erased: boolean;
  /** The name the shop already had for this customer, if any. */
  customer_name: string | null;
  can_open_conversation: boolean;
  can_follow_up: boolean;
  follow_up_blocked_reason: FollowUpBlock | null;
  /** Exactly what the follow-up would send, to whom and from which number. */
  follow_up_preview: { phone: string; line_label: string; text: string } | null;
}

export interface LeadList {
  leads: LeadRow[];
  counts: Record<LeadStatus, number>;
  problems: { pending: number; failed: number; oldest_pending_at: string | null };
}

export interface LeadFilters {
  status: LeadStatus | "all";
  form_id?: string;
  assignee?: string;
  q?: string;
  from?: string;
  to?: string;
  include_tests?: boolean;
}

export interface LeadFormRow {
  id: string;
  form_id: string;
  name: string;
  status: string | null;
  is_enabled: boolean;
  questions_count: number;
  disclaimers: { key: string; text: string; is_required: boolean }[];
  whatsapp_consent_key: string | null;
  consent_covers_whatsapp: boolean;
  phone_number_id: string | null;
  leads_total: number;
  leads_30d: number;
  backfill: { requested_at: string | null; done_at: string | null; count: number; stopped: boolean };
  synced_at: string | null;
}

export interface LeadFormList {
  data: LeadFormRow[];
  /** WhatsApp numbers a form can use. */
  lines: { id: string; label: string }[];
}

export interface LeadHealth {
  page: { id: string; name: string } | null;
  token_ok: boolean;
  subscribed: boolean;
  can_list_forms: boolean;
  problems: { code: string; plain: string }[];
}

export interface ReportRow {
  leads: number;
  contacted: number;
  won: number;
  lost: number;
  win_rate: number | null;
}

export interface LeadReport {
  range: { from: string; to: string };
  totals: ReportRow & { new: number; median_minutes_to_first_contact: number | null };
  by_form: (ReportRow & { form_id: string; form_name: string })[];
  by_ad: (ReportRow & { ad_id: string; ad_name: string | null; campaign_name: string | null })[];
  by_day: { day: string; leads: number }[];
}

export const leadKeys = {
  all: ["leads"] as const,
  list: (f: LeadFilters) => ["leads", "list", f] as const,
  detail: (id: string) => ["leads", "detail", id] as const,
  forms: ["leads", "forms"] as const,
  health: ["leads", "health"] as const,
  staff: ["leads", "staff"] as const,
  report: (from: string, to: string) => ["leads", "report", from, to] as const,
  forCustomer: (customerId: string) => ["leads", "customer", customerId] as const,
};

/** The query string for the list and the download (the same filters). */
export function leadQuery(f: LeadFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  p.set("status", f.status);
  if (f.form_id) p.set("form_id", f.form_id);
  if (f.assignee) p.set("assignee", f.assignee);
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.include_tests) p.set("include_tests", "true");
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `?${p.toString()}`;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const leadsApi = {
  list: async (f: LeadFilters) => (await api<{ data: LeadList }>(`/leads${leadQuery(f, { limit: "200" })}`)).data,
  detail: async (id: string) => (await api<{ data: LeadDetail }>(`/leads/${id}`)).data,
  update: async (id: string, b: { status?: LeadStatus; lost_reason?: LostReason | null; assignee_id?: string | null; note?: string }) =>
    (await api<{ data: LeadRow }>(`/leads/${id}`, json("PATCH", b))).data,
  openConversation: async (id: string) =>
    (await api<{ data: { conversation_id: string } }>(`/leads/${id}/conversation`, { method: "POST" })).data,
  /**
   * Sends a WhatsApp message to a person, so it is asked for once only and only after the
   * confirm dialog. The dialog shows the server's sentence itself, so no toast.
   */
  followUp: async (id: string, again: boolean) =>
    (
      await api<{ data: { message_id: string; status: string } }>(
        `/leads/${id}/follow-up`,
        json("POST", { confirm: true, ...(again ? { again: true } : {}) }),
        { silentError: true },
      )
    ).data,
  staff: async () => (await api<{ data: { id: string; name: string }[] }>("/leads/staff")).data,
  forms: () => api<LeadFormList>("/leads/forms"),
  syncForms: async () => (await api<{ data: { forms: number } }>("/leads/forms/sync", { method: "POST" })).data,
  updateForm: async (
    id: string,
    b: { is_enabled?: boolean; whatsapp_consent_key?: string | null; consent_covers_whatsapp?: boolean; phone_number_id?: string | null },
  ) => (await api<{ data: LeadFormRow }>(`/leads/forms/${id}`, json("PATCH", b))).data,
  backfill: (id: string) => api(`/leads/forms/${id}/backfill`, json("POST", { confirm: true })),
  health: async () => (await api<{ data: LeadHealth }>("/leads/health")).data,
  subscribe: async () =>
    (await api<{ data: { subscribed: boolean; changed: boolean } }>("/leads/health/subscribe", json("POST", { confirm: true }))).data,
  retryFailed: async () => (await api<{ data: { requeued: number } }>("/leads/retry-failed", { method: "POST" })).data,
  report: async (from: string, to: string) =>
    (await api<{ data: LeadReport }>(`/leads/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).data,
  /** The address of the download; the browser fetches it with the sign-in cookie. */
  exportUrl: (f: LeadFilters) => `/v1/leads/export.csv${leadQuery(f)}`,
};
