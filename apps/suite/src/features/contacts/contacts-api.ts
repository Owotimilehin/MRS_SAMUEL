/** Calls for /v1/contacts (suite spec 14, Phase A). */
import { api, API_BASE, refreshAccessToken } from "@admin/lib/api.js";
import type {
  ConsentChannel,
  ConsentNow,
  ConsentPurpose,
  ConsentRow,
  ConsentState,
  ContactDetail,
  ContactFilter,
  ContactLabelColour,
  ContactLabelView,
  ContactListView,
  ContactRow,
  ContactSettings,
  ContactSort,
  CustomerSourceValue,
  ImportMapping,
  ImportRowView,
} from "@ms/shared";

export interface ContactPage {
  contacts: ContactRow[];
  next_cursor: string | null;
  total: number | null;
}
export type ContactLookup = ContactDetail | { merged_into: string };
export interface LabelRow extends ContactLabelView {
  contacts: number;
}
export interface ContactHistory {
  consent: ConsentRow[];
  edits: { at: string; by_name: string | null; action: string; changed: string[] }[];
}
export interface ImportUpload {
  id: string;
  headers: string[];
  total_rows: number;
  sample: string[][];
  suggested_mapping: ImportMapping;
}
export interface ImportOptions {
  mapping: ImportMapping;
  source_label: string;
  customer_source: CustomerSourceValue;
  consent_declared: "none" | "marketing_whatsapp";
  consent_method?: string | null;
  consent_wording?: string | null;
  consent_collected_on?: string | null;
  fill_blanks: boolean;
  label_id?: string | null;
  list_id?: string | null;
}
export interface ImportPreview {
  new: number;
  matched: number;
  rejected: number;
  rows: ImportRowView[];
  reasons: { reason: string; text: string; count: number }[];
}
export interface ImportStatus {
  id: string;
  filename: string;
  status: "uploaded" | "previewed" | "applying" | "applied" | "failed" | "cancelled";
  total_rows: number;
  new: number;
  matched: number;
  rejected: number;
  applied_rows: number;
  error: string | null;
  label_id: string | null;
  list_id: string | null;
  rows: ImportRowView[];
}

/** A write the server refused, or that never reached it. `reason` comes from the server's `details`. */
export class ContactFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason: string | null,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContactFailure";
  }
}

export function failureText(err: unknown): string {
  return err instanceof ContactFailure ? err.message : "Something went wrong. Please try again.";
}

export const contactKeys = {
  all: ["contacts"] as const,
  list: (filter: ContactFilter, sort: ContactSort) => ["contacts", "list", JSON.stringify(filter), sort] as const,
  one: (id: string) => ["contacts", "one", id] as const,
  history: (id: string) => ["contacts", "history", id] as const,
  labels: ["contacts", "labels"] as const,
  lists: (archived: boolean) => ["contacts", "lists", archived] as const,
  listOne: (id: string) => ["contacts", "list-one", id] as const,
  settings: ["contacts", "settings"] as const,
  importOne: (id: string) => ["contacts", "import", id] as const,
};

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Body {
  data?: unknown;
  error?: { message?: string; details?: Record<string, unknown> & { reason?: string; issues?: unknown } };
}

/**
 * Every write is sent once and never retried by the browser (one fetch; one
 * sign-in refresh on 401 is the only repeat). The shared api() helper retries a
 * 502; adding a contact, recording consent or starting an import a second time
 * must be a person's decision after seeing what happened.
 */
async function send<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  };
  const run = () => fetch(`${API_BASE}${path}`, init).catch(() => null);
  let res = await run();
  if (res?.status === 401 && (await refreshAccessToken())) res = await run();
  if (!res) throw new ContactFailure(0, "We couldn't reach the server. Check your connection and try again.", null, {});
  let body: Body = {};
  try {
    body = (await res.json()) as Body;
  } catch {
    /* not json */
  }
  if (res.status >= 200 && res.status < 300 && body.data !== undefined) return body.data as T;
  const details = body.error?.details ?? {};
  const message =
    res.status === 403
      ? "You don't have permission to do that."
      : body.error?.message && body.error.message !== "invalid request"
        ? body.error.message
        : `That didn't work (${res.status}). Check what you entered and try again.`;
  throw new ContactFailure(res.status, message, typeof details.reason === "string" ? details.reason : null, details);
}

function query(o: { filter?: ContactFilter; sort?: ContactSort; limit?: number; cursor?: string | null; list_id?: string }): string {
  const p = new URLSearchParams();
  if (o.filter && Object.keys(o.filter).length > 0) p.set("filter", JSON.stringify(o.filter));
  if (o.sort) p.set("sort", o.sort);
  if (o.limit) p.set("limit", String(o.limit));
  if (o.cursor) p.set("cursor", o.cursor);
  if (o.list_id) p.set("list_id", o.list_id);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

const one = (id: string) => `/contacts/${encodeURIComponent(id)}`;

export const contactsApi = {
  list: async (o: { filter: ContactFilter; sort: ContactSort; cursor?: string | null; limit?: number }) =>
    (await api<{ data: ContactPage }>(`/contacts${query(o)}`)).data,
  get: async (id: string) => (await api<{ data: ContactLookup }>(one(id))).data,
  history: async (id: string) => (await api<{ data: ContactHistory }>(`${one(id)}/history`)).data,
  labels: async () => (await api<{ data: LabelRow[] }>("/contacts/labels")).data,
  lists: async (includeArchived = false) =>
    (await api<{ data: ContactListView[] }>(`/contacts/lists${includeArchived ? "?include_archived=true" : ""}`)).data,
  listOne: async (id: string) => (await api<{ data: ContactListView }>(`/contacts/lists/${encodeURIComponent(id)}`)).data,
  settings: async () => (await api<{ data: ContactSettings }>("/contacts/settings")).data,
  importStatus: async (id: string, outcome?: string) =>
    (await api<{ data: ImportStatus }>(`/contacts/imports/${encodeURIComponent(id)}${outcome ? `?outcome=${outcome}&limit=200` : "?limit=1"}`)).data,

  create: (b: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
    customer_source: CustomerSourceValue;
    source_label?: string;
    consent?: { wording: string; collected_on?: string; method_note?: string };
  }) => send<{ id: string; created: boolean; matched_by?: string | null; name: string | null; consent_recorded: boolean; stopped: boolean }>("POST", "/contacts", b),
  update: (id: string, b: { name?: string; email?: string | null; address?: string | null; notes?: string | null }) => send<ContactDetail>("PATCH", one(id), b),
  recordConsent: (
    id: string,
    b: { channel: ConsentChannel; purpose: ConsentPurpose; state: ConsentState; wording?: string; collected_on?: string; note?: string; asked_again?: boolean },
  ) => send<{ changed: boolean; consent_now: ConsentNow[] }>("POST", `${one(id)}/consent`, b),
  setLabels: (id: string, labelIds: string[]) => send<ContactLabelView[]>("PUT", `${one(id)}/labels`, { label_ids: labelIds }),

  createLabel: (name: string, colour: ContactLabelColour) => send<LabelRow>("POST", "/contacts/labels", { name, colour }),
  updateLabel: (id: string, b: { name?: string; colour?: ContactLabelColour }) => send<ContactLabelView>("PATCH", `/contacts/labels/${id}`, b),
  deleteLabel: (id: string) => send<{ removed_from: number }>("DELETE", `/contacts/labels/${id}`, { confirm: true }),
  bulkLabels: (customerIds: string[], add: string[], remove: string[]) =>
    send<{ changed: number }>("POST", "/contacts/bulk/labels", { customer_ids: customerIds, add, remove }),

  createList: (b: { name: string; kind: "static" | "smart"; description?: string; filter?: ContactFilter; customer_ids?: string[] }) =>
    send<ContactListView>("POST", "/contacts/lists", b),
  updateList: (id: string, b: { name?: string; description?: string | null; filter?: ContactFilter; archived?: boolean }) =>
    send<ContactListView>("PATCH", `/contacts/lists/${id}`, b),
  addToList: (id: string, body: { customer_ids: string[] } | { filter: ContactFilter }) =>
    send<{ added: number; already: number }>("POST", `/contacts/lists/${id}/members`, body),
  removeFromList: (id: string, customerIds: string[]) => send<{ removed: number }>("DELETE", `/contacts/lists/${id}/members`, { customer_ids: customerIds }),

  saveSettings: (b: ContactSettings) => send<ContactSettings>("PUT", "/contacts/settings", b),

  uploadImport: (filename: string, csvText: string) => send<ImportUpload>("POST", "/contacts/imports", { filename, csv_text: csvText }),
  previewImport: (id: string, b: ImportOptions) => send<ImportPreview>("POST", `/contacts/imports/${id}/preview`, b),
  applyImport: (id: string, expectNew: number, expectMatched: number) =>
    send<{ queued: boolean }>("POST", `/contacts/imports/${id}/apply`, { confirm: true, expect_new: expectNew, expect_matched: expectMatched }),
  cancelImport: (id: string) => send<{ cancelled: boolean }>("POST", `/contacts/imports/${id}/cancel`),

  /**
   * Fetch the spreadsheet and hand it to the browser to save. One request, never
   * repeated: every download is written to the audit log.
   */
  download: async (o: { filter?: ContactFilter; list_id?: string }, filename: string): Promise<void> => {
    const run = () => fetch(`${API_BASE}/contacts/export.csv${query(o)}`, { credentials: "include" }).catch(() => null);
    let res = await run();
    if (res?.status === 401 && (await refreshAccessToken())) res = await run();
    if (!res) throw new ContactFailure(0, "We couldn't reach the server. Check your connection and try again.", null, {});
    if (!res.ok) {
      let message = res.status === 403 ? "You don't have permission to download contacts." : `The download didn't work (${res.status}).`;
      try {
        const body = (await res.json()) as Body;
        if (res.status !== 403 && body.error?.message) message = body.error.message;
      } catch {
        /* not json */
      }
      throw new ContactFailure(res.status, message, null, {});
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
