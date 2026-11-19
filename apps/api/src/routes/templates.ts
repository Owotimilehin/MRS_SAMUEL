/**
 * WhatsApp template authoring (suite spec 06, section 5.4): list, draft, preview support, submit,
 * edit, delete and track message templates. Mounted at /v1/templates.
 *
 * Every route needs templates.manage. Nothing here reaches Meta unless a signed-in person pressed a
 * button and confirmed (foundation rule 7): submit, refresh, sync and delete call Meta; list, get,
 * draft and starter do not. Submit and delete write an audit row with what was sent and what Meta
 * answered. The Meta token never leaves @ms/domain: it is not read, logged, stored or returned here.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { adminUser, inboxPhoneNumber, inboxTemplate, waFlow, type DbClient } from "@ms/db";
import {
  MetaApiError,
  applyMetaTemplate,
  createTemplate,
  deleteTemplate,
  editTemplate,
  explainTemplateError,
  findTemplateByName,
  getTemplate,
  isTemplateConfigError,
  metaConfigFromEnv,
  syncTemplatesForWaba,
  uploadFileToMeta,
  type MetaConfig,
} from "@ms/domain";
import {
  STARTER_TEMPLATES,
  TEMPLATE_LANGUAGES,
  TEMPLATE_LIMITS,
  TEMPLATE_SAMPLE_RULES,
  blanksIn,
  draftToComponents,
  editsLeft,
  flowDef,
  nextEditAt,
  normaliseTemplateLanguage,
  templateCategoryLabel,
  templateEditability,
  validateDraft,
  validateTemplateName,
  type DraftFlowTarget,
  type DraftProblem,
  type TemplateDraft,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { alertOnce } from "../lib/inbox-alerts.js";
import { BusinessError, pgErrorCode } from "../lib/errors.js";
import { logger } from "../logger.js";
import { TEMPLATE_SAMPLE_PREFIX, presignInboxGet, presignTemplateSamplePut } from "../lib/r2.js";

const Uuid = z.string().uuid();
type Row = typeof inboxTemplate.$inferSelect;

/** Templates the suite itself sends to customers, by name (spec 5.4 `system_use`). */
export const SYSTEM_TEMPLATES: Record<string, string> = { missed_call_followup: "missed_call" };

async function defaultLoadSample(key: string): Promise<Uint8Array> {
  const res = await fetch(await presignInboxGet(key, { expiresIn: 120 }));
  if (!res.ok) throw new BusinessError("conflict", "We could not read the sample file. Choose it again.", 409);
  return new Uint8Array(await res.arrayBuffer());
}

/** Seams for tests: where a sample's bytes come from, and what time it is (edit limits count days). */
export const templateDeps = {
  loadSample: defaultLoadSample as (key: string) => Promise<Uint8Array>,
  now: (): Date => new Date(),
};

const NOT_SET_UP = "WhatsApp is not set up on this server.";
const SAMPLE_NOT_SET_UP = "Sample upload is not set up on this server yet.";
const CHANGED_ELSEWHERE = "Someone else changed this draft. Reload to see their version.";
const IN_FLIGHT = "This template is already being sent. Wait a moment.";
const KEY_TAKEN = "A template with this name and language already exists.";
const BAD_SAMPLE = "That sample file is not what it says it is. Choose it again.";
const SYNC_FIRST = "Press Sync first, then try again.";
const MONTH_MS = 30 * 24 * 3600 * 1000;

// ── The draft, as the browser sends it ───────────────────────────────────────

const Str = z.string().max(5000);
const SampleKey = z
  .string()
  .max(300)
  .refine((k) => k === "" || (k.startsWith(TEMPLATE_SAMPLE_PREFIX) && !k.includes("..")), "bad sample key");
const HeaderSchema = z.union([
  z.object({ format: z.literal("TEXT"), text: Str, example: Str }).strict(),
  z
    .object({ format: z.enum(["IMAGE", "VIDEO", "DOCUMENT"]), sampleKey: SampleKey, sampleMime: z.string().max(100), sampleName: z.string().max(200) })
    .strict(),
]);
const ButtonSchema = z.union([
  z.object({ type: z.literal("QUICK_REPLY"), text: Str }).strict(),
  z.object({ type: z.literal("URL"), text: Str, url: z.string().max(5000), example: Str }).strict(),
  z.object({ type: z.literal("PHONE_NUMBER"), text: Str, phone: z.string().max(100) }).strict(),
  // A button that opens a built-in WhatsApp form (suite spec 07). "" until a form is chosen.
  z.object({ type: z.literal("FLOW"), text: Str, flowKey: z.string().max(60) }).strict(),
]);
export const DraftSchema = z
  .object({
    category: z.enum(["MARKETING", "UTILITY"]),
    header: HeaderSchema.nullable(),
    body: z.object({ text: z.string().max(10_000), examples: z.array(Str).max(50) }).strict(),
    footer: Str,
    buttons: z.array(ButtonSchema).max(30),
  })
  .strict();

const CreateBody = z.object({
  waba_id: z.string().min(1).max(100),
  name: z.string().min(1).max(TEMPLATE_LIMITS.name),
  language: z.string().min(1).max(20),
  draft: DraftSchema,
});
const SaveBody = z.object({ draft: DraftSchema, draft_updated_at: z.string().max(60).nullable() });
const SampleBody = z.object({
  filename: z.string().max(300),
  content_type: z.string().max(100),
  size_bytes: z.number().int().positive(),
});
const SubmitBody = z.object({ draft_updated_at: z.string().min(1).max(60), accept_warnings: z.boolean().default(false) });
const DeleteBody = z.object({ confirm_name: z.string().max(600) });
const StarterBody = z.object({ waba_id: z.string().min(1).max(100), keys: z.array(z.string().max(100)).min(1).max(20) });

// ── Helpers ──────────────────────────────────────────────────────────────────

function userIdOf(c: Context): string {
  return (c.get("auth") as { userId: string }).userId;
}

function needCfg(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_SET_UP, 503);
  return cfg;
}

function appIdOf(cfg: MetaConfig | null): string | null {
  return cfg?.appId && /^\d+$/.test(cfg.appId) ? cfg.appId : null;
}

function lagos(d: Date, withTime: boolean): string {
  return d.toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "long",
    ...(withTime ? { hour: "numeric", minute: "2-digit", hour12: true } : { year: "numeric" }),
  });
}

async function loadRow(db: DbClient, c: Context): Promise<Row> {
  const id = Uuid.safeParse(c.req.param("id"));
  if (!id.success) throw new BusinessError("not_found", "not found", 404);
  const [row] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.id, id.data));
  if (!row) throw new BusinessError("not_found", "not found", 404);
  return row;
}

async function wabaIsOurs(db: DbClient, waba: string): Promise<boolean> {
  const [n] = await db
    .select({ id: inboxPhoneNumber.id })
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.kind, "phone"), eq(inboxPhoneNumber.wabaId, waba)))
    .limit(1);
  return !!n;
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

async function namesFor(db: DbClient, rows: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.draftUpdatedBy).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const users = await db.select({ id: adminUser.id, name: adminUser.name, email: adminUser.email }).from(adminUser).where(inArray(adminUser.id, ids));
  return new Map(users.map((u) => [u.id, u.name ?? u.email]));
}

/** Meta's Flow ID -> our form key, for every form we hold (suite spec 07): lets a template with a form button be edited. */
async function flowKeysMap(db: DbClient): Promise<Record<string, string>> {
  const rows = await db.select({ id: waFlow.metaFlowId, key: waFlow.key }).from(waFlow).where(isNotNull(waFlow.metaFlowId));
  return Object.fromEntries(rows.map((x) => [x.id!, x.key]));
}

/** The Flow IDs a template's buttons name. */
function flowIdsIn(components: readonly unknown[] | null): string[] {
  const out: string[] = [];
  for (const c of (components ?? []) as { type?: unknown; buttons?: unknown }[]) {
    if (String(c?.type).toUpperCase() !== "BUTTONS" || !Array.isArray(c.buttons)) continue;
    for (const b of c.buttons as { type?: unknown; flow_id?: unknown }[]) {
      if (String(b?.type).toUpperCase() === "FLOW" && (typeof b.flow_id === "string" || typeof b.flow_id === "number")) out.push(String(b.flow_id));
    }
  }
  return out;
}

function toDto(row: Row, now: Date, names: Map<string, string>, flowKeys: Record<string, string>) {
  const edit = templateEditability({ status: row.status, category: row.category, components: row.components, reviewInfo: row.reviewInfo, flowKeys });
  return {
    // Only the forms this template's own buttons open.
    flow_keys: Object.fromEntries(flowIdsIn(row.components).flatMap((id) => (flowKeys[id] ? [[id, flowKeys[id]!]] : []))),
    id: row.id,
    waba_id: row.wabaId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    components: row.components,
    meta_template_id: row.metaTemplateId,
    quality_score: row.qualityScore,
    rejected_reason: row.rejectedReason,
    review_info: row.reviewInfo,
    correct_category: row.correctCategory,
    previous_category: row.previousCategory,
    category_change_at: row.categoryChangeAt?.toISOString() ?? null,
    status_changed_at: row.statusChangedAt?.toISOString() ?? null,
    draft: row.draft,
    draft_updated_at: row.draftUpdatedAt?.toISOString() ?? null,
    draft_updated_by_name: row.draftUpdatedBy ? (names.get(row.draftUpdatedBy) ?? null) : null,
    submitted_at: row.submittedAt?.toISOString() ?? null,
    last_error: row.lastError,
    edits_left: row.status === "APPROVED" ? editsLeft(row.metaEditTimes ?? [], now) : null,
    editable: edit.editable,
    not_editable_reason: edit.reason,
    system_use: SYSTEM_TEMPLATES[row.name] ?? null,
    starter_key: row.starterKey,
    synced_at: row.syncedAt.toISOString(),
  };
}

async function dtoOf(db: DbClient, id: string) {
  const [row] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.id, id));
  if (!row) throw new BusinessError("not_found", "not found", 404);
  return toDto(row, templateDeps.now(), await namesFor(db, [row]), await flowKeysMap(db));
}

/** The body and small print a template holds, for the duplicate check. */
function textOf(row: Row): { body: string; footer: string } {
  if (row.status === "DRAFT") {
    const d = row.draft as { body?: { text?: unknown }; footer?: unknown } | null;
    return { body: typeof d?.body?.text === "string" ? d.body.text : "", footer: typeof d?.footer === "string" ? d.footer : "" };
  }
  let body = "";
  let footer = "";
  for (const c of row.components as { type?: string; text?: unknown }[]) {
    if (String(c?.type).toUpperCase() === "BODY" && typeof c.text === "string") body = c.text;
    if (String(c?.type).toUpperCase() === "FOOTER" && typeof c.text === "string") footer = c.text;
  }
  return { body, footer };
}

/** Turn a Meta failure into the error the screen shows (spec 5.4). Raises the owner alert for a configuration refusal. */
async function metaFailure(db: DbClient, err: unknown): Promise<BusinessError> {
  if (!(err instanceof MetaApiError)) throw err;
  const message = explainTemplateError(err);
  if (isTemplateConfigError(err)) {
    await alertOnce(db, "inbox.meta_config", { account: "whatsapp_templates", area: "whatsapp_templates", code: err.code ?? "" });
  }
  const details = { meta_code: err.code, meta_subcode: err.subcode };
  if (err.delivery === "unknown" || err.retryable) return new BusinessError("service_unavailable", message, 502, details);
  return new BusinessError("conflict", message, 409, details);
}

/** The first bytes decide what a sample file is. */
function sniffMime(b: Uint8Array): string | null {
  const is = (sig: number[], at = 0): boolean => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
  if (is([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (is([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (is([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (is([0x66, 0x74, 0x79, 0x70], 4)) return "video/mp4";
  return null;
}

function sameStamp(rowStamp: Date | null, sent: string | null): boolean {
  if (rowStamp === null) return true;
  if (sent === null) return false;
  const t = Date.parse(sent);
  return Number.isFinite(t) && t === rowStamp.getTime();
}

function freshDraftRow(args: { draft: TemplateDraft; userId: string; now: Date; starterKey: string | null }) {
  return {
    status: "DRAFT",
    components: [] as unknown[],
    category: args.draft.category,
    metaTemplateId: null,
    parameterFormat: null,
    qualityScore: null,
    rejectedReason: null,
    reviewInfo: null,
    correctCategory: null,
    previousCategory: null,
    categoryChangeAt: null,
    statusChangedAt: args.now,
    draft: args.draft as unknown as Record<string, unknown>,
    draftUpdatedAt: args.now,
    draftUpdatedBy: args.userId,
    createdBy: args.userId,
    submittedBy: null,
    submittedAt: null,
    metaEditTimes: null,
    lastError: null,
    starterKey: args.starterKey,
    syncedAt: args.now,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function templateRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("templates.manage"));

  /** Every template we have, drafts included. No Meta call. */
  r.get("/", async (c) => {
    const rows = await db
      .select()
      .from(inboxTemplate)
      .where(ne(inboxTemplate.status, "DELETED"))
      .orderBy(asc(inboxTemplate.name), asc(inboxTemplate.language));
    const names = await namesFor(db, rows);
    const now = templateDeps.now();
    const flowKeys = await flowKeysMap(db);
    return c.json({ data: rows.map((x) => toDto(x, now, names, flowKeys)) });
  });

  r.get("/options", async (c) => {
    const accounts = await ourWabas(db);
    const existing = await db
      .select({ waba: inboxTemplate.wabaId, name: inboxTemplate.name })
      .from(inboxTemplate)
      .where(and(ne(inboxTemplate.status, "DELETED"), eq(inboxTemplate.language, "en")));
    const have = (waba: string, name: string): boolean => existing.some((e) => e.waba === waba && e.name === name);
    return c.json({
      data: {
        accounts,
        languages: TEMPLATE_LANGUAGES,
        limits: TEMPLATE_LIMITS,
        sample_upload_ready: appIdOf(metaConfigFromEnv()) !== null,
        starter: STARTER_TEMPLATES.map((s) => ({
          key: s.key,
          name: s.name,
          title: s.title,
          category: s.category,
          exists: accounts.length > 0 && accounts.every((a) => have(a.waba_id, s.name)),
          exists_in: accounts.filter((a) => have(a.waba_id, s.name)).map((a) => a.waba_id),
        })),
      },
    });
  });

  /** Bring in what Meta holds (also the "Sync from WhatsApp" button). */
  r.post("/sync", async (c) => {
    const cfg = needCfg();
    let synced = 0;
    for (const a of await ourWabas(db)) {
      try {
        synced += await syncTemplatesForWaba(db, cfg, a.waba_id, templateDeps.now());
      } catch (err) {
        throw await metaFailure(db, err);
      }
    }
    await writeAudit(db, c, { action: "inbox.templates_sync", entityType: "inbox_template", entityId: "all", after: { count: synced }, notify: true });
    return c.json({ data: { synced } });
  });

  /** Add starter templates as drafts. Nothing is sent to Meta. */
  r.post("/starter", async (c) => {
    const body = StarterBody.parse(await c.req.json());
    if (!(await wabaIsOurs(db, body.waba_id))) {
      throw new BusinessError("validation_failed", "That WhatsApp account is not set up here.", 400);
    }
    const picked = body.keys.map((k) => {
      const s = STARTER_TEMPLATES.find((x) => x.key === k);
      if (!s) throw new BusinessError("validation_failed", `Unknown starter template: ${k}`, 400);
      return s;
    });
    const now = templateDeps.now();
    const userId = userIdOf(c);
    const created: string[] = [];
    const skipped: string[] = [];
    for (const s of picked) {
      const [existing] = await db
        .select()
        .from(inboxTemplate)
        .where(and(eq(inboxTemplate.wabaId, body.waba_id), eq(inboxTemplate.name, s.name), eq(inboxTemplate.language, s.language)));
      if (existing && existing.status !== "DELETED") {
        skipped.push(s.name);
        continue;
      }
      const values = freshDraftRow({ draft: s.draft, userId, now, starterKey: s.key });
      if (existing) await db.update(inboxTemplate).set(values).where(eq(inboxTemplate.id, existing.id));
      else await db.insert(inboxTemplate).values({ wabaId: body.waba_id, name: s.name, language: s.language, ...values }).onConflictDoNothing();
      created.push(s.name);
    }
    await writeAudit(db, c, {
      action: "template.starter_add",
      entityType: "inbox_template",
      entityId: body.waba_id,
      after: { created, skipped },
      notify: true,
    });
    return c.json({ data: { created, skipped } });
  });

  /** A new draft. Problems in the draft do not stop it being saved. */
  r.post("/", async (c) => {
    const body = CreateBody.parse(await c.req.json());
    if (!(await wabaIsOurs(db, body.waba_id))) {
      throw new BusinessError("validation_failed", "That WhatsApp account is not set up here.", 400);
    }
    const nameProblem = validateTemplateName(body.name);
    if (nameProblem) throw new BusinessError("validation_failed", nameProblem, 400, { field: "name" });
    const language = normaliseTemplateLanguage(body.language);
    if (!TEMPLATE_LANGUAGES.some((l) => l.code === language)) {
      throw new BusinessError("validation_failed", "Choose one of the languages in the list.", 400, { field: "language" });
    }
    const draft = body.draft as TemplateDraft;
    const now = templateDeps.now();
    const userId = userIdOf(c);
    const [existing] = await db
      .select()
      .from(inboxTemplate)
      .where(and(eq(inboxTemplate.wabaId, body.waba_id), eq(inboxTemplate.name, body.name), eq(inboxTemplate.language, language)));
    if (existing && existing.status !== "DELETED") throw new BusinessError("conflict", KEY_TAKEN, 409);

    const values = freshDraftRow({ draft, userId, now, starterKey: null });
    let id: string;
    try {
      if (existing) {
        await db.update(inboxTemplate).set(values).where(eq(inboxTemplate.id, existing.id));
        id = existing.id;
      } else {
        const [row] = await db.insert(inboxTemplate).values({ wabaId: body.waba_id, name: body.name, language, ...values }).returning({ id: inboxTemplate.id });
        id = row!.id;
      }
    } catch (err) {
      if (pgErrorCode(err) === "23505") throw new BusinessError("conflict", KEY_TAKEN, 409);
      throw err;
    }
    await writeAudit(db, c, {
      action: "template.draft_create",
      entityType: "inbox_template",
      entityId: id,
      after: { name: body.name, language, category: draft.category },
      notify: true,
    });
    return c.json({ data: await dtoOf(db, id) }, 201);
  });

  r.get("/:id", async (c) => {
    const row = await loadRow(db, c);
    return c.json({ data: toDto(row, templateDeps.now(), await namesFor(db, [row]), await flowKeysMap(db)) });
  });

  /** Save the editable copy. A second person's save is refused rather than overwritten. */
  r.put("/:id/draft", async (c) => {
    const row = await loadRow(db, c);
    const body = SaveBody.parse(await c.req.json());
    const edit = templateEditability({ status: row.status, category: row.category, components: row.components, reviewInfo: row.reviewInfo, flowKeys: await flowKeysMap(db) });
    if (!edit.editable) throw new BusinessError("conflict", edit.reason ?? "This template cannot be changed.", 409, { reason: "not_editable" });
    const stale = new BusinessError("conflict", CHANGED_ELSEWHERE, 409, { reason: "changed_elsewhere" });
    if (!sameStamp(row.draftUpdatedAt, body.draft_updated_at)) throw stale;

    const now = templateDeps.now();
    // The comparison is repeated in the UPDATE so two saves at once cannot both win.
    const unchanged = row.draftUpdatedAt ? eq(inboxTemplate.draftUpdatedAt, row.draftUpdatedAt) : isNull(inboxTemplate.draftUpdatedAt);
    const draft = body.draft as TemplateDraft;
    const saved = await db
      .update(inboxTemplate)
      .set({
        draft: draft as unknown as Record<string, unknown>,
        draftUpdatedAt: now,
        draftUpdatedBy: userIdOf(c),
        ...(row.status === "DRAFT" ? { category: draft.category } : {}),
      })
      .where(and(eq(inboxTemplate.id, row.id), unchanged))
      .returning({ id: inboxTemplate.id });
    if (saved.length === 0) throw stale;
    await writeAudit(db, c, {
      action: "template.draft_save",
      entityType: "inbox_template",
      entityId: row.id,
      after: { name: row.name, language: row.language, draft },
      notify: false,
    });
    return c.json({ data: await dtoOf(db, row.id) });
  });

  /** Throw away unsent changes to a template WhatsApp already holds. */
  r.delete("/:id/draft", async (c) => {
    const row = await loadRow(db, c);
    if (row.status === "DRAFT") throw new BusinessError("validation_failed", "Delete the draft instead.", 400);
    await db.update(inboxTemplate).set({ draft: null, draftUpdatedAt: null, draftUpdatedBy: null }).where(eq(inboxTemplate.id, row.id));
    await writeAudit(db, c, {
      action: "template.draft_discard",
      entityType: "inbox_template",
      entityId: row.id,
      before: { name: row.name, language: row.language, had_draft: row.draft !== null },
      notify: true,
    });
    return c.json({ data: await dtoOf(db, row.id) });
  });

  /** A presigned upload for a heading sample (picture, video or PDF). */
  r.post("/:id/sample", async (c) => {
    await loadRow(db, c);
    const body = SampleBody.parse(await c.req.json());
    const out = await presignTemplateSamplePut({ contentType: body.content_type, sizeBytes: body.size_bytes });
    return c.json({ data: { upload_url: out.upload_url, object_key: out.object_key } }, 201);
  });

  /** A short-lived link to the draft's sample, for the preview. */
  r.get("/:id/sample-url", async (c) => {
    const row = await loadRow(db, c);
    const parsed = DraftSchema.safeParse(row.draft);
    const header = parsed.success ? parsed.data.header : null;
    if (!header || header.format === "TEXT" || header.sampleKey === "") throw new BusinessError("not_found", "not found", 404);
    return c.json({ data: { url: await presignInboxGet(header.sampleKey, { expiresIn: 600 }) } });
  });

  /** Read one template from Meta again. */
  r.post("/:id/refresh", async (c) => {
    const row = await loadRow(db, c);
    if (row.status === "DRAFT") throw new BusinessError("validation_failed", "This draft has not been sent to WhatsApp yet.", 400);
    if (!row.metaTemplateId) throw new BusinessError("conflict", SYNC_FIRST, 409);
    const cfg = needCfg();
    try {
      const fresh = await getTemplate(cfg, row.metaTemplateId);
      await applyMetaTemplate(db, row.wabaId, fresh, templateDeps.now());
    } catch (err) {
      throw await metaFailure(db, err);
    }
    return c.json({ data: await dtoOf(db, row.id) });
  });

  /** Send a new template for review, or send changes to one WhatsApp holds (spec 5.5). */
  r.post("/:id/submit", async (c) => {
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new BusinessError("not_found", "not found", 404);
    const body = SubmitBody.parse(await c.req.json());
    const cfg = needCfg();
    const userId = userIdOf(c);
    const now = templateDeps.now();

    // Steps 1 to 4 and 7: look, check, and claim the attempt, all under a row lock. Nothing here calls Meta.
    const claim = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(inboxTemplate).where(eq(inboxTemplate.id, id.data)).for("update");
      if (!row) throw new BusinessError("not_found", "not found", 404);
      if (
        row.status === "DRAFT" &&
        row.submittedAt &&
        Math.abs(now.getTime() - row.submittedAt.getTime()) < 60_000 &&
        !row.lastError
      ) {
        throw new BusinessError("conflict", IN_FLIGHT, 409, { reason: "in_flight" });
      }
      if (!row.draft) throw new BusinessError("validation_failed", "There is nothing to send. Make a change first.", 400);
      if (!sameStamp(row.draftUpdatedAt, body.draft_updated_at)) {
        throw new BusinessError("conflict", CHANGED_ELSEWHERE, 409, { reason: "changed_elsewhere" });
      }
      const parsed = DraftSchema.safeParse(row.draft);
      if (!parsed.success) throw new BusinessError("validation_failed", "This draft is damaged. Open it and save it again.", 400);
      const draft = parsed.data as TemplateDraft;

      const others = await tx
        .select()
        .from(inboxTemplate)
        .where(and(eq(inboxTemplate.wabaId, row.wabaId), ne(inboxTemplate.status, "DELETED"), ne(inboxTemplate.id, row.id)));
      const problems: DraftProblem[] = validateDraft(draft, {
        name: row.name,
        others: others.map((o) => ({ name: o.name, ...textOf(o) })),
      });
      if (problems.some((p) => p.level === "error")) {
        throw new BusinessError("validation_failed", "Fix the problems marked in red first.", 400, { reason: "validation_failed", problems });
      }
      if (problems.length > 0 && !body.accept_warnings) {
        throw new BusinessError("validation_failed", "Read the warnings first, then tick the box to send anyway.", 400, { reason: "warnings", problems });
      }

      const flowKeys = await flowKeysMap(tx as unknown as DbClient);
      let mode: "create" | "edit";
      if (row.status === "DRAFT") mode = "create";
      else if (["APPROVED", "REJECTED", "PAUSED"].includes(row.status)) {
        const edit = templateEditability({ status: row.status, category: row.category, components: row.components, reviewInfo: row.reviewInfo, flowKeys });
        if (!edit.editable) throw new BusinessError("conflict", edit.reason ?? "This template cannot be changed.", 409, { reason: "not_editable" });
        if (!row.metaTemplateId) throw new BusinessError("conflict", SYNC_FIRST, 409);
        mode = "edit";
      } else {
        const edit = templateEditability({ status: row.status, category: row.category, components: row.components, reviewInfo: row.reviewInfo, flowKeys });
        throw new BusinessError("conflict", edit.reason ?? "This template cannot be changed in its current state.", 409, { reason: "not_editable" });
      }

      if (mode === "edit" && row.status === "APPROVED") {
        const times = row.metaEditTimes ?? [];
        const left = editsLeft(times, now);
        const next = nextEditAt(times, now);
        if (left.today === 0) {
          throw new BusinessError(
            "conflict",
            `WhatsApp allows one change a day to an approved template. Try again after ${next.day ? lagos(next.day, true) : "tomorrow"}.`,
            409,
            { reason: "edit_limit_day" },
          );
        }
        if (left.month === 0) {
          throw new BusinessError(
            "conflict",
            `WhatsApp allows 10 changes in 30 days to an approved template. The next one is possible on ${next.month ? lagos(next.month, false) : "a later date"}.`,
            409,
            { reason: "edit_limit_month" },
          );
        }
        if (draft.category !== row.category) {
          throw new BusinessError("validation_failed", "The type of an approved template cannot be changed. Make a new template instead.", 400, {
            reason: "category_locked",
          });
        }
      }
      if (draft.header && draft.header.format !== "TEXT" && !appIdOf(cfg)) {
        throw new BusinessError("service_unavailable", SAMPLE_NOT_SET_UP, 503);
      }
      // A form button (suite spec 07, 5.5a): the form must be one of ours and live on this account.
      const flows: Record<string, DraftFlowTarget> = {};
      for (const b of draft.buttons) {
        if (b.type !== "FLOW") continue;
        const def = flowDef(b.flowKey);
        const versions = def
          ? await tx
              .select()
              .from(waFlow)
              .where(and(eq(waFlow.wabaId, row.wabaId), eq(waFlow.key, def.key), eq(waFlow.status, "PUBLISHED"), isNotNull(waFlow.metaFlowId)))
              .orderBy(desc(waFlow.version))
              .limit(1)
          : [];
        const liveForm = versions[0];
        if (!def || !liveForm) {
          throw new BusinessError(
            "conflict",
            `The form behind the “${b.text.trim() || "form"}” button is not live at WhatsApp. Publish it under Forms first, or choose another form.`,
            409,
            { reason: "form_not_live" },
          );
        }
        flows[def.key] = { flowId: liveForm.metaFlowId!, action: def.usesEndpoint ? "data_exchange" : "navigate", screen: def.entryScreen };
      }

      // Step 7: mark the attempt.
      await tx.update(inboxTemplate).set({ submittedBy: userId, submittedAt: now, lastError: null }).where(eq(inboxTemplate.id, row.id));
      return { row, draft, mode, flows, flowKeys };
    });
    const { row, draft, mode, flows } = claim;

    const fail = async (err: unknown): Promise<never> => {
      const message = err instanceof MetaApiError ? explainTemplateError(err) : err instanceof BusinessError ? err.message : "Something went wrong on our side. Check the list in a minute before trying again.";
      await db.update(inboxTemplate).set({ lastError: message.slice(0, 1000) }).where(eq(inboxTemplate.id, row.id));
      await writeAudit(db, c, {
        action: "template.submit",
        entityType: "inbox_template",
        entityId: row.id,
        before: { name: row.name, language: row.language, status: row.status, category: row.category },
        after: { name: row.name, language: row.language, category: draft.category, mode, result: err instanceof MetaApiError && err.delivery === "unknown" ? "unknown" : "failed", error: message },
        notify: true,
      });
      if (err instanceof MetaApiError) throw await metaFailure(db, err);
      throw err;
    };

    // Steps 5 and 6: the heading sample goes to Meta again on every submit; build the components.
    let handle: string | null = null;
    let components: Record<string, unknown>[];
    let altComponents: Record<string, unknown>[] | undefined;
    try {
      if (draft.header && draft.header.format !== "TEXT") {
        const h = draft.header;
        const rule = TEMPLATE_SAMPLE_RULES[h.format];
        if (!(rule.types as readonly string[]).includes(h.sampleMime)) {
          throw new BusinessError("validation_failed", "Use a JPG or PNG picture, an MP4 video or a PDF.", 400);
        }
        const bytes = await templateDeps.loadSample(h.sampleKey);
        if (bytes.byteLength === 0 || bytes.byteLength > rule.maxBytes) {
          throw new BusinessError("validation_failed", `That sample is too big. Use ${rule.label}.`, 400);
        }
        if (sniffMime(bytes) !== h.sampleMime) throw new BusinessError("validation_failed", BAD_SAMPLE, 400);
        handle = await uploadFileToMeta(cfg, appIdOf(cfg)!, { bytes, mimeType: h.sampleMime, fileName: h.sampleName || "sample" });
      }
      components = draftToComponents(draft, handle, { flows });
      altComponents = blanksIn(draft.body.text).length > 0 ? draftToComponents(draft, handle, { flatBodyExamples: true, flows }) : undefined;
    } catch (err) {
      return fail(err);
    }

    // Steps 8 to 10: the one call that changes things at Meta.
    let answer: { id: string; status: string; category: string } | null = null;
    let notice: string | undefined;
    try {
      if (mode === "create") {
        try {
          answer = await createTemplate(cfg, row.wabaId, { name: row.name, language: row.language, category: draft.category, components, ...(altComponents ? { altComponents } : {}) });
        } catch (err) {
          // No answer: it may have been created. Look it up by name before saying anything (rule 9).
          if (!(err instanceof MetaApiError) || err.delivery !== "unknown") throw err;
          let found = null;
          try {
            found = await findTemplateByName(cfg, row.wabaId, row.name, row.language);
          } catch (lookup) {
            logger.warn({ err: lookup }, "template lookup after a timeout failed");
          }
          if (!found) throw err;
          answer = { id: String(found.id), status: String(found.status).toUpperCase(), category: String(found.category ?? draft.category).toUpperCase() };
        }
        const t = templateDeps.now();
        await db
          .update(inboxTemplate)
          .set({
            metaTemplateId: answer.id,
            status: answer.status,
            category: answer.category,
            components,
            parameterFormat: "POSITIONAL",
            statusChangedAt: t,
            syncedAt: t,
            draft: null,
            draftUpdatedAt: null,
            draftUpdatedBy: null,
            lastError: null,
          })
          .where(eq(inboxTemplate.id, row.id));
        if (answer.category !== draft.category) {
          notice = `WhatsApp filed this under ${templateCategoryLabel(answer.category)} instead of ${templateCategoryLabel(draft.category)}.`;
        }
        try {
          await applyMetaTemplate(db, row.wabaId, await getTemplate(cfg, answer.id), templateDeps.now());
        } catch (err) {
          logger.warn({ err, template: row.id }, "template read-back after create failed");
        }
      } else {
        const categoryChanged = row.status !== "APPROVED" && draft.category !== row.category;
        await editTemplate(cfg, row.metaTemplateId!, { components, ...(altComponents ? { altComponents } : {}), ...(categoryChanged ? { category: draft.category } : {}) });
        const t = templateDeps.now();
        const kept = (row.metaEditTimes ?? []).filter((x) => t.getTime() - Date.parse(x) < MONTH_MS);
        await db
          .update(inboxTemplate)
          .set({
            components,
            draft: null,
            draftUpdatedAt: null,
            draftUpdatedBy: null,
            lastError: null,
            syncedAt: t,
            ...(row.status === "APPROVED" ? { metaEditTimes: [...kept, t.toISOString()] } : {}),
          })
          .where(eq(inboxTemplate.id, row.id));
        try {
          await applyMetaTemplate(db, row.wabaId, await getTemplate(cfg, row.metaTemplateId!), templateDeps.now());
        } catch (err) {
          logger.warn({ err, template: row.id }, "template read-back after edit failed");
          await db.update(inboxTemplate).set({ status: "PENDING", statusChangedAt: t }).where(eq(inboxTemplate.id, row.id));
        }
      }
    } catch (err) {
      return fail(err);
    }

    const [after] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.id, row.id));
    await writeAudit(db, c, {
      action: "template.submit",
      entityType: "inbox_template",
      entityId: row.id,
      before: { name: row.name, language: row.language, status: row.status, category: row.category },
      after: {
        name: row.name,
        language: row.language,
        category: draft.category,
        mode,
        components,
        result: "sent",
        meta_answer: answer ? { id: answer.id, status: answer.status, category: answer.category } : { status: after?.status ?? null },
      },
      notify: true,
    });
    return c.json({ data: await dtoOf(db, row.id), ...(notice ? { notice } : {}) });
  });

  /** Delete a draft locally, or one language of a template at WhatsApp (spec 5.6). */
  r.post("/:id/delete", async (c) => {
    const row = await loadRow(db, c);
    const body = DeleteBody.parse(await c.req.json());
    if (body.confirm_name !== row.name) {
      throw new BusinessError("validation_failed", "Type the template's name exactly to delete it.", 400);
    }
    if (row.status === "DELETED") throw new BusinessError("conflict", "This template is already deleted.", 409);
    const now = templateDeps.now();
    const before = { name: row.name, language: row.language, status: row.status, category: row.category };

    if (row.status === "DRAFT") {
      await db.update(inboxTemplate).set({ status: "DELETED", draft: null, statusChangedAt: now, lastError: null }).where(eq(inboxTemplate.id, row.id));
      await writeAudit(db, c, {
        action: "template.delete",
        entityType: "inbox_template",
        entityId: row.id,
        before,
        after: { ...before, status: "DELETED", meta_call: false },
        notify: true,
      });
      return c.json({ data: await dtoOf(db, row.id) });
    }
    if (row.status === "DISABLED") {
      throw new BusinessError("conflict", "WhatsApp does not allow a switched-off template to be deleted.", 409);
    }

    const cfg = needCfg();
    let metaId = row.metaTemplateId;
    if (!metaId) {
      // An old row that was never re-synced: sync once, then look again.
      try {
        await syncTemplatesForWaba(db, cfg, row.wabaId, now);
      } catch (err) {
        throw await metaFailure(db, err);
      }
      metaId = (await loadRow(db, c)).metaTemplateId;
      if (!metaId) throw new BusinessError("conflict", SYNC_FIRST, 409);
    }
    try {
      await deleteTemplate(cfg, row.wabaId, { id: metaId, name: row.name });
    } catch (err) {
      const message = explainTemplateError(err);
      await db.update(inboxTemplate).set({ lastError: message.slice(0, 1000) }).where(eq(inboxTemplate.id, row.id));
      await writeAudit(db, c, {
        action: "template.delete",
        entityType: "inbox_template",
        entityId: row.id,
        before,
        after: { ...before, result: err instanceof MetaApiError && err.delivery === "unknown" ? "unknown" : "failed", error: message, meta_template_id: metaId },
        notify: true,
      });
      throw await metaFailure(db, err);
    }
    await db
      .update(inboxTemplate)
      .set({ status: "DELETED", draft: null, draftUpdatedAt: null, draftUpdatedBy: null, statusChangedAt: now, lastError: null })
      .where(eq(inboxTemplate.id, row.id));
    await writeAudit(db, c, {
      action: "template.delete",
      entityType: "inbox_template",
      entityId: row.id,
      before,
      after: { ...before, status: "DELETED", result: "deleted", meta_template_id: metaId },
      notify: true,
    });
    return c.json({ data: await dtoOf(db, row.id) });
  });

  return r;
}
