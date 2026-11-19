/** Calls for /v1/templates (suite spec 06). */
import { api, API_BASE, refreshAccessToken } from "@admin/lib/api.js";
import type { DraftProblem, TemplateDraft, TEMPLATE_LANGUAGES, TEMPLATE_LIMITS } from "@ms/shared";

export interface TemplateRow {
  id: string;
  waba_id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown[];
  /** Meta Flow ID -> form key, for the form buttons in `components` (suite spec 07, 5.5a). */
  flow_keys?: Record<string, string>;
  meta_template_id: string | null;
  quality_score: string | null;
  rejected_reason: string | null;
  review_info: {
    rejection?: { reason?: string; recommendation?: string };
    pause?: { title?: string; description?: string };
    disableDate?: string;
    flagged?: boolean;
    locked?: boolean;
  } | null;
  correct_category: string | null;
  previous_category: string | null;
  category_change_at: string | null;
  status_changed_at: string | null;
  draft: Record<string, unknown> | null;
  draft_updated_at: string | null;
  draft_updated_by_name: string | null;
  submitted_at: string | null;
  last_error: string | null;
  edits_left: { today: number; month: number } | null;
  editable: boolean;
  not_editable_reason: string | null;
  system_use: string | null;
  starter_key: string | null;
  synced_at: string;
}

export interface TemplateOptions {
  accounts: { waba_id: string; label: string }[];
  languages: typeof TEMPLATE_LANGUAGES;
  limits: typeof TEMPLATE_LIMITS;
  sample_upload_ready: boolean;
  starter: { key: string; name: string; title: string; category: string; exists: boolean; exists_in: string[] }[];
}

export interface SubmitAnswer {
  data: TemplateRow;
  notice?: string;
}

/** A write that did not return 200 or 201. `reason` and `problems` come from the server's `details`. */
export class TemplateFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason: string | null,
    public readonly problems: DraftProblem[],
  ) {
    super(message);
    this.name = "TemplateFailure";
  }
  get changedElsewhere(): boolean {
    return this.reason === "changed_elsewhere";
  }
}

export const templateKeys = {
  list: ["templates", "list"] as const,
  one: (id: string) => ["templates", "one", id] as const,
  options: ["templates", "options"] as const,
  sampleUrl: (id: string, key: string) => ["templates", "sample", id, key] as const,
};

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Body {
  data?: unknown;
  notice?: string;
  error?: { message?: string; details?: { reason?: string; problems?: DraftProblem[] } };
}

/**
 * A write is sent once and never retried by the browser: the shared api() helper retries a 502, and
 * sending or deleting a template twice must be a person's decision after reading what WhatsApp
 * holds (foundation rule 9). One sign-in refresh on 401 is the only repeat.
 */
export async function writeOnce(method: string, path: string, payload?: unknown): Promise<Body> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  };
  const run = () => fetch(`${API_BASE}${path}`, init).catch(() => null);
  let res = await run();
  if (res?.status === 401 && (await refreshAccessToken())) res = await run();
  if (!res) throw new TemplateFailure(0, "We couldn't reach the server. Check your connection and try again.", null, []);
  let body: Body = {};
  try {
    body = (await res.json()) as Body;
  } catch {
    /* not json */
  }
  if ((res.status === 200 || res.status === 201) && body.data !== undefined) return body;
  throw new TemplateFailure(
    res.status,
    body.error?.message ?? `Something went wrong (${res.status}). Please try again.`,
    body.error?.details?.reason ?? null,
    body.error?.details?.problems ?? [],
  );
}

const one = (id: string) => `/templates/${encodeURIComponent(id)}`;

export const templatesApi = {
  list: async () => (await api<{ data: TemplateRow[] }>("/templates")).data,
  options: async () => (await api<{ data: TemplateOptions }>("/templates/options")).data,
  get: async (id: string) => (await api<{ data: TemplateRow }>(one(id))).data,
  sampleUrl: async (id: string) => (await api<{ data: { url: string } }>(`${one(id)}/sample-url`)).data.url,

  create: async (b: { waba_id: string; name: string; language: string; draft: TemplateDraft }) =>
    (await writeOnce("POST", "/templates", b)).data as TemplateRow,
  saveDraft: async (id: string, draft: TemplateDraft, stamp: string | null) =>
    (await writeOnce("PUT", `${one(id)}/draft`, { draft, draft_updated_at: stamp })).data as TemplateRow,
  discardDraft: async (id: string) => (await writeOnce("DELETE", `${one(id)}/draft`)).data as TemplateRow,
  submit: async (id: string, stamp: string, acceptWarnings: boolean): Promise<SubmitAnswer> => {
    const b = await writeOnce("POST", `${one(id)}/submit`, { draft_updated_at: stamp, accept_warnings: acceptWarnings });
    return { data: b.data as TemplateRow, ...(b.notice ? { notice: b.notice } : {}) };
  },
  remove: async (id: string, confirmName: string) => (await writeOnce("POST", `${one(id)}/delete`, { confirm_name: confirmName })).data as TemplateRow,
  refresh: async (id: string) => (await writeOnce("POST", `${one(id)}/refresh`)).data as TemplateRow,
  sync: async () => (await writeOnce("POST", "/templates/sync")).data as { synced: number },
  addStarter: async (wabaId: string, keys: string[]) =>
    (await writeOnce("POST", "/templates/starter", { waba_id: wabaId, keys })).data as { created: string[]; skipped: string[] },

  /** Ask for an upload link, then put the file straight into storage. Returns the key to keep in the draft. */
  uploadSample: async (id: string, file: File): Promise<string> => {
    const link = (await writeOnce("POST", `${one(id)}/sample`, { filename: file.name, content_type: file.type, size_bytes: file.size })).data as {
      upload_url: string;
      object_key: string;
    };
    const put = await fetch(link.upload_url, { method: "PUT", headers: { "content-type": file.type }, body: file }).catch(() => null);
    if (!put || !put.ok) throw new TemplateFailure(put?.status ?? 0, "The file did not upload. Check your connection and try again.", null, []);
    return link.object_key;
  },
};
