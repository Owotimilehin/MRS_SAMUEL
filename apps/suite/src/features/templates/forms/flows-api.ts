/**
 * Calls for /v1/wa-flows (suite spec 07, 5.8): the built-in WhatsApp forms. Reads go through the shared
 * api(); every write is sent once and never retried by the browser (see `writeOnce`), because creating,
 * publishing or retiring a form twice must be a person's decision.
 */
import { api } from "@admin/lib/api.js";
import type { FlowState } from "@ms/shared";
import { writeOnce } from "../templates-api.js";

export interface FlowValidationError {
  message?: string;
  error?: string;
  line_start?: number;
  column_start?: number;
}

/** One form on one WhatsApp account. `id` is null until the form has been created at WhatsApp. */
export interface FlowDto {
  id: string | null;
  key: string;
  title: string;
  description: string;
  phase: "A" | "B";
  uses_endpoint: boolean;
  account: { waba_id: string; label: string };
  version: number | null;
  meta_flow_id: string | null;
  meta_name: string | null;
  status: string | null;
  state: FlowState;
  validation_errors: FlowValidationError[];
  last_error: string | null;
  code_is_newer: boolean;
  only_live_version: boolean;
  published_at: string | null;
  synced_at: string | null;
}

export interface FlowList {
  data: FlowDto[];
  any_live: boolean;
}

export type KeySignature = "VALID" | "MISMATCH" | null;

/** The secure-connection state of one WhatsApp number (Phase B). The server never sends key text. */
export interface EncryptionNumber {
  number_id: string;
  label: string;
  key_configured: boolean;
  uploaded: boolean;
  signature_status: KeySignature;
  error: string | null;
}

export interface EncryptionState {
  key_configured: boolean;
  numbers: EncryptionNumber[];
}

/** A form as the chat composer and the template editor see it (`GET /v1/inbox/flows`). */
export interface InboxFlow {
  key: string;
  title: string;
  description: string;
  cta: string;
  default_message: string;
  live: boolean;
  testable: boolean;
}

export const flowKeys = {
  list: ["wa-flows", "list"] as const,
  encryption: ["wa-flows", "encryption"] as const,
  /** The same key the inbox composer uses, so both share one copy. */
  inboxFlows: ["inbox", "flows"] as const,
};

const one = (id: string) => `/wa-flows/${encodeURIComponent(id)}`;

export const flowsApi = {
  list: () => api<FlowList>("/wa-flows"),
  encryption: async () => (await api<{ data: EncryptionState }>("/wa-flows/encryption")).data,
  preview: async (id: string) => (await api<{ data: { url: string; expires_at: string } }>(`${one(id)}/preview`)).data,
  inboxFlows: async () => (await api<{ data: InboxFlow[] }>("/inbox/flows")).data,

  create: async (key: string, wabaId: string) => (await writeOnce("POST", `${one(key)}/create`, { waba_id: wabaId })).data as FlowDto,
  upload: async (id: string) => (await writeOnce("POST", `${one(id)}/upload`)).data as FlowDto,
  newVersion: async (id: string) => (await writeOnce("POST", `${one(id)}/new-version`)).data as FlowDto,
  publish: async (id: string, confirmTitle: string): Promise<{ data: FlowDto; notice?: string }> => {
    const b = await writeOnce("POST", `${one(id)}/publish`, { confirm_title: confirmTitle });
    return { data: b.data as FlowDto, ...(b.notice ? { notice: b.notice } : {}) };
  },
  retire: async (id: string, confirmTitle: string, force: boolean) =>
    (await writeOnce("POST", `${one(id)}/retire${force ? "?force=1" : ""}`, { confirm_title: confirmTitle })).data as FlowDto,
  deleteDraft: async (id: string) => (await writeOnce("POST", `${one(id)}/delete-draft`)).data as { deleted: boolean },
  sync: async () => (await writeOnce("POST", "/wa-flows/sync")).data as { synced: number },
  uploadKey: async (numberId: string) =>
    (await writeOnce("POST", `/wa-flows/encryption/${encodeURIComponent(numberId)}/upload`)).data as EncryptionNumber,
};
