/**
 * WhatsApp Flows API (suite spec 07, section 5.3). On screen a Flow is called a "form".
 *
 * Nothing here runs on its own to create, change, publish, retire or delete a form at Meta
 * (foundation rule 7): those calls are made only from a route a signed-in person has confirmed.
 * The sync only reads what Meta already holds. createFlow never asks Meta to publish.
 */
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { outboxEvent, waFlow, type DbExecutor, type FlowValidationError } from "@ms/db";
import { flowDef } from "@ms/shared";
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

// ── Phase B: the data endpoint and its key (called only from a route a person confirmed) ──

/** Point a form at our data endpoint. "Flows with endpoints need a connected app." */
export async function setFlowEndpoint(cfg: MetaConfig, flowId: string, endpointUri: string, applicationId: string): Promise<void> {
  mustSucceed(
    await graph<{ success?: boolean }>(cfg, "POST", flowId, { endpoint_uri: endpointUri, application_id: applicationId }, WA),
    "the form's server address",
  );
}

/** Send the PUBLIC half of our key to Meta for one phone number (form-urlencoded). Never the private key. */
export async function uploadFlowPublicKey(cfg: MetaConfig, phoneNumberId: string, publicKeyPem: string): Promise<void> {
  if (!publicKeyPem.includes("BEGIN PUBLIC KEY") || publicKeyPem.includes("PRIVATE")) {
    throw new Error("refusing to send anything but a public key");
  }
  const res = await graphRaw<{ success?: boolean }>(
    cfg,
    "POST",
    `${phoneNumberId}/whatsapp_business_encryption`,
    {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ business_public_key: publicKeyPem }).toString(),
    },
    WA,
  );
  mustSucceed(res, "the key");
}

/** What Meta holds for a number: is a key there, and does its signature check out (VALID or MISMATCH). */
export async function getFlowPublicKeyStatus(cfg: MetaConfig, phoneNumberId: string): Promise<{ present: boolean; status: string | null }> {
  type Entry = { business_public_key?: string; business_public_key_signature_status?: string };
  const res = await graph<Entry & { data?: Entry[] }>(cfg, "GET", `${phoneNumberId}/whatsapp_business_encryption`, undefined, WA);
  const entry: Entry = Array.isArray(res?.data) ? (res.data[0] ?? {}) : (res ?? {});
  const present = typeof entry.business_public_key === "string" && entry.business_public_key.trim() !== "";
  const status = typeof entry.business_public_key_signature_status === "string" ? entry.business_public_key_signature_status.toUpperCase() : null;
  return { present, status: present ? status : null };
}

// ── The `flows` webhook field (status changes and endpoint health) ──

const FLOW_HEALTH_EVENTS = new Set(["ENDPOINT_ERROR_RATE", "ENDPOINT_LATENCY", "ENDPOINT_AVAILABILITY", "FLOW_VERSION_EXPIRY_WARNING"]);

/**
 * Apply one `flows` webhook change. A status change updates the form we hold; a block, a throttle,
 * an endpoint health warning or an expiry warning tells the owner, at most once per form per kind
 * per 24 hours. An event for a form we do not hold is ignored (rule 24). CLIENT_ERROR_RATE is only
 * reported back to the caller for logging.
 */
export async function applyFlowWebhook(
  db: DbExecutor,
  value: Record<string, unknown>,
  now: Date = new Date(),
): Promise<{ applied: boolean; alerted: boolean; event: string | null }> {
  const event = typeof value.event === "string" ? value.event.toUpperCase() : null;
  const flowId = typeof value.flow_id === "string" || typeof value.flow_id === "number" ? String(value.flow_id) : null;
  if (!event || !flowId) return { applied: false, alerted: false, event };
  const [row] = await db.select().from(waFlow).where(eq(waFlow.metaFlowId, flowId));
  if (!row) return { applied: false, alerted: false, event };

  let applied = false;
  let kind: string | null = null;
  if (event === "FLOW_STATUS_CHANGE") {
    const next = typeof value.new_status === "string" ? value.new_status.toUpperCase() : "";
    if (!["DRAFT", "PUBLISHED", "DEPRECATED", "BLOCKED", "THROTTLED"].includes(next)) return { applied: false, alerted: false, event };
    if (next !== row.status) {
      await db
        .update(waFlow)
        .set({ status: next, ...(next === "DEPRECATED" && !row.retiredAt ? { retiredAt: now } : {}), syncedAt: now, updatedAt: now })
        .where(eq(waFlow.id, row.id));
      applied = true;
    }
    if (next === "BLOCKED" || next === "THROTTLED") kind = next;
  } else if (FLOW_HEALTH_EVENTS.has(event)) {
    kind = event;
  }
  if (!kind) return { applied, alerted: false, event };

  const account = `${flowId}:${kind}`;
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(and(eq(outboxEvent.eventType, "inbox.flow_health"), gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)), sql`${outboxEvent.payload}->>'account' = ${account}`))
    .limit(1);
  if (recent) return { applied, alerted: false, event };
  await db.insert(outboxEvent).values({
    eventType: "inbox.flow_health",
    payload: {
      account,
      flow_id: flowId,
      event: kind,
      message: typeof value.message === "string" ? value.message.slice(0, 500) : null,
      title: flowDef(row.key)?.title ?? "A form",
    },
  });
  return { applied, alerted: true, event };
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
