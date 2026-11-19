/**
 * WhatsApp Flows API (suite spec 07, section 5.3). On screen a Flow is called a "form".
 *
 * Nothing here runs on its own to create, change, publish, retire or delete a form at Meta
 * (foundation rule 7): those calls are made only from a route a signed-in person has confirmed.
 * The sync only reads what Meta already holds. createFlow never asks Meta to publish.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { waFlow, type DbExecutor, type FlowValidationError } from "@ms/db";
import { graph, graphRaw, MetaApiError, type GraphOptions, type MetaConfig } from "../inbox/meta.js";

const WA: GraphOptions = { service: "WhatsApp" };

export interface MetaFlow {
  id: string;
  name?: string;
  status?: string;
  categories?: string[];
  validation_errors?: FlowValidationError[];
  json_version?: string;
  endpoint_uri?: string;
}

const FLOW_FIELDS = "id,name,status,categories,validation_errors,json_version,endpoint_uri";

/** Keep only the parts of Meta's validation errors we show and store. */
export function cleanFlowErrors(raw: unknown): FlowValidationError[] {
  if (!Array.isArray(raw)) return [];
  const out: FlowValidationError[] = [];
  for (const item of raw.slice(0, 50)) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const one: FlowValidationError = {};
    if (typeof e.error === "string") one.error = e.error.slice(0, 200);
    if (typeof e.error_type === "string") one.error_type = e.error_type.slice(0, 200);
    if (typeof e.message === "string") one.message = e.message.slice(0, 1000);
    if (typeof e.line_start === "number") one.line_start = e.line_start;
    if (typeof e.column_start === "number") one.column_start = e.column_start;
    out.push(one);
  }
  return out;
}

function mustSucceed(res: { success?: boolean } | null, what: string): void {
  if (res?.success === false) throw new MetaApiError(`WhatsApp did not confirm ${what}`, 400, null, false);
}

/** Create a draft form. Never passes `publish`: a new form is always a draft. */
export async function createFlow(
  cfg: MetaConfig,
  wabaId: string,
  f: { name: string; categories: string[]; flowJson: string; endpointUri?: string },
): Promise<{ id: string; validationErrors: FlowValidationError[] }> {
  const res = await graph<{ id?: string; success?: boolean; validation_errors?: unknown }>(
    cfg,
    "POST",
    `${wabaId}/flows`,
    { name: f.name, categories: f.categories, flow_json: f.flowJson, ...(f.endpointUri ? { endpoint_uri: f.endpointUri } : {}) },
    WA,
  );
  if (!res?.id) throw new MetaApiError("Meta returned no form id", 502, null, true);
  return { id: String(res.id), validationErrors: cleanFlowErrors(res.validation_errors) };
}

/** Replace a form's JSON (multipart upload). Returns Meta's validation errors (empty when it is fine). */
export async function uploadFlowJson(cfg: MetaConfig, flowId: string, flowJson: string): Promise<FlowValidationError[]> {
  const form = new FormData();
  form.append("file", new Blob([flowJson], { type: "application/json" }), "flow.json");
  form.append("name", "flow.json");
  form.append("asset_type", "FLOW_JSON");
  const res = await graphRaw<{ success?: boolean; validation_errors?: unknown }>(cfg, "POST", `${flowId}/assets`, { body: form, timeoutMs: 30_000 }, WA);
  return cleanFlowErrors(res?.validation_errors);
}

export async function getFlow(cfg: MetaConfig, flowId: string): Promise<MetaFlow> {
  return graph<MetaFlow>(cfg, "GET", `${flowId}?fields=${FLOW_FIELDS}`, undefined, WA);
}

/** Every form of one WhatsApp account, following cursors. */
export async function listFlows(cfg: MetaConfig, wabaId: string): Promise<MetaFlow[]> {
  const out: MetaFlow[] = [];
  let next: string | null = `${wabaId}/flows?limit=100&fields=id,name,status,categories,validation_errors`;
  for (let page = 0; next && page < 50; page++) {
    const res: { data?: MetaFlow[]; paging?: { next?: string } } = await graph(cfg, "GET", next, undefined, WA);
    out.push(...(res.data ?? []));
    next = res.paging?.next ?? null;
  }
  return out;
}

/** Meta's own preview page for a form. The link needs no sign-in and lasts 30 days. */
export async function flowPreviewUrl(cfg: MetaConfig, flowId: string, fresh: boolean): Promise<{ url: string; expiresAt: string }> {
  const res = await graph<{ preview?: { preview_url?: string; expires_at?: string } }>(
    cfg,
    "GET",
    `${flowId}?fields=preview.invalidate(${fresh ? "true" : "false"})`,
    undefined,
    WA,
  );
  const url = res?.preview?.preview_url;
  if (!url) throw new MetaApiError("Meta returned no preview link", 502, null, true);
  return { url, expiresAt: res.preview?.expires_at ?? "" };
}

export async function publishFlow(cfg: MetaConfig, flowId: string): Promise<void> {
  mustSucceed(await graph<{ success?: boolean }>(cfg, "POST", `${flowId}/publish`, undefined, WA), "publishing the form");
}

export async function deprecateFlow(cfg: MetaConfig, flowId: string): Promise<void> {
  mustSucceed(await graph<{ success?: boolean }>(cfg, "POST", `${flowId}/deprecate`, undefined, WA), "retiring the form");
}

/** Drafts only (Meta refuses anything else). */
export async function deleteDraftFlow(cfg: MetaConfig, flowId: string): Promise<void> {
  mustSucceed(await graph<{ success?: boolean }>(cfg, "DELETE", flowId, undefined, WA), "deleting the draft");
}

// ── The one sync (the "Sync" button and the hourly job) ──────────────────────

/**
 * Bring status and validation errors of the forms we hold in line with Meta. Rows are matched by
 * meta_flow_id; a row is never created here. A draft Meta no longer lists gets a plain note.
 */
export async function syncFlowsForWaba(db: DbExecutor, cfg: MetaConfig, wabaId: string, now: Date = new Date()): Promise<number> {
  const rows = await db
    .select()
    .from(waFlow)
    .where(and(eq(waFlow.wabaId, wabaId), isNotNull(waFlow.metaFlowId)));
  if (rows.length === 0) return 0;
  const listed = new Map((await listFlows(cfg, wabaId)).map((f) => [String(f.id), f]));
  let updated = 0;
  for (const row of rows) {
    const meta = listed.get(row.metaFlowId!);
    if (!meta) {
      if (row.status === "DRAFT") {
        await db
          .update(waFlow)
          .set({ lastError: "This draft no longer exists at WhatsApp.", syncedAt: now, updatedAt: now })
          .where(eq(waFlow.id, row.id));
      }
      continue;
    }
    const status = typeof meta.status === "string" && meta.status ? meta.status.toUpperCase() : row.status;
    await db
      .update(waFlow)
      .set({
        status,
        ...(meta.validation_errors !== undefined ? { validationErrors: cleanFlowErrors(meta.validation_errors) } : {}),
        ...(status === "DEPRECATED" && !row.retiredAt ? { retiredAt: now } : {}),
        ...(row.lastError === "This draft no longer exists at WhatsApp." ? { lastError: null } : {}),
        syncedAt: now,
        updatedAt: now,
      })
      .where(eq(waFlow.id, row.id));
    updated++;
  }
  return updated;
}

// ── Wording ──────────────────────────────────────────────────────────────────

const FLOW_CONFIG_CODES = new Set(["190", "10", "200", "299"]);

/** A token or permission problem: the owner is told, and staff see "the connection needs fixing". */
export function isFlowConfigError(err: unknown): boolean {
  return err instanceof MetaApiError && err.code !== null && FLOW_CONFIG_CODES.has(err.code);
}

/** Plain English for a Meta failure on a form (spec 5.3). Meta's code is kept in the sentence for support. */
export function explainFlowError(err: unknown): string {
  if (!(err instanceof MetaApiError)) return "Something went wrong on our side. Nothing was changed at WhatsApp.";
  switch (err.code) {
    case "132068":
      return "WhatsApp has blocked this form because of errors. It cannot be sent until that is fixed.";
    case "132069":
      return "This form has been sent 10 times in the last hour, which is WhatsApp's limit while it has problems. Try again later.";
    case "131047":
      return "More than 24 hours have passed since the customer last wrote. Send a template first.";
    case "131026":
      return "This customer's WhatsApp is too old to open the form. Ask them to update WhatsApp, or take the details in chat.";
  }
  if (err.code && FLOW_CONFIG_CODES.has(err.code)) {
    return "WhatsApp would not let us in. The connection needs fixing by the technical lead.";
  }
  if (err.delivery === "unknown" || err.retryable) {
    return "WhatsApp did not answer. Check the list in a minute before trying again.";
  }
  const details = err.details as { userMessage?: unknown } | undefined;
  const own = typeof details?.userMessage === "string" && details.userMessage ? details.userMessage : err.message;
  return `WhatsApp refused this: ${own.slice(0, 300)}${err.code ? ` (Meta ${err.code})` : ""}`;
}
