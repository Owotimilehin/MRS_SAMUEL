/**
 * WhatsApp forms (Flows): create, preview, publish, retire and track the built-in forms
 * (suite spec 07, section 5.8). Mounted at /v1/wa-flows. On screen a Flow is called a "form".
 *
 * Every route needs templates.manage. Nothing here reaches Meta unless a signed-in person pressed a
 * button (foundation rule 7): create, upload, new-version, publish, retire and delete-draft change
 * things at Meta and each writes an audit row; list never calls Meta; preview and sync only read.
 * A form is never published by create: publishing is its own confirmed step.
 * The Meta token never leaves @ms/domain: it is not read, logged, stored or returned here.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { inboxPhoneNumber, waFlow, type DbClient } from "@ms/db";
import {
  MetaApiError,
  createFlow,
  deleteDraftFlow,
  deprecateFlow,
  explainFlowError,
  flowJson,
  flowJsonHash,
  flowJsonText,
  flowJsonVersion,
  flowPreviewUrl,
  getFlow,
  isFlowConfigError,
  listFlows,
  metaConfigFromEnv,
  publishFlow,
  syncFlowsForWaba,
  uploadFlowJson,
  type MetaConfig,
} from "@ms/domain";
import { WA_FLOWS, flowDef, flowMetaName, flowState, type FlowDef, type FlowState } from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { alertOnce } from "../lib/inbox-alerts.js";
import { BusinessError, pgErrorCode } from "../lib/errors.js";
import { logger } from "../logger.js";

const Uuid = z.string().uuid();
type Row = typeof waFlow.$inferSelect;

const NOT_SET_UP = "WhatsApp is not set up on this server.";
const GONE_AT_META = "This draft no longer exists at WhatsApp.";
/** Statuses in which customers can (or could, once unblocked) open the form. */
const LIVE_STATUSES = ["PUBLISHED", "BLOCKED", "THROTTLED"];

const CreateBody = z.object({ waba_id: z.string().min(1).max(100) });
const ConfirmBody = z.object({ confirm_title: z.string().max(200) });

/** Seams for tests. */
export const waFlowDeps = { now: (): Date => new Date() };

function userIdOf(c: Context): string {
  return (c.get("auth") as { userId: string }).userId;
}

function needCfg(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_SET_UP, 503);
  return cfg;
}

/** Forms this server can manage: those with a JSON file in this build. */
function managedForms(): FlowDef[] {
  return WA_FLOWS.filter((f) => flowJson(f.key) !== null);
}

async function ourWabas(db: DbClient): Promise<{ waba_id: string; label: string }[]> {
  const rows = await db
    .select({ waba: inboxPhoneNumber.wabaId, label: inboxPhoneNumber.label })
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.kind, "phone"), eq(inboxPhoneNumber.isActive, true), ne(inboxPhoneNumber.channels, "voice")))
    .orderBy(asc(inboxPhoneNumber.label));
  const byWaba = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.waba) continue;
    byWaba.set(r.waba, [...(byWaba.get(r.waba) ?? []), r.label]);
  }
  return [...byWaba.entries()].map(([waba_id, labels]) => ({ waba_id, label: labels.join(", ") }));
}

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
  validation_errors: { message?: string; error?: string; line_start?: number; column_start?: number }[];
  last_error: string | null;
  code_is_newer: boolean;
  /** No other version of this form is live on this account: retiring it needs the extra confirmation. */
  only_live_version: boolean;
  published_at: string | null;
  synced_at: string | null;
}

function codeIsNewer(row: Row): boolean {
  if (row.status === "DEPRECATED" || flowJson(row.key) === null) return false;
  return row.uploadedHash !== flowJsonHash(row.key);
}

function toDto(def: FlowDef, account: { waba_id: string; label: string }, row: Row | null, siblings: Row[]): FlowDto {
  const newer = row ? codeIsNewer(row) : false;
  return {
    id: row?.id ?? null,
    key: def.key,
    title: def.title,
    description: def.description,
    phase: def.phase,
    uses_endpoint: def.usesEndpoint,
    account,
    version: row?.version ?? null,
    meta_flow_id: row?.metaFlowId ?? null,
    meta_name: row?.metaName ?? null,
    status: row?.status ?? null,
    state: flowState(row ? { status: row.status, validationErrors: row.validationErrors, codeIsNewer: newer } : null),
    validation_errors: row?.validationErrors ?? [],
    last_error: row?.lastError ?? null,
    code_is_newer: newer,
    only_live_version: !!row && LIVE_STATUSES.includes(row.status) && !siblings.some((s) => s.id !== row.id && s.status === "PUBLISHED"),
    published_at: row?.publishedAt?.toISOString() ?? null,
    synced_at: row?.syncedAt?.toISOString() ?? null,
  };
}

/**
 * The rows worth a card for one form on one account: the newest version, and the newest live
 * version when that is an older one (so it can be retired once its replacement is published).
 */
function cardRows(rows: Row[]): Row[] {
  const sorted = [...rows].sort((a, b) => b.version - a.version);
  const newest = sorted[0];
  if (!newest) return [];
  const live = sorted.find((r) => LIVE_STATUSES.includes(r.status));
  return live && live.id !== newest.id ? [newest, live] : [newest];
}

async function loadRow(db: DbClient, c: Context): Promise<{ row: Row; def: FlowDef }> {
  const id = Uuid.safeParse(c.req.param("id"));
  if (!id.success) throw new BusinessError("not_found", "not found", 404);
  const [row] = await db.select().from(waFlow).where(eq(waFlow.id, id.data));
  const def = row ? flowDef(row.key) : null;
  if (!row || !def) throw new BusinessError("not_found", "not found", 404);
  return { row, def };
}

async function dtoOf(db: DbClient, id: string): Promise<FlowDto> {
  const [row] = await db.select().from(waFlow).where(eq(waFlow.id, id));
  const def = row ? flowDef(row.key) : null;
  if (!row || !def) throw new BusinessError("not_found", "not found", 404);
  const siblings = await db.select().from(waFlow).where(and(eq(waFlow.wabaId, row.wabaId), eq(waFlow.key, row.key)));
  const account = (await ourWabas(db)).find((a) => a.waba_id === row.wabaId) ?? { waba_id: row.wabaId, label: "" };
  return toDto(def, account, row, siblings);
}

/** Turn a Meta failure into the error the screen shows (spec 5.8). Raises the owner alert for a configuration refusal. */
async function metaFailure(db: DbClient, err: unknown, details: Record<string, unknown> = {}): Promise<BusinessError> {
  if (!(err instanceof MetaApiError)) throw err;
  const message = explainFlowError(err);
  if (isFlowConfigError(err)) {
    await alertOnce(db, "inbox.meta_config", { account: "whatsapp_flows", area: "whatsapp_flows", code: err.code ?? "" });
  }
  const all = { meta_code: err.code, meta_subcode: err.subcode, ...details };
  if (err.delivery === "unknown" || err.retryable) return new BusinessError("service_unavailable", message, 502, all);
  return new BusinessError("conflict", message, 409, all);
}

/** Meta refused, for good, something only it can decide (not a token problem, not a timeout). */
function isPlainRefusal(err: unknown): err is MetaApiError {
  return err instanceof MetaApiError && err.delivery === "not_sent" && !err.retryable && !isFlowConfigError(err);
}

async function noteError(db: DbClient, rowId: string, err: unknown): Promise<void> {
  const message = err instanceof MetaApiError ? explainFlowError(err) : "Something went wrong on our side.";
  await db.update(waFlow).set({ lastError: message.slice(0, 1000), updatedAt: waFlowDeps.now() }).where(eq(waFlow.id, rowId));
}

export function waFlowRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("templates.manage"));

  /** One card per built-in form per WhatsApp account. No Meta call. */
  r.get("/", async (c) => {
    const accounts = await ourWabas(db);
    const forms = managedForms();
    const rows = forms.length
      ? await db
          .select()
          .from(waFlow)
          .where(inArray(waFlow.key, forms.map((f) => f.key)))
          .orderBy(desc(waFlow.version))
      : [];
    const data: FlowDto[] = [];
    for (const account of accounts) {
      for (const def of forms) {
        const mine = rows.filter((x) => x.wabaId === account.waba_id && x.key === def.key);
        const cards = cardRows(mine);
        if (cards.length === 0) data.push(toDto(def, account, null, []));
        for (const row of cards) data.push(toDto(def, account, row, mine));
      }
    }
    return c.json({ data, any_live: rows.some((x) => x.status === "PUBLISHED") });
  });

  /**
   * Create the form at Meta as a draft and remember it. Used for a first copy ("Create at
   * WhatsApp") and for a further one ("Create a new copy"): the version is the highest we hold
   * plus one, and from version 2 the Meta name ends in _v<version>.
   */
  async function createVersion(c: Context, def: FlowDef, wabaId: string): Promise<FlowDto> {
    const cfg = needCfg();
    if (!(await ourWabas(db)).some((a) => a.waba_id === wabaId)) {
      throw new BusinessError("validation_failed", "That WhatsApp account is not set up here.", 400);
    }
    if (flowJson(def.key) === null) throw new BusinessError("not_found", "Unknown form.", 404);
    const existing = await db.select().from(waFlow).where(and(eq(waFlow.wabaId, wabaId), eq(waFlow.key, def.key)));
    if (existing.some((x) => x.status === "DRAFT")) {
      throw new BusinessError("conflict", "There is already a draft of this form. Use it, or delete it first.", 409, { reason: "draft_exists" });
    }
    const version = existing.reduce((m, x) => Math.max(m, x.version), 0) + 1;
    const name = flowMetaName(def, version);
    const text = flowJsonText(def.key);
    const hash = flowJsonHash(def.key);
    const now = waFlowDeps.now();

    let metaId: string;
    let errors: Row["validationErrors"] = [];
    let uploadedHash: string | null = hash;
    try {
      const made = await createFlow(cfg, wabaId, { name, categories: def.categories, flowJson: text });
      metaId = made.id;
      errors = made.validationErrors;
    } catch (err) {
      // No answer: it may have been created. Look for it by name before saying anything.
      let found: { id: string } | undefined;
      if (err instanceof MetaApiError && err.delivery === "unknown") {
        try {
          found = (await listFlows(cfg, wabaId)).find((f) => f.name === name && String(f.status ?? "").toUpperCase() === "DRAFT");
        } catch (lookup) {
          logger.warn({ err: lookup }, "form lookup after a timeout failed");
        }
      }
      if (!found) {
        await writeAudit(db, c, {
          action: "wa_flow.create",
          entityType: "wa_flow",
          entityId: `${wabaId}:${def.key}`,
          after: { key: def.key, version, meta_name: name, result: err instanceof MetaApiError && err.delivery === "unknown" ? "unknown" : "failed", error: explainFlowError(err) },
          notify: true,
        });
        throw await metaFailure(db, err);
      }
      metaId = String(found.id);
      // We cannot know the JSON arrived whole: leave the hash empty so "Upload again" is offered.
      uploadedHash = null;
    }

    let rowId: string;
    try {
      const [row] = await db
        .insert(waFlow)
        .values({
          wabaId,
          key: def.key,
          version,
          metaFlowId: metaId,
          metaName: name,
          status: "DRAFT",
          usesEndpoint: def.usesEndpoint,
          jsonVersion: flowJsonVersion(def.key),
          uploadedHash,
          validationErrors: errors,
          createdBy: userIdOf(c),
          syncedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: waFlow.id });
      rowId = row!.id;
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new BusinessError("conflict", "Someone else has just created this form. Reload the page.", 409);
      }
      throw err;
    }
    await writeAudit(db, c, {
      action: "wa_flow.create",
      entityType: "wa_flow",
      entityId: rowId,
      after: { key: def.key, version, meta_name: name, meta_flow_id: metaId, uploaded_hash: uploadedHash, validation_errors: errors.length, result: "created", published: false },
      notify: true,
    });
    return dtoOf(db, rowId);
  }

  r.post("/sync", async (c) => {
    const cfg = needCfg();
    let synced = 0;
    for (const a of await ourWabas(db)) {
      try {
        synced += await syncFlowsForWaba(db, cfg, a.waba_id, waFlowDeps.now());
      } catch (err) {
        throw await metaFailure(db, err);
      }
    }
    return c.json({ data: { synced } });
  });

  r.post("/:key/create", async (c) => {
    const def = flowDef(c.req.param("key"));
    if (!def || flowJson(def.key) === null) throw new BusinessError("not_found", "Unknown form.", 404);
    const body = CreateBody.parse(await c.req.json());
    return c.json({ data: await createVersion(c, def, body.waba_id) }, 201);
  });

  /** A further copy of a form Meta will not let us change. The old one stays live until this one is published. */
  r.post("/:id/new-version", async (c) => {
    const { row, def } = await loadRow(db, c);
    return c.json({ data: await createVersion(c, def, row.wabaId) }, 201);
  });

  /** Send the form in the code to Meta again (the same Flow). */
  r.post("/:id/upload", async (c) => {
    const { row, def } = await loadRow(db, c);
    if (row.status === "DEPRECATED") throw new BusinessError("conflict", "This form is retired. Create a new copy instead.", 409);
    if (!row.metaFlowId) throw new BusinessError("conflict", "This form is not at WhatsApp yet. Create it first.", 409);
    const cfg = needCfg();
    const hash = flowJsonHash(def.key);
    const now = waFlowDeps.now();
    let errors: Row["validationErrors"];
    try {
      errors = await uploadFlowJson(cfg, row.metaFlowId, flowJsonText(def.key));
    } catch (err) {
      await noteError(db, row.id, err);
      const locked = LIVE_STATUSES.includes(row.status) && isPlainRefusal(err);
      await writeAudit(db, c, {
        action: "wa_flow.upload",
        entityType: "wa_flow",
        entityId: row.id,
        before: { key: row.key, version: row.version, status: row.status, uploaded_hash: row.uploadedHash },
        after: { result: locked ? "published_locked" : err instanceof MetaApiError && err.delivery === "unknown" ? "unknown" : "failed", error: explainFlowError(err) },
        notify: true,
      });
      if (locked) {
        throw new BusinessError("conflict", "WhatsApp will not change a form that is already live. Make a new copy instead.", 409, {
          reason: "published_locked",
          meta_code: (err as MetaApiError).code,
        });
      }
      throw await metaFailure(db, err);
    }
    // Meta may put a live form back to Draft when its JSON changes (rule 9): read it back.
    let status = row.status;
    try {
      const fresh = await getFlow(cfg, row.metaFlowId);
      if (typeof fresh.status === "string" && fresh.status) status = fresh.status.toUpperCase();
    } catch (err) {
      logger.warn({ err, flow: row.id }, "form read-back after upload failed");
    }
    await db
      .update(waFlow)
      .set({ uploadedHash: hash, validationErrors: errors, jsonVersion: flowJsonVersion(def.key), status, lastError: null, syncedAt: now, updatedAt: now })
      .where(eq(waFlow.id, row.id));
    await writeAudit(db, c, {
      action: "wa_flow.upload",
      entityType: "wa_flow",
      entityId: row.id,
      before: { key: row.key, version: row.version, status: row.status, uploaded_hash: row.uploadedHash },
      after: { result: "uploaded", status, uploaded_hash: hash, validation_errors: errors.length },
      notify: true,
    });
    return c.json({ data: await dtoOf(db, row.id) });
  });

  /** Meta's own preview link (30 days, no sign-in). ?fresh=1 makes a new one. */
  r.get("/:id/preview", async (c) => {
    const { row } = await loadRow(db, c);
    if (!row.metaFlowId) throw new BusinessError("conflict", "This form is not at WhatsApp yet. Create it first.", 409);
    const cfg = needCfg();
    try {
      const p = await flowPreviewUrl(cfg, row.metaFlowId, c.req.query("fresh") === "1");
      return c.json({ data: { url: p.url, expires_at: p.expiresAt } });
    } catch (err) {
      throw await metaFailure(db, err);
    }
  });

  /** Make a draft live. A person typed the form's name to confirm. */
  r.post("/:id/publish", async (c) => {
    const { row, def } = await loadRow(db, c);
    const body = ConfirmBody.parse(await c.req.json());
    if (body.confirm_title.trim() !== def.title) {
      throw new BusinessError("validation_failed", "Type the form's name exactly to publish it.", 400, { reason: "confirm" });
    }
    if (row.status !== "DRAFT") {
      throw new BusinessError("conflict", row.status === "DEPRECATED" ? "This form is retired and cannot be published again." : "This form is already live.", 409);
    }
    if (!row.metaFlowId) throw new BusinessError("conflict", "This form is not at WhatsApp yet. Create it first.", 409);
    if (row.validationErrors.length > 0) {
      throw new BusinessError("conflict", "WhatsApp found problems in this form. They must be fixed before it can be published.", 409, { reason: "validation_errors" });
    }
    if (row.uploadedHash !== flowJsonHash(def.key)) {
      throw new BusinessError("conflict", "Upload the latest version first.", 409, { reason: "stale_upload" });
    }
    const cfg = needCfg();
    const before = { key: row.key, version: row.version, status: row.status, meta_flow_id: row.metaFlowId };

    let accepted = true;
    let failure: unknown = null;
    try {
      await publishFlow(cfg, row.metaFlowId);
    } catch (err) {
      accepted = false;
      failure = err;
    }
    // Read it back either way: after a timeout the read-back is the only way to know.
    let status: string | null = null;
    if (accepted || (failure instanceof MetaApiError && failure.delivery === "unknown")) {
      try {
        const fresh = await getFlow(cfg, row.metaFlowId);
        status = typeof fresh.status === "string" && fresh.status ? fresh.status.toUpperCase() : null;
      } catch (err) {
        logger.warn({ err, flow: row.id }, "form read-back after publish failed");
      }
    }
    const now = waFlowDeps.now();
    if (!accepted && status !== "PUBLISHED") {
      await noteError(db, row.id, failure);
      await writeAudit(db, c, {
        action: "wa_flow.publish",
        entityType: "wa_flow",
        entityId: row.id,
        before,
        after: { result: failure instanceof MetaApiError && failure.delivery === "unknown" ? "unknown" : "failed", error: explainFlowError(failure) },
        notify: true,
      });
      throw await metaFailure(db, failure);
    }
    // Meta said yes. If the read-back could not be read, trust the yes; if it shows another status, store that.
    const finalStatus = status ?? "PUBLISHED";
    const live = finalStatus === "PUBLISHED";
    await db
      .update(waFlow)
      .set({
        status: finalStatus,
        ...(live ? { publishedHash: row.uploadedHash, publishedBy: userIdOf(c), publishedAt: now } : {}),
        lastError: null,
        syncedAt: now,
        updatedAt: now,
      })
      .where(eq(waFlow.id, row.id));
    await writeAudit(db, c, {
      action: "wa_flow.publish",
      entityType: "wa_flow",
      entityId: row.id,
      before,
      after: { result: live ? "published" : "not_live", status: finalStatus, published_hash: live ? row.uploadedHash : null, title: def.title },
      notify: true,
    });
    return c.json({
      data: await dtoOf(db, row.id),
      ...(live ? {} : { notice: `WhatsApp accepted the request, but the form is not showing as live yet (WhatsApp says ${finalStatus}). Press Sync in a minute.` }),
    });
  });

  /** Retire a live form for good. Customers can no longer open it, including ones already sent. */
  r.post("/:id/retire", async (c) => {
    const { row, def } = await loadRow(db, c);
    const body = ConfirmBody.parse(await c.req.json());
    if (body.confirm_title.trim() !== def.title) {
      throw new BusinessError("validation_failed", "Type the form's name exactly to retire it.", 400, { reason: "confirm" });
    }
    if (row.status === "DRAFT") throw new BusinessError("conflict", "This form is a draft. Delete the draft instead.", 409);
    if (row.status === "DEPRECATED") throw new BusinessError("conflict", "This form is already retired.", 409);
    if (!row.metaFlowId) throw new BusinessError("conflict", "This form is not at WhatsApp yet.", 409);
    const others = await db
      .select({ id: waFlow.id })
      .from(waFlow)
      .where(and(eq(waFlow.wabaId, row.wabaId), eq(waFlow.key, row.key), eq(waFlow.status, "PUBLISHED"), ne(waFlow.id, row.id)));
    if (others.length === 0 && c.req.query("force") !== "1") {
      throw new BusinessError(
        "conflict",
        "This is the only live version. Customers will no longer be able to open forms already sent. Retire anyway?",
        409,
        { reason: "only_live" },
      );
    }
    const cfg = needCfg();
    const before = { key: row.key, version: row.version, status: row.status, meta_flow_id: row.metaFlowId };
    try {
      await deprecateFlow(cfg, row.metaFlowId);
    } catch (err) {
      await noteError(db, row.id, err);
      await writeAudit(db, c, {
        action: "wa_flow.retire",
        entityType: "wa_flow",
        entityId: row.id,
        before,
        after: { result: err instanceof MetaApiError && err.delivery === "unknown" ? "unknown" : "failed", error: explainFlowError(err) },
        notify: true,
      });
      throw await metaFailure(db, err);
    }
    const now = waFlowDeps.now();
    await db.update(waFlow).set({ status: "DEPRECATED", retiredAt: now, lastError: null, syncedAt: now, updatedAt: now }).where(eq(waFlow.id, row.id));
    await writeAudit(db, c, {
      action: "wa_flow.retire",
      entityType: "wa_flow",
      entityId: row.id,
      before,
      after: { result: "retired", status: "DEPRECATED", title: def.title, forced: c.req.query("force") === "1" },
      notify: true,
    });
    return c.json({ data: await dtoOf(db, row.id) });
  });

  /** Delete a draft at Meta and here. Answers already received keep their form name. */
  r.post("/:id/delete-draft", async (c) => {
    const { row } = await loadRow(db, c);
    if (row.status !== "DRAFT") throw new BusinessError("conflict", "Only a draft can be deleted. Retire a live form instead.", 409);
    const before = { key: row.key, version: row.version, status: row.status, meta_flow_id: row.metaFlowId, meta_name: row.metaName };
    // A draft the sync found missing at Meta has nothing left to delete there.
    const metaCall = !!row.metaFlowId && row.lastError !== GONE_AT_META;
    if (metaCall) {
      const cfg = needCfg();
      try {
        await deleteDraftFlow(cfg, row.metaFlowId!);
      } catch (err) {
        await noteError(db, row.id, err);
        await writeAudit(db, c, {
          action: "wa_flow.delete",
          entityType: "wa_flow",
          entityId: row.id,
          before,
          after: { result: err instanceof MetaApiError && err.delivery === "unknown" ? "unknown" : "failed", error: explainFlowError(err) },
          notify: true,
        });
        throw await metaFailure(db, err);
      }
    }
    await db.delete(waFlow).where(and(eq(waFlow.id, row.id), eq(waFlow.status, "DRAFT")));
    await writeAudit(db, c, {
      action: "wa_flow.delete",
      entityType: "wa_flow",
      entityId: row.id,
      before,
      after: { result: "deleted", meta_call: metaCall },
      notify: true,
    });
    return c.json({ data: { deleted: true } });
  });

  return r;
}
