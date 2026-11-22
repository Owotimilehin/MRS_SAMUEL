/**
 * Broadcasts on WhatsApp (suite spec 14, Phase B, section 5.8). Mounted at /v1/broadcasts.
 *
 * One approved WhatsApp template sent to a list of contacts. Creating, testing, confirming,
 * resuming and cancelling need `broadcasts.send`, which only the owner holds by default.
 * Results are readable with `contacts.view`; pausing is also allowed with `contacts.manage`.
 *
 * Nothing here sends to customers by itself: confirm writes the recipient rows and the worker
 * sends them (apps/worker/src/jobs/broadcasts.ts). The owner switch is off by default, and
 * while it is off confirm and resume are refused (R40). The only Meta calls made here are
 * the test send, the header picture upload and the health reads, all through the shared
 * Graph helper in @ms/domain. No token is ever returned or logged.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  adminUser,
  appSetting,
  broadcast,
  broadcastEvent,
  broadcastRecipient,
  contactList,
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  type DbClient,
} from "@ms/db";
import {
  BroadcastRefusal,
  audienceListCount,
  broadcastCounts,
  broadcastFingerprint,
  broadcastLine,
  broadcastOrders,
  broadcastTemplate,
  cancelBroadcast,
  confirmBroadcast,
  conversationScope,
  currentFingerprint,
  dailyAllowance,
  draftAudience,
  getMmStatus,
  getNumberInfo,
  lineProblem,
  loadAccountBlocks,
  loadAudienceList,
  loadBroadcastSettings,
  loadViewer,
  metaConfigFromEnv,
  numberMessagingLimit,
  pauseBroadcast,
  resumeBroadcast,
  sendBroadcastTest,
  startDueBroadcasts,
  templateProblemFor,
  type BroadcastRow as BroadcastDbRow,
} from "@ms/domain";
import {
  BROADCAST_ACCOUNT_BLOCK_KEY,
  BROADCAST_HEADER_MIMES,
  BROADCAST_LIMITS,
  BROADCAST_META_STATE_KEY,
  BROADCAST_SETTINGS_KEY,
  BROADCAST_STATUSES,
  RECIPIENT_STATES,
  SKIP_REASONS,
  broadcastSettingsProblem,
  csvSafeCell,
  defaultBlanks,
  fillBlanks,
  firstName,
  plainFailure,
  previewText,
  readBlanks,
  readBroadcastSettings,
  skipReasonText,
  stopReasonText,
  templateBodyText,
  templateBroadcastUse,
  templateNeeds,
  usesName,
  withinSendingHours,
  type BroadcastAudience,
  type BroadcastBlanks,
  type BroadcastDetail,
  type BroadcastEventView,
  type BroadcastHealth,
  type BroadcastOptions,
  type BroadcastRecipientRow,
  type BroadcastResults,
  type BroadcastRow,
  type BroadcastSettings,
  type BroadcastSettingsView,
  type BroadcastStatus,
  type BroadcastWaiting,
  type RecipientState,
} from "@ms/shared";
import { requireAnyCapability, requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { toCsv } from "../lib/csv.js";
import { presignInboxGet, presignInboxPut } from "../lib/r2.js";

const Uuid = z.string().uuid();

async function defaultLoadHeader(key: string): Promise<Uint8Array> {
  const res = await fetch(await presignInboxGet(key, { expiresIn: 120 }));
  if (!res.ok) throw new BusinessError("conflict", "We could not read the picture. Choose it again.", 409);
  return new Uint8Array(await res.arrayBuffer());
}

/** Seams for tests: what time it is, and where a header picture's bytes come from. */
export const broadcastRouteDeps = {
  now: (): Date => new Date(),
  loadHeader: defaultLoadHeader as (key: string) => Promise<Uint8Array>,
};

function refuse(status: 400 | 403 | 404 | 409 | 422 | 429, message: string, details?: Record<string, unknown>): never {
  const code =
    status === 404 ? "not_found" : status === 403 ? "forbidden" : status === 409 ? "conflict" : status === 429 ? "rate_limited" : "validation_failed";
  throw new BusinessError(code, message, status, details);
}

/** A refusal from the engine, with its own words. */
function rethrow(err: unknown): never {
  if (err instanceof BroadcastRefusal) {
    refuse(err.status, err.message, { reason: err.code, ...(err.details ?? {}) });
  }
  throw err;
}

function notFound(): never {
  return refuse(404, "We couldn't find that broadcast.");
}

function uuidParam(c: Context, name: string): string {
  const v = c.req.param(name) ?? "";
  if (!Uuid.safeParse(v).success) notFound();
  return v;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) refuse(400, "Some of the details are missing or not right.", { issues: r.error.issues.map((i) => i.path.join(".")) });
  return r.data;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// ── Schemas ─────────────────────────────────────────────────────────────────

const Hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const SettingsBody = z
  .object({
    enabled: z.boolean(),
    send_from: Hhmm,
    send_until: Hhmm,
    rate_per_minute: z.number().int(),
    min_days_between: z.number().int(),
    attribution_days: z.number().int(),
    audience_rule: z.enum(["consent_only", "consent_or_recent_customer"]),
    recent_customer_months: z.number().int(),
    daily_share: z.number(),
    route: z.enum(["cloud", "mm"]),
    confirm_enable: z.boolean().optional(),
    confirm_legal: z.boolean().optional(),
    clear_account_block: z.boolean().optional(),
  })
  .strict();

const BlankSourceSchema = z.union([
  z.object({ from: z.enum(["first_name", "full_name"]), fallback: z.string().max(200) }).strict(),
  z.object({ from: z.literal("fixed"), text: z.string().max(200) }).strict(),
]);
const BlanksSchema = z
  .object({
    body: z.array(BlankSourceSchema).max(20),
    header: BlankSourceSchema.optional(),
    buttons: z.array(z.object({ index: z.number().int().min(0).max(10), text: z.string().max(200) }).strict()).max(10).optional(),
  })
  .strict();

const CreateBody = z
  .object({ name: z.string().trim().min(1).max(BROADCAST_LIMITS.name), phone_number_id: Uuid, list_id: Uuid, template_id: Uuid })
  .strict();
const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(BROADCAST_LIMITS.name).optional(),
    list_id: Uuid.optional(),
    template_id: Uuid.optional(),
    phone_number_id: Uuid.optional(),
    blanks: BlanksSchema.optional(),
    scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

// ── Reading ─────────────────────────────────────────────────────────────────

async function namesOf(db: DbClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const real = [...new Set(ids.filter((x): x is string => !!x))];
  if (!real.length) return new Map();
  const rows = await db.select({ id: adminUser.id, name: adminUser.name, email: adminUser.email }).from(adminUser).where(inArray(adminUser.id, real));
  return new Map(rows.map((r) => [r.id, r.name?.trim() || r.email]));
}

async function linesOf(db: DbClient, ids: string[]): Promise<Map<string, string>> {
  const real = [...new Set(ids)];
  if (!real.length) return new Map();
  const rows = await db.select({ id: inboxPhoneNumber.id, label: inboxPhoneNumber.label }).from(inboxPhoneNumber).where(inArray(inboxPhoneNumber.id, real));
  return new Map(rows.map((r) => [r.id, r.label]));
}

async function toRows(db: DbClient, list: BroadcastDbRow[]): Promise<BroadcastRow[]> {
  const counts = await broadcastCounts(db, list.map((b) => b.id));
  const names = await namesOf(db, list.map((b) => b.confirmedBy));
  const lines = await linesOf(db, list.map((b) => b.phoneNumberId));
  const tplIds = list.map((b) => b.templateId).filter((x): x is string => !!x);
  const tpls = tplIds.length
    ? await db.select({ id: inboxTemplate.id, name: inboxTemplate.name, category: inboxTemplate.category }).from(inboxTemplate).where(inArray(inboxTemplate.id, tplIds))
    : [];
  const tplMap = new Map(tpls.map((t) => [t.id, t]));
  const listIds = list.map((b) => b.listId).filter((x): x is string => !!x);
  const lists = listIds.length ? await db.select({ id: contactList.id, name: contactList.name }).from(contactList).where(inArray(contactList.id, listIds)) : [];
  const listMap = new Map(lists.map((l) => [l.id, l.name]));
  return list.map((b) => {
    const c = counts.get(b.id);
    const t = b.templateId ? tplMap.get(b.templateId) : undefined;
    return {
      id: b.id,
      name: b.name,
      status: b.status as BroadcastStatus,
      stop_reason: b.stopReason,
      stop_text: b.stopReason ? stopReasonText(b.stopReason) : null,
      list_name: b.listName ?? (b.listId ? (listMap.get(b.listId) ?? null) : null),
      template_name: b.templateName ?? t?.name ?? null,
      template_category: b.templateCategory ?? t?.category?.toUpperCase() ?? null,
      line_label: lines.get(b.phoneNumberId) ?? null,
      scheduled_at: iso(b.scheduledAt),
      started_at: iso(b.startedAt),
      finished_at: iso(b.finishedAt),
      created_at: b.createdAt.toISOString(),
      confirmed_count: b.confirmedCount,
      confirmed_at: iso(b.confirmedAt),
      confirmed_by_name: b.confirmedBy ? (names.get(b.confirmedBy) ?? null) : null,
      counts: {
        waiting: c?.waiting ?? 0,
        sent: c?.sent ?? 0,
        delivered: c?.delivered ?? 0,
        read: c?.read ?? 0,
        replied: c?.replied ?? 0,
        failed: c?.failed ?? 0,
        unknown: c?.unknown ?? 0,
        skipped: c?.skipped ?? 0,
        opted_out: c?.opted_out ?? 0,
      },
    };
  });
}

async function eventsOf(db: DbClient, id: string, limit = 50): Promise<BroadcastEventView[]> {
  const rows = await db.select().from(broadcastEvent).where(eq(broadcastEvent.broadcastId, id)).orderBy(desc(broadcastEvent.at)).limit(limit);
  const names = await namesOf(db, rows.map((r) => r.userId));
  return rows.map((r) => ({ kind: r.kind, detail: r.detail, by_name: r.userId ? (names.get(r.userId) ?? null) : null, at: r.at.toISOString() }));
}

/** The first active WhatsApp line, or the one asked for. */
async function settingsLine(db: DbClient, lineId: string | undefined) {
  if (lineId && Uuid.safeParse(lineId).success) return broadcastLine(db, lineId);
  const [l] = await db
    .select()
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.kind, "phone"), eq(inboxPhoneNumber.isActive, true), sql`${inboxPhoneNumber.waPhoneNumberId} IS NOT NULL`, sql`${inboxPhoneNumber.channels} <> 'voice'`))
    .orderBy(asc(inboxPhoneNumber.createdAt))
    .limit(1);
  return l ?? null;
}

type MetaState = { wabas?: Record<string, { mm_status: "ELIGIBLE" | "ONBOARDED" | null; checked_at: string }> };

async function loadMetaState(db: DbClient): Promise<MetaState> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, BROADCAST_META_STATE_KEY));
  return (row?.value as MetaState | undefined) ?? {};
}

async function saveMmStatus(db: DbClient, wabaId: string, mm: "ELIGIBLE" | "ONBOARDED" | null, now: Date): Promise<void> {
  const state = await loadMetaState(db);
  const value = { ...state, wabas: { ...(state.wabas ?? {}), [wabaId]: { mm_status: mm, checked_at: now.toISOString() } } };
  await db.insert(appSetting).values({ key: BROADCAST_META_STATE_KEY, value }).onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: now } });
}

function canFor(status: string, caps: readonly string[]) {
  const S = caps.includes("broadcasts.send");
  const M = caps.includes("contacts.manage");
  return {
    edit: S && status === "draft",
    test: S && status === "draft",
    confirm: S && status === "draft",
    pause: (S || M) && (status === "sending" || status === "scheduled"),
    resume: S && (status === "paused" || status === "stopped"),
    cancel: S && ["scheduled", "sending", "paused", "stopped"].includes(status),
    delete: S && status === "draft",
  };
}

export function broadcastRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  const S = requireCapability("broadcasts.send");
  const V = requireCapability("contacts.view");

  const audit = (c: Context, action: string, entityId: string, after?: unknown, before?: unknown, notify = false) =>
    writeAudit(db, c, { action, entityType: "broadcast", entityId, after, before, notify });

  const load = async (id: string) => {
    const [b] = await db.select().from(broadcast).where(eq(broadcast.id, id));
    if (!b) notFound();
    return b;
  };

  // ── Settings ───────────────────────────────────────────────────────────────

  const settingsView = async (lineId?: string): Promise<BroadcastSettingsView> => {
    const now = broadcastRouteDeps.now();
    const s = await loadBroadcastSettings(db);
    const line = await settingsLine(db, lineId);
    const limit = line ? await dailyAllowance(db, line.id, s, now) : null;
    const state = await loadMetaState(db);
    const blocks = await loadAccountBlocks(db);
    const block = line?.wabaId ? (blocks[line.wabaId] ?? null) : (Object.values(blocks)[0] ?? null);
    return {
      ...s,
      limit: limit ? { tier: limit.tier, per_day: limit.perDay, used_24h: limit.used24h, left_today: limit.leftToday } : null,
      quality_rating: line?.qualityRating ?? null,
      mm_status: line?.wabaId ? (state.wabas?.[line.wabaId]?.mm_status ?? null) : null,
      account_block: block,
    };
  };

  r.get("/settings", V, async (c) => c.json({ data: await settingsView(c.req.query("line_id")) }));

  r.put("/settings", S, async (c) => {
    const body = parse(SettingsBody, await jsonBody(c));
    const now = broadcastRouteDeps.now();
    const before = await loadBroadcastSettings(db);
    const { confirm_enable, confirm_legal, clear_account_block, ...rest } = body;
    const next: BroadcastSettings = rest;
    const problem = broadcastSettingsProblem(next);
    if (problem) refuse(422, problem);
    if (next.enabled && !before.enabled && confirm_enable !== true) {
      refuse(409, "Confirm that you want to switch broadcasts on.", { reason: "confirm_enable" });
    }
    if (next.audience_rule !== "consent_only" && before.audience_rule === "consent_only" && confirm_legal !== true) {
      refuse(409, "Tick “I have checked this is allowed” first.", { reason: "confirm_legal" });
    }
    if (next.route === "mm" && before.route !== "mm") {
      const line = await settingsLine(db, undefined);
      const cfg = metaConfigFromEnv();
      const mm = cfg && line?.wabaId ? await getMmStatus(cfg, line.wabaId) : null;
      if (line?.wabaId) await saveMmStatus(db, line.wabaId, mm, now);
      if (mm !== "ONBOARDED") refuse(409, "Meta has not switched on its marketing route for this account yet.");
    }
    const value = readBroadcastSettings(next);
    await db
      .insert(appSetting)
      .values({ key: BROADCAST_SETTINGS_KEY, value, updatedBy: c.get("auth").userId })
      .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: now, updatedBy: c.get("auth").userId } });
    let cleared = false;
    if (clear_account_block === true) {
      const blocks = await loadAccountBlocks(db);
      if (Object.keys(blocks).length) {
        await db.delete(appSetting).where(eq(appSetting.key, BROADCAST_ACCOUNT_BLOCK_KEY));
        cleared = true;
      }
    }
    // Switching off is an emergency stop for everything (R40): anything scheduled or sending stops now.
    if (!value.enabled && before.enabled) await startDueBroadcasts(db, now);
    await audit(
      c,
      "broadcasts.settings",
      "settings",
      { ...value, ...(cleared ? { account_block_cleared: true } : {}), name: value.enabled ? "Broadcast settings (switched on)" : "Broadcast settings (switched off)" },
      before,
      true,
    );
    return c.json({ data: await settingsView() });
  });

  // ── Options for the editor ─────────────────────────────────────────────────

  r.get("/options", S, async (c) => {
    const now = broadcastRouteDeps.now();
    const lineRows = await db
      .select()
      .from(inboxPhoneNumber)
      .where(and(eq(inboxPhoneNumber.kind, "phone"), eq(inboxPhoneNumber.isActive, true), sql`${inboxPhoneNumber.waPhoneNumberId} IS NOT NULL`, sql`${inboxPhoneNumber.channels} <> 'voice'`))
      .orderBy(asc(inboxPhoneNumber.createdAt));
    const wabas = [...new Set(lineRows.map((l) => l.wabaId).filter((x): x is string => !!x))];
    const tpls = wabas.length
      ? await db
          .select()
          .from(inboxTemplate)
          .where(and(inArray(inboxTemplate.wabaId, wabas), sql`upper(${inboxTemplate.status}) = 'APPROVED'`, sql`upper(coalesce(${inboxTemplate.category}, '')) IN ('MARKETING','UTILITY')`))
          .orderBy(asc(inboxTemplate.name))
      : [];
    const lists = await db.select().from(contactList).where(isNull(contactList.archivedAt)).orderBy(asc(contactList.name));
    const listOut: BroadcastOptions["lists"] = [];
    for (const l of lists) {
      const al = await loadAudienceList(db, l.id);
      listOut.push({ id: l.id, name: l.name, kind: l.kind === "smart" ? "smart" : "static", count: al ? await audienceListCount(db, al, now) : 0 });
    }
    const [me] = await db.select({ phone: adminUser.phone }).from(adminUser).where(eq(adminUser.id, c.get("auth").userId));
    const out: BroadcastOptions = {
      lines: lineRows.map((l) => ({ id: l.id, label: l.label, e164: l.e164 ?? null, quality_rating: l.qualityRating, waba_id: l.wabaId })),
      templates: tpls.map((t) => {
        const use = templateBroadcastUse({
          status: t.status,
          category: t.category,
          components: t.components as unknown[] | null,
          qualityScore: t.qualityScore,
          reviewInfo: (t.reviewInfo as { pause?: unknown } | null) ?? null,
        });
        return {
          id: t.id,
          waba_id: t.wabaId,
          name: t.name,
          language: t.language,
          category: t.category?.toUpperCase() ?? null,
          quality_score: t.qualityScore,
          body_text: templateBodyText(t.components as unknown[] | null),
          components: (t.components as unknown[] | null) ?? [],
          needs: use.needs,
          has_stop_wording: use.has_stop_wording,
          usable: use.usable,
          why_not: use.why_not,
        };
      }),
      lists: listOut,
      my_phone: me?.phone ?? null,
    };
    return c.json({ data: out });
  });

  // ── Health (reads Meta now; never throws) ──────────────────────────────────

  r.get("/health", S, async (c) => {
    const now = broadcastRouteDeps.now();
    const out: BroadcastHealth = { tier: null, quality_rating: null, status: null, mm_status: null, problems: [] };
    const line = await settingsLine(db, c.req.query("line_id"));
    const cfg = metaConfigFromEnv();
    if (!line) {
      out.problems.push({ code: "no_line", plain: "there is no WhatsApp number set up" });
      return c.json({ data: out });
    }
    if (!cfg) {
      out.problems.push({ code: "not_configured", plain: "WhatsApp is not configured on this server" });
      return c.json({ data: out });
    }
    try {
      const info = await getNumberInfo(cfg, line.waPhoneNumberId!);
      out.tier = numberMessagingLimit(info);
      out.quality_rating = info.quality_rating ?? null;
      out.status = info.status ?? null;
      await db
        .update(inboxPhoneNumber)
        .set({
          ...(info.quality_rating ? { qualityRating: info.quality_rating } : {}),
          ...(out.tier ? { messagingLimit: out.tier } : {}),
          updatedAt: now,
        })
        .where(eq(inboxPhoneNumber.id, line.id));
    } catch {
      out.problems.push({ code: "meta_unreachable", plain: "Meta did not answer when we asked about the number" });
    }
    if (line.wabaId) {
      out.mm_status = await getMmStatus(cfg, line.wabaId);
      await saveMmStatus(db, line.wabaId, out.mm_status, now);
      const block = (await loadAccountBlocks(db))[line.wabaId];
      if (block) out.problems.push({ code: "account", plain: "WhatsApp has restricted the business account" });
    }
    if ((out.quality_rating ?? "").toUpperCase() === "RED") out.problems.push({ code: "quality", plain: "the number's quality rating is low" });
    const st = (out.status ?? "").toUpperCase();
    if (st === "FLAGGED" || st === "RESTRICTED") out.problems.push({ code: "status", plain: `the number is ${st.toLowerCase()}` });
    return c.json({ data: out });
  });

  // ── The list of broadcasts ─────────────────────────────────────────────────

  r.get("/", V, async (c) => {
    const status = c.req.query("status");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const before = c.req.query("before");
    const conds: SQL[] = [];
    if (status) {
      if (!(BROADCAST_STATUSES as readonly string[]).includes(status)) refuse(400, "Unknown status.");
      conds.push(eq(broadcast.status, status));
    }
    if (before) {
      const t = Date.parse(before);
      if (Number.isNaN(t)) refuse(400, "Bad cursor.");
      conds.push(lt(broadcast.createdAt, new Date(t)));
    }
    const rows = await db
      .select()
      .from(broadcast)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(broadcast.createdAt))
      .limit(limit);
    return c.json({ data: await toRows(db, rows) });
  });

  // ── Create and change a draft ──────────────────────────────────────────────

  r.post("/", S, async (c) => {
    const body = parse(CreateBody, await jsonBody(c));
    const now = broadcastRouteDeps.now();
    const line = await broadcastLine(db, body.phone_number_id);
    const lp = lineProblem(line);
    if (lp) refuse(422, lp);
    const list = await loadAudienceList(db, body.list_id);
    if (!list || list.archivedAt) refuse(422, "Pick a list.");
    const t = await broadcastTemplate(db, { templateId: body.template_id });
    if (!t) refuse(422, "Pick a template.");
    const blanks = defaultBlanks(templateNeeds(t.components as unknown[] | null, t.category));
    const fingerprint = broadcastFingerprint({ templateId: t.id, components: t.components, blanks, headerMediaKey: null, phoneNumberId: line!.id });
    const [row] = await db
      .insert(broadcast)
      .values({
        name: body.name,
        phoneNumberId: line!.id,
        templateId: t.id,
        listId: list.id,
        blanks: blanks as unknown as Record<string, unknown>,
        fingerprint,
        createdBy: c.get("auth").userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit(c, "broadcasts.create", row!.id, { name: row!.name, list: list.name, template: t.name });
    return c.json({ data: await detail(c, row!) }, 201);
  });

  const detail = async (c: Context, b: BroadcastDbRow): Promise<BroadcastDetail> => {
    const now = broadcastRouteDeps.now();
    const s = await loadBroadcastSettings(db);
    const [row] = await toRows(db, [b]);
    const t = await broadcastTemplate(db, b);
    const line = await broadcastLine(db, b.phoneNumberId);
    const blanks = readBlanks(b.blanks);
    const needs = t ? templateNeeds(t.components as unknown[] | null, t.category) : null;
    const fp = currentFingerprint(b, t);
    let testMsgStatus: string | null = null;
    if (b.testMessageId) {
      const [m] = await db.select({ status: inboxMessage.status }).from(inboxMessage).where(eq(inboxMessage.id, b.testMessageId));
      testMsgStatus = m?.status ?? null;
    }
    let waiting: BroadcastWaiting = null;
    if (b.status === "sending") {
      if (!withinSendingHours(now, s)) waiting = "hours";
      else if (b.warmupUntil && b.warmupUntil > now) waiting = "warmup";
      else if (b.waitUntil && b.waitUntil > now) waiting = "slow_down";
      else if ((await dailyAllowance(db, b.phoneNumberId, s, now)).leftToday <= 0) waiting = "limit";
    }
    return {
      ...row!,
      phone_number_id: b.phoneNumberId,
      list_id: b.listId,
      template_id: b.templateId,
      template_language: b.templateLanguage ?? t?.language ?? null,
      stop_detail: b.stopDetail,
      blanks,
      preview_text: t ? previewText(t.components as unknown[] | null, fillBlanks(blanks, { name: null })) : "",
      needs,
      template_components: (t?.components as unknown[] | null) ?? null,
      template_why_not: b.status === "draft" ? templateProblemFor(t, line) : null,
      header_media: b.headerMediaKey ? { key: b.headerMediaKey, mime: b.headerMediaMime } : null,
      test: b.testSentAt
        ? {
            to: b.testTo,
            sent_at: iso(b.testSentAt),
            status: testMsgStatus,
            matches: b.testFingerprint === fp,
            fresh: now.getTime() - b.testSentAt.getTime() <= BROADCAST_LIMITS.testValidHours * 3600_000,
          }
        : null,
      can: canFor(b.status, c.get("auth").capabilities),
      waiting,
      send_from: s.send_from,
      send_until: s.send_until,
      rate_per_minute: s.rate_per_minute,
      enabled: s.enabled,
      events: await eventsOf(db, b.id),
    };
  };

  r.get("/:id", V, async (c) => c.json({ data: await detail(c, await load(uuidParam(c, "id"))) }));

  r.patch("/:id", S, async (c) => {
    const id = uuidParam(c, "id");
    const body = parse(PatchBody, await jsonBody(c));
    const b = await load(id);
    if (b.status !== "draft") refuse(409, "This broadcast can no longer be changed.");
    const now = broadcastRouteDeps.now();
    const patch: Partial<typeof broadcast.$inferInsert> = { updatedAt: now };
    if (body.name !== undefined) patch.name = body.name;
    if (body.phone_number_id !== undefined) {
      const lp = lineProblem(await broadcastLine(db, body.phone_number_id));
      if (lp) refuse(422, lp);
      patch.phoneNumberId = body.phone_number_id;
    }
    if (body.list_id !== undefined) {
      const list = await loadAudienceList(db, body.list_id);
      if (!list || list.archivedAt) refuse(422, "Pick a list.");
      patch.listId = list.id;
    }
    let blanks: BroadcastBlanks = readBlanks(b.blanks);
    let templateId = b.templateId;
    if (body.template_id !== undefined && body.template_id !== b.templateId) {
      const t = await broadcastTemplate(db, { templateId: body.template_id });
      if (!t) refuse(422, "Pick a template.");
      templateId = t.id;
      patch.templateId = t.id;
      blanks = defaultBlanks(templateNeeds(t.components as unknown[] | null, t.category));
      // A new template starts with no picture of the old one.
      patch.headerMediaKey = null;
      patch.headerMediaMime = null;
      patch.headerMediaId = null;
      patch.headerMediaUploadedAt = null;
    }
    if (body.blanks !== undefined) blanks = readBlanks(body.blanks);
    patch.blanks = blanks as unknown as Record<string, unknown>;
    if (body.scheduled_at !== undefined) patch.scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
    const merged = { ...b, ...patch } as BroadcastDbRow;
    const t = await broadcastTemplate(db, { templateId });
    patch.fingerprint = currentFingerprint(merged, t);
    const [row] = await db.update(broadcast).set(patch).where(and(eq(broadcast.id, id), eq(broadcast.status, "draft"))).returning();
    if (!row) refuse(409, "This broadcast can no longer be changed.");
    await audit(c, "broadcasts.update", id, { changed: Object.keys(body) });
    return c.json({ data: await detail(c, row) });
  });

  r.post("/:id/header-upload", S, async (c) => {
    const id = uuidParam(c, "id");
    const body = parse(z.object({ mime: z.string(), size_bytes: z.number().int() }).strict(), await jsonBody(c));
    const b = await load(id);
    if (b.status !== "draft") refuse(409, "This broadcast can no longer be changed.");
    const t = await broadcastTemplate(db, b);
    const needs = t ? templateNeeds(t.components as unknown[] | null, t.category) : null;
    if (needs?.headerMedia !== "image") refuse(422, "This template has no picture heading.");
    if (!(BROADCAST_HEADER_MIMES as readonly string[]).includes(body.mime)) refuse(422, "Choose a JPG or PNG picture.");
    if (body.size_bytes <= 0 || body.size_bytes > BROADCAST_LIMITS.headerMaxBytes) refuse(422, "The picture must be 5 MB or smaller.");
    const put = await presignInboxPut({ filename: body.mime === "image/png" ? "header.png" : "header.jpg", contentType: body.mime, sizeBytes: body.size_bytes });
    const merged = { ...b, headerMediaKey: put.object_key } as BroadcastDbRow;
    await db
      .update(broadcast)
      .set({
        headerMediaKey: put.object_key,
        headerMediaMime: body.mime,
        headerMediaId: null,
        headerMediaUploadedAt: null,
        fingerprint: currentFingerprint(merged, t),
        updatedAt: broadcastRouteDeps.now(),
      })
      .where(eq(broadcast.id, id));
    return c.json({ data: { upload_url: put.upload_url, media_key: put.object_key } });
  });

  // ── Who will get it (never writes) ─────────────────────────────────────────

  r.get("/:id/audience", S, async (c) => {
    const id = uuidParam(c, "id");
    const b = await load(id);
    const now = broadcastRouteDeps.now();
    const s = await loadBroadcastSettings(db);
    const t = await broadcastTemplate(db, b);
    let aud;
    try {
      aud = await draftAudience(db, b, t, s, now);
    } catch (err) {
      rethrow(err);
    }
    const group = c.req.query("group") ?? "will_send";
    if (group !== "will_send" && !(SKIP_REASONS as readonly string[]).includes(group)) refuse(400, "Unknown group.");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const start = Math.max(0, Number(c.req.query("cursor") ?? 0) || 0);
    const inGroup = aud.rows.filter((x) => (group === "will_send" ? x.reason === null : x.reason === group));
    const page = inGroup.slice(start, start + limit);
    const skipped: Record<string, number> = {};
    for (const x of aud.rows) if (x.reason) skipped[x.reason] = (skipped[x.reason] ?? 0) + 1;
    const blanks = readBlanks(b.blanks);
    const out: BroadcastAudience = {
      counts: { list: aud.listCount, will_send: aud.willSend, skipped },
      estimate: {
        per_day: aud.allowance.perDay,
        days: Number.isFinite(aud.days) ? aud.days : 999,
        first_day: Math.min(aud.willSend, aud.allowance.leftToday),
      },
      no_name: usesName(blanks) ? aud.rows.filter((x) => x.reason === null && firstName(x.name) === null).length : 0,
      gap_days: s.min_days_between,
      people: page.map((x) => ({ customer_id: x.customerId, name: x.name, phone: x.phone, reason: x.reason })),
      next_cursor: start + limit < inGroup.length ? String(start + limit) : null,
    };
    return c.json({ data: out });
  });

  // ── Test, confirm, pause, resume, cancel ───────────────────────────────────

  r.post("/:id/test", S, async (c) => {
    const id = uuidParam(c, "id");
    const body = parse(z.object({ to: z.string().trim().min(1).max(40) }).strict(), await jsonBody(c));
    const b = await load(id);
    const key = b.headerMediaKey;
    let res;
    try {
      // The picture is read from storage only when Meta needs it again (ensureHeaderMedia decides).
      res = await sendBroadcastTest(
        db,
        metaConfigFromEnv(),
        id,
        { userId: c.get("auth").userId, to: body.to, ...(key ? { loadHeaderBytes: () => broadcastRouteDeps.loadHeader(key) } : {}) },
        broadcastRouteDeps.now(),
      );
    } catch (err) {
      rethrow(err);
    }
    await audit(c, "broadcasts.test", id, { to: res.to, message_id: res.message_id });
    return c.json({ data: { message_id: res.message_id, status: res.status } });
  });

  r.post("/:id/confirm", S, async (c) => {
    const id = uuidParam(c, "id");
    const body = parse(z.object({ confirm_count: z.number().int().min(0), when: z.enum(["now", "scheduled"]) }).strict(), await jsonBody(c));
    const b = await load(id);
    const key = b.headerMediaKey;
    let res;
    try {
      res = await confirmBroadcast(
        db,
        metaConfigFromEnv(),
        id,
        {
          userId: c.get("auth").userId,
          confirmCount: body.confirm_count,
          when: body.when,
          ...(key ? { loadHeaderBytes: () => broadcastRouteDeps.loadHeader(key) } : {}),
        },
        broadcastRouteDeps.now(),
      );
    } catch (err) {
      rethrow(err);
    }
    const after = await load(id);
    await audit(
      c,
      "broadcasts.confirm",
      id,
      {
        name: `Broadcast “${after.name}” confirmed for ${res.recipients} people`,
        count: res.recipients,
        skipped: res.skipped,
        list: after.listName,
        template: after.templateName,
        when: body.when === "now" ? "now" : iso(after.scheduledAt),
      },
      undefined,
      true,
    );
    return c.json({ data: res });
  });

  r.post("/:id/pause", requireAnyCapability("broadcasts.send", "contacts.manage"), async (c) => {
    const id = uuidParam(c, "id");
    await load(id);
    let res;
    try {
      res = await pauseBroadcast(db, id, c.get("auth").userId, broadcastRouteDeps.now());
    } catch (err) {
      rethrow(err);
    }
    await audit(c, "broadcasts.pause", id, res);
    return c.json({ data: res });
  });

  r.post("/:id/resume", S, async (c) => {
    const id = uuidParam(c, "id");
    const body = parse(z.object({ confirm_count: z.number().int().min(0) }).strict(), await jsonBody(c));
    const b = await load(id);
    let res;
    try {
      res = await resumeBroadcast(db, id, { userId: c.get("auth").userId, confirmCount: body.confirm_count }, broadcastRouteDeps.now());
    } catch (err) {
      rethrow(err);
    }
    await audit(c, "broadcasts.resume", id, { name: `Broadcast “${b.name}” resumed for ${body.confirm_count} people`, count: body.confirm_count }, undefined, true);
    return c.json({ data: res });
  });

  r.post("/:id/cancel", S, async (c) => {
    const id = uuidParam(c, "id");
    parse(z.object({ confirm: z.literal(true) }).strict(), await jsonBody(c));
    await load(id);
    let res;
    try {
      res = await cancelBroadcast(db, id, c.get("auth").userId, broadcastRouteDeps.now());
    } catch (err) {
      rethrow(err);
    }
    await audit(c, "broadcasts.cancel", id, res);
    return c.json({ data: res });
  });

  r.delete("/:id", S, async (c) => {
    const id = uuidParam(c, "id");
    const b = await load(id);
    if (b.status !== "draft") refuse(409, "Only a draft can be deleted.");
    const gone = await db.delete(broadcast).where(and(eq(broadcast.id, id), eq(broadcast.status, "draft"))).returning({ id: broadcast.id });
    if (!gone.length) refuse(409, "Only a draft can be deleted.");
    await audit(c, "broadcasts.delete", id, undefined, { name: b.name });
    return c.json({ data: { deleted: true } });
  });

  // ── Results ────────────────────────────────────────────────────────────────

  r.get("/:id/results", V, async (c) => {
    const id = uuidParam(c, "id");
    const b = await load(id);
    const s = await loadBroadcastSettings(db);
    const counts = (await broadcastCounts(db, [id])).get(id)!;
    const failures = (await db.execute(sql`
      SELECT error_code, count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = ${id}::uuid AND state = 'failed'
      GROUP BY error_code ORDER BY n DESC`)) as unknown as { error_code: string | null; n: number }[];
    const skipped = (await db.execute(sql`
      SELECT skip_reason, count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = ${id}::uuid AND state = 'skipped'
      GROUP BY skip_reason ORDER BY n DESC`)) as unknown as { skip_reason: string | null; n: number }[];
    const out: BroadcastResults = {
      counts,
      failures: failures.map((f) => ({ code: f.error_code, plain: plainFailure(f.error_code), count: Number(f.n) })),
      skipped: skipped.map((x) => ({ reason: x.skip_reason ?? "", plain: skipReasonText(x.skip_reason, s.min_days_between), count: Number(x.n) })),
      orders: await broadcastOrders(db, id, b.attributionDays),
      events: await eventsOf(db, id, 200),
    };
    return c.json({ data: out });
  });

  const recipientRows = async (c: Context, id: string, o: { state?: string; skipReason?: string; limit: number; cursor?: { at: Date; id: string } | null }) => {
    const auth = c.get("auth");
    const viewer = await loadViewer(db, auth.userId, auth.capabilities);
    const conds: SQL[] = [eq(broadcastRecipient.broadcastId, id)];
    if (o.state) conds.push(eq(broadcastRecipient.state, o.state));
    if (o.skipReason) conds.push(eq(broadcastRecipient.skipReason, o.skipReason));
    if (o.cursor) {
      conds.push(
        or(gt(broadcastRecipient.createdAt, o.cursor.at), and(eq(broadcastRecipient.createdAt, o.cursor.at), gt(broadcastRecipient.id, o.cursor.id)))!,
      );
    }
    return db
      .select({
        id: broadcastRecipient.id,
        customerId: broadcastRecipient.customerId,
        name: customer.name,
        phone: customer.phone,
        toWa: broadcastRecipient.toWa,
        state: broadcastRecipient.state,
        skipReason: broadcastRecipient.skipReason,
        errorCode: broadcastRecipient.errorCode,
        sentAt: broadcastRecipient.sentAt,
        deliveredAt: broadcastRecipient.deliveredAt,
        readAt: broadcastRecipient.readAt,
        repliedAt: broadcastRecipient.repliedAt,
        optedOutAt: broadcastRecipient.optedOutAt,
        createdAt: broadcastRecipient.createdAt,
        conversationId: inboxConversation.id,
      })
      .from(broadcastRecipient)
      .leftJoin(customer, eq(customer.id, broadcastRecipient.customerId))
      .leftJoin(inboxMessage, eq(inboxMessage.id, broadcastRecipient.messageId))
      .leftJoin(inboxConversation, and(eq(inboxConversation.id, inboxMessage.conversationId), conversationScope(viewer)))
      .where(and(...conds))
      .orderBy(asc(broadcastRecipient.createdAt), asc(broadcastRecipient.id))
      .limit(o.limit);
  };

  const plainReason = (state: string, skipReason: string | null, code: string | null, gap: number): string | null =>
    state === "skipped" ? skipReasonText(skipReason, gap) : state === "failed" ? plainFailure(code) : state === "unknown" ? "Not confirmed by WhatsApp" : null;

  r.get("/:id/recipients", V, async (c) => {
    const id = uuidParam(c, "id");
    await load(id);
    const s = await loadBroadcastSettings(db);
    const state = c.req.query("state");
    if (state && !(RECIPIENT_STATES as readonly string[]).includes(state)) refuse(400, "Unknown result.");
    const skipReason = c.req.query("skip_reason");
    if (skipReason && !(SKIP_REASONS as readonly string[]).includes(skipReason)) refuse(400, "Unknown reason.");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rawCursor = c.req.query("cursor");
    let cursor: { at: Date; id: string } | null = null;
    if (rawCursor) {
      const [at, rid] = rawCursor.split("|");
      if (!at || !rid || Number.isNaN(Date.parse(at)) || !Uuid.safeParse(rid).success) refuse(400, "Bad cursor.");
      cursor = { at: new Date(at), id: rid };
    }
    const rows = await recipientRows(c, id, { ...(state ? { state } : {}), ...(skipReason ? { skipReason } : {}), limit: limit + 1, cursor });
    const page = rows.slice(0, limit);
    const out: BroadcastRecipientRow[] = page.map((x) => ({
      id: x.id,
      customer_id: x.customerId,
      name: x.name,
      phone: x.phone ?? (x.toWa ? `+${x.toWa}` : null),
      state: x.state as RecipientState,
      skip_reason: x.skipReason,
      plain_reason: plainReason(x.state, x.skipReason, x.errorCode, s.min_days_between),
      sent_at: iso(x.sentAt),
      delivered_at: iso(x.deliveredAt),
      read_at: iso(x.readAt),
      replied_at: iso(x.repliedAt),
      opted_out_at: iso(x.optedOutAt),
      conversation_id: x.conversationId ?? null,
    }));
    const last = page[page.length - 1];
    return c.json({ data: { recipients: out, next_cursor: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null } });
  });

  r.get("/:id/recipients.csv", V, requireCapability("inbox.export"), async (c) => {
    const id = uuidParam(c, "id");
    const b = await load(id);
    const s = await loadBroadcastSettings(db);
    const lines: string[][] = [];
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const rows = await recipientRows(c, id, { limit: 1000, cursor });
      for (const x of rows) {
        lines.push(
          [
            x.name ?? "",
            x.phone ?? (x.toWa ? `+${x.toWa}` : ""),
            x.state,
            plainReason(x.state, x.skipReason, x.errorCode, s.min_days_between) ?? "",
            iso(x.sentAt) ?? "",
            iso(x.deliveredAt) ?? "",
            iso(x.readAt) ?? "",
            iso(x.repliedAt) ?? "",
            iso(x.optedOutAt) ?? "",
          ].map((v) => csvSafeCell(v)),
        );
      }
      if (rows.length < 1000) break;
      const last = rows[rows.length - 1]!;
      cursor = { at: last.createdAt, id: last.id };
    }
    await audit(c, "broadcasts.export", id, { rows: lines.length, name: `${lines.length} broadcast results downloaded (“${b.name}”)` });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="broadcast-results.csv"');
    c.header("cache-control", "no-store");
    return c.body(toCsv(["Name", "Phone", "Result", "Reason", "Sent", "Delivered", "Read", "Replied", "Asked to stop"], lines));
  });

  return r;
}
