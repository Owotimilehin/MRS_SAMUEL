/**
 * WhatsApp template authoring (suite spec 06, 5.2): the Meta calls, the one sync that replaces the
 * two older copies, the webhook handling and the plain-English error wording.
 *
 * Nothing here runs on its own to submit, edit or delete a template at Meta (foundation rule 7):
 * createTemplate, editTemplate and deleteTemplate are called only from a route a signed-in person
 * has confirmed. Sync, refresh and webhook handling only read what Meta already holds.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { inboxPhoneNumber, inboxTemplate, outboxEvent, type DbExecutor, type TemplateReviewInfo } from "@ms/db";
import { normaliseTemplateLanguage, type DraftCategory } from "@ms/shared";
import { graph, MetaApiError, type GraphOptions, type MetaConfig } from "../inbox/meta.js";

const WA: GraphOptions = { service: "WhatsApp" };

export const TEMPLATE_FIELDS =
  "id,name,language,status,category,components,quality_score,rejected_reason,parameter_format,correct_category,previous_category";
/** Used when Meta answers code 100 to the long list (a field it does not know). */
const OLD_TEMPLATE_FIELDS = "id,name,language,status,category,components";

export interface MetaTemplateFull {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown[];
  quality_score?: { score?: string; date?: number };
  rejected_reason?: string;
  parameter_format?: string;
  correct_category?: string;
  previous_category?: string;
}

export const TEMPLATE_WEBHOOK_FIELDS = [
  "message_template_status_update",
  "message_template_quality_update",
  "template_category_update",
] as const;

// ── Meta calls ───────────────────────────────────────────────────────────────

async function withFieldFallback<T>(run: (fields: string) => Promise<T>): Promise<T> {
  try {
    return await run(TEMPLATE_FIELDS);
  } catch (err) {
    if (err instanceof MetaApiError && err.code === "100") return run(OLD_TEMPLATE_FIELDS);
    throw err;
  }
}

/** Every template of one WhatsApp account, paged like listTemplates. */
export async function listTemplatesFull(cfg: MetaConfig, wabaId: string): Promise<MetaTemplateFull[]> {
  const listWith = async (fields: string): Promise<MetaTemplateFull[]> => {
    const out: MetaTemplateFull[] = [];
    let next: string | null = `${wabaId}/message_templates?limit=100&fields=${fields}`;
    for (let page = 0; next && page < 50; page++) {
      const res: { data?: MetaTemplateFull[]; paging?: { next?: string } } = await graph(cfg, "GET", next, undefined, WA);
      out.push(...(res.data ?? []));
      next = res.paging?.next ?? null;
    }
    return out;
  };
  return withFieldFallback(listWith);
}

export async function getTemplate(cfg: MetaConfig, templateId: string): Promise<MetaTemplateFull> {
  return withFieldFallback((fields) =>
    graph<MetaTemplateFull>(cfg, "GET", `${encodeURIComponent(templateId)}?fields=${fields}`, undefined, WA),
  );
}

/** Look one template up by name and language (used to settle a create that got no answer). */
export async function findTemplateByName(
  cfg: MetaConfig,
  wabaId: string,
  name: string,
  language: string,
): Promise<MetaTemplateFull | null> {
  const lang = normaliseTemplateLanguage(language);
  const found = await withFieldFallback(async (fields) => {
    const res = await graph<{ data?: MetaTemplateFull[] }>(
      cfg,
      "GET",
      `${wabaId}/message_templates?limit=100&name=${encodeURIComponent(name)}&fields=${fields}`,
      undefined,
      WA,
    );
    return res.data ?? [];
  });
  return found.find((t) => t.name === name && normaliseTemplateLanguage(t.language) === lang) ?? null;
}

/** Subcodes that mean "this exact request is refused", so a second try with another shape is pointless. */
const SETTLED_SUBCODES = new Set(["2388024", "2388019", "2388039", "2388040", "2388293", "2388299"]);

function worthSecondShape(err: unknown): boolean {
  return err instanceof MetaApiError && err.code === "100" && !(err.subcode && SETTLED_SUBCODES.has(err.subcode));
}

/**
 * Send a new template for review. `altComponents` is the same template with the other shape of
 * body examples; it is tried once when Meta answers code 100 (spec 3.3: the nesting is unverified).
 */
export async function createTemplate(
  cfg: MetaConfig,
  wabaId: string,
  t: { name: string; language: string; category: DraftCategory; components: unknown[]; altComponents?: unknown[] },
): Promise<{ id: string; status: string; category: string }> {
  const post = (components: unknown[]): Promise<{ id?: string | number; status?: string; category?: string }> =>
    graph(
      cfg,
      "POST",
      `${wabaId}/message_templates`,
      { name: t.name, language: t.language, category: t.category, parameter_format: "POSITIONAL", components },
      WA,
    );
  let res;
  try {
    res = await post(t.components);
  } catch (err) {
    if (!t.altComponents || !worthSecondShape(err)) throw err;
    res = await post(t.altComponents);
  }
  if (res.id === undefined || res.id === null || String(res.id) === "") {
    throw new MetaApiError("WhatsApp did not say whether it took the template", 502, null, true, "unknown");
  }
  return { id: String(res.id), status: String(res.status ?? "PENDING").toUpperCase(), category: String(res.category ?? t.category).toUpperCase() };
}

/** Replace a template's components (and, for a refused or paused one, its category). */
export async function editTemplate(
  cfg: MetaConfig,
  templateId: string,
  t: { components: unknown[]; altComponents?: unknown[]; category?: DraftCategory },
): Promise<void> {
  const post = (components: unknown[]): Promise<unknown> =>
    graph(cfg, "POST", encodeURIComponent(templateId), { components, ...(t.category ? { category: t.category } : {}) }, WA);
  try {
    await post(t.components);
  } catch (err) {
    if (!t.altComponents || !worthSecondShape(err)) throw err;
    await post(t.altComponents);
  }
}

/** Delete one language of one template (never every language of a name). */
export async function deleteTemplate(cfg: MetaConfig, wabaId: string, t: { id: string; name: string }): Promise<void> {
  await graph(
    cfg,
    "DELETE",
    `${wabaId}/message_templates?hsm_id=${encodeURIComponent(t.id)}&name=${encodeURIComponent(t.name)}`,
    undefined,
    WA,
  );
}

// ── Owner alerts ─────────────────────────────────────────────────────────────

export type TemplateAlertKind =
  | "rejected"
  | "paused"
  | "disabled"
  | "flagged"
  | "quality_red"
  | "category_notice"
  | "category_changed"
  | "approved_as_marketing"
  | "archived";

/**
 * One outbox_event for the owner (the case is in apps/worker/src/outbox.ts), skipped when the same
 * template and kind was alerted in the last 24 hours. Runs in the caller's transaction. `account` is
 * `<template id>:<kind>` so the event looks like every other alertOnce row.
 */
export async function raiseTemplateAlert(
  db: DbExecutor,
  row: { id: string; name: string; language: string; category: string | null; correctCategory: string | null },
  kind: TemplateAlertKind,
  extra: { reason?: string | null; recommendation?: string | null; at?: Date | null } = {},
): Promise<boolean> {
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.eventType, "inbox.template_alert"),
        sql`${outboxEvent.createdAt} > now() - interval '24 hours'`,
        sql`${outboxEvent.payload}->>'template_id' = ${row.id}`,
        sql`${outboxEvent.payload}->>'kind' = ${kind}`,
      ),
    )
    .limit(1);
  if (recent) return false;
  await db.insert(outboxEvent).values({
    eventType: "inbox.template_alert",
    payload: {
      account: `${row.id}:${kind}`,
      template_id: row.id,
      name: row.name,
      language: row.language,
      kind,
      detail: extra.reason ?? null,
      reason: extra.reason ?? null,
      recommendation: extra.recommendation ?? null,
      category: row.category,
      correct_category: row.correctCategory,
      at: extra.at ? extra.at.toISOString() : null,
    },
  });
  return true;
}

// ── Writing what Meta holds onto our rows ───────────────────────────────────

type Row = typeof inboxTemplate.$inferSelect;

function upper(v: string | null | undefined): string | null {
  return v ? v.toUpperCase() : null;
}

function cleanReview(info: TemplateReviewInfo | null, drop: (keyof TemplateReviewInfo)[]): TemplateReviewInfo | null {
  if (!info) return null;
  const next: TemplateReviewInfo = { ...info };
  for (const k of drop) delete next[k];
  return Object.keys(next).length > 0 ? next : null;
}

async function findRow(db: DbExecutor, wabaId: string, id: string | null, name: string | null, language: string | null): Promise<Row | null> {
  if (id) {
    const [byId] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.metaTemplateId, id));
    if (byId) return byId;
  }
  if (name && language) {
    const [byKey] = await db
      .select()
      .from(inboxTemplate)
      .where(and(eq(inboxTemplate.wabaId, wabaId), eq(inboxTemplate.name, name), eq(inboxTemplate.language, normaliseTemplateLanguage(language))));
    if (byKey) return byKey;
  }
  return null;
}

/**
 * Write one Meta template onto its row: match by Meta's id, else by (waba, name, language); insert when
 * there is none. A local DRAFT whose key Meta now has takes Meta's values and keeps its `draft` as
 * unsent changes. `draft` is never touched. Fields Meta did not send are left as they were.
 * A move into REJECTED, PAUSED or DISABLED raises the same owner alert the webhook would.
 * `listedAt` is when Meta's answer was asked for (the sync passes it): a row whose status changed
 * after that keeps its status, because the answer is older than the change.
 */
export async function applyMetaTemplate(db: DbExecutor, wabaId: string, t: MetaTemplateFull, now: Date, listedAt?: Date): Promise<void> {
  const language = normaliseTemplateLanguage(t.language);
  const row = await findRow(db, wabaId, String(t.id), t.name, language);
  let status = String(t.status).toUpperCase();
  const rejected = t.rejected_reason === undefined ? undefined : t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null;

  if (!row) {
    await db
      .insert(inboxTemplate)
      .values({
        wabaId,
        name: t.name,
        language,
        category: upper(t.category),
        status,
        components: t.components ?? [],
        metaTemplateId: String(t.id),
        parameterFormat: t.parameter_format ?? null,
        qualityScore: t.quality_score?.score ?? null,
        rejectedReason: rejected ?? null,
        correctCategory: upper(t.correct_category),
        previousCategory: upper(t.previous_category),
        statusChangedAt: now,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [inboxTemplate.wabaId, inboxTemplate.name, inboxTemplate.language],
        set: {
          status,
          category: upper(t.category),
          components: t.components ?? [],
          metaTemplateId: String(t.id),
          syncedAt: now,
        },
      });
    return;
  }
  if (listedAt && row.statusChangedAt !== null && row.statusChangedAt.getTime() > listedAt.getTime()) status = row.status;

  const set: Partial<typeof inboxTemplate.$inferInsert> = {
    status,
    components: t.components ?? row.components,
    metaTemplateId: String(t.id),
    syncedAt: now,
  };
  if (t.category !== undefined) set.category = upper(t.category);
  if (t.parameter_format !== undefined) set.parameterFormat = t.parameter_format;
  if (t.quality_score !== undefined) set.qualityScore = t.quality_score?.score ?? null;
  if (rejected !== undefined) set.rejectedReason = rejected;
  if (t.correct_category !== undefined) set.correctCategory = upper(t.correct_category);
  if (t.previous_category !== undefined) set.previousCategory = upper(t.previous_category);
  if (status !== row.status) set.statusChangedAt = now;
  if (status === "APPROVED") set.reviewInfo = cleanReview(row.reviewInfo, ["rejection", "pause", "flagged"]);

  await db.update(inboxTemplate).set(set).where(eq(inboxTemplate.id, row.id));

  // A real change of state found by sync or refresh (not a first sight of the row).
  if (status !== row.status && row.status !== "DRAFT") {
    const kind = status === "REJECTED" ? "rejected" : status === "PAUSED" ? "paused" : status === "DISABLED" ? "disabled" : null;
    if (kind) {
      await raiseTemplateAlert(
        db,
        { id: row.id, name: row.name, language: row.language, category: (set.category as string | null | undefined) ?? row.category, correctCategory: row.correctCategory },
        kind,
        { reason: kind === "rejected" ? rejected ?? null : null },
      );
    }
  }
}

/**
 * Upsert Meta's templates into inbox_template (replaces the copies in inbox.ts and the worker).
 * Rows of this account that Meta did not return are marked DELETED, except local drafts, rows already
 * DELETED and rows changed in the last five minutes (Meta's list can lag a just-sent template).
 * Returns how many templates Meta returned.
 */
export async function syncTemplatesForWaba(db: DbExecutor, cfg: MetaConfig, wabaId: string, now: Date = new Date()): Promise<number> {
  // `now` was taken before the list is fetched: a status that changed after it is newer than the list.
  const templates = await listTemplatesFull(cfg, wabaId);
  for (const t of templates) await applyMetaTemplate(db, wabaId, t, now, now);

  const ids = templates.map((t) => String(t.id));
  const keys = new Set(templates.map((t) => `${t.name}::${normaliseTemplateLanguage(t.language)}`));
  const existing = await db
    .select()
    .from(inboxTemplate)
    .where(and(eq(inboxTemplate.wabaId, wabaId), notInArray(inboxTemplate.status, ["DRAFT", "DELETED"])));
  const recent = now.getTime() - 5 * 60_000;
  const gone = existing
    .filter((e) => !keys.has(`${e.name}::${e.language}`) && !(e.metaTemplateId && ids.includes(e.metaTemplateId)))
    .filter((e) => !e.statusChangedAt || e.statusChangedAt.getTime() < recent)
    .map((e) => e.id);
  if (gone.length > 0) {
    await db.update(inboxTemplate).set({ status: "DELETED", statusChangedAt: now, syncedAt: now }).where(inArray(inboxTemplate.id, gone));
  }
  return templates.length;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
}

/**
 * Apply one template webhook change inside the webhook transaction. A template we do not hold (made
 * in WhatsApp Manager) answers `resync: true`: one sync of the account will bring it in. A local
 * DRAFT that Meta now knows by name is not changed either: sync adopts it with Meta's components.
 */
export async function applyTemplateWebhook(
  db: DbExecutor,
  wabaId: string,
  field: string,
  value: Record<string, unknown>,
  eventTime: Date,
): Promise<{ applied: boolean; resync: boolean }> {
  const id = s(value.message_template_id);
  const row = await findRow(db, wabaId, id, s(value.message_template_name), s(value.message_template_language));
  if (!row) return { applied: false, resync: true };
  if (row.status === "DRAFT" && !row.metaTemplateId) return { applied: false, resync: true };

  const set: Partial<typeof inboxTemplate.$inferInsert> = { syncedAt: eventTime };
  if (!row.metaTemplateId && id) set.metaTemplateId = id;
  let review: TemplateReviewInfo | null = row.reviewInfo;
  let kind: TemplateAlertKind | null = null;
  let resync = false;
  let reason: string | null = null;
  let recommendation: string | null = null;
  let at: Date | null = null;
  let category = row.category;
  let correctCategory = row.correctCategory;

  if (field === "message_template_status_update") {
    const event = String(value.event ?? "").toUpperCase();
    // Meta's event time is in whole seconds and our clock in milliseconds: an event in the same second is not stale.
    const stale = row.statusChangedAt !== null && Math.floor(row.statusChangedAt.getTime() / 1000) > Math.floor(eventTime.getTime() / 1000);
    const setStatus = (status: string): void => {
      if (stale) return;
      set.status = status;
      if (status !== row.status) set.statusChangedAt = eventTime;
    };
    switch (event) {
      case "APPROVED": {
        if (stale) break;
        setStatus("APPROVED");
        set.rejectedReason = null;
        review = cleanReview(review, ["rejection", "pause", "flagged", "locked"]);
        const filed = upper(s(value.message_template_category));
        if (filed && filed !== row.category) {
          set.previousCategory = row.category;
          set.category = filed;
          category = filed;
          if (filed === "MARKETING") kind = "approved_as_marketing";
        }
        break;
      }
      case "REJECTED": {
        if (stale) break;
        setStatus("REJECTED");
        const why = s(value.reason);
        reason = why && why !== "NONE" ? why : null;
        set.rejectedReason = reason;
        const info = rec(value.rejection_info);
        const rejection = info
          ? { ...(s(info.reason) ? { reason: s(info.reason)! } : {}), ...(s(info.recommendation) ? { recommendation: s(info.recommendation)! } : {}) }
          : reason
            ? { reason }
            : undefined;
        review = cleanReview(review, ["locked"]);
        if (rejection) review = { ...(review ?? {}), rejection };
        recommendation = info ? s(info.recommendation) : null;
        kind = "rejected";
        break;
      }
      case "PENDING":
        setStatus("PENDING");
        break;
      case "PAUSED": {
        if (stale) break;
        setStatus("PAUSED");
        const info = rec(value.other_info);
        review = { ...(review ?? {}), pause: { ...(s(info?.title) ? { title: s(info?.title)! } : {}), ...(s(info?.description) ? { description: s(info?.description)! } : {}) } };
        kind = "paused";
        break;
      }
      case "DISABLED": {
        if (stale) break;
        setStatus("DISABLED");
        const date = s(rec(value.disable_info)?.disable_date);
        review = { ...(review ?? {}), ...(date ? { disableDate: date } : {}) };
        kind = "disabled";
        break;
      }
      case "FLAGGED":
        review = { ...(review ?? {}), flagged: true };
        kind = "flagged";
        break;
      case "REINSTATED":
        if (stale) break;
        setStatus("APPROVED");
        review = cleanReview(review, ["flagged", "pause", "locked"]);
        break;
      case "LOCKED":
        review = { ...(review ?? {}), locked: true };
        break;
      case "IN_APPEAL":
      case "LIMIT_EXCEEDED":
      case "ARCHIVED":
      case "DELETED":
      case "PENDING_DELETION":
        setStatus(event);
        if (event === "ARCHIVED" && !stale) kind = "archived";
        break;
      default:
        // UNARCHIVED or an event we do not know: change nothing, let a sync read the truth.
        resync = true;
        delete (set as { syncedAt?: Date }).syncedAt;
    }
  } else if (field === "message_template_quality_update") {
    const next = upper(s(value.new_quality_score));
    if (next) {
      set.qualityScore = next;
      if (next === "RED") kind = "quality_red";
    }
  } else if (field === "template_category_update") {
    if (s(value.correct_category)) {
      correctCategory = upper(s(value.correct_category));
      set.correctCategory = correctCategory;
      const ts = Number(value.category_update_timestamp);
      at = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null;
      set.categoryChangeAt = at;
      kind = "category_notice";
    } else if (s(value.previous_category)) {
      category = upper(s(value.new_category)) ?? row.category;
      set.category = category;
      set.previousCategory = upper(s(value.previous_category));
      set.correctCategory = null;
      set.categoryChangeAt = null;
      correctCategory = null;
      kind = "category_changed";
    } else {
      resync = true;
    }
  } else {
    return { applied: false, resync: false };
  }

  if (review !== row.reviewInfo) set.reviewInfo = review;
  if (Object.keys(set).length > 0) await db.update(inboxTemplate).set(set).where(eq(inboxTemplate.id, row.id));
  if (kind) {
    await raiseTemplateAlert(db, { id: row.id, name: row.name, language: row.language, category, correctCategory }, kind, { reason, recommendation, at });
  }
  return { applied: !resync, resync };
}

// ── Wording for a refusal ────────────────────────────────────────────────────

const CONFIG_CODES = new Set(["190", "10", "200", "299", "283"]);

/** A Meta refusal that means the connection or its permissions need fixing (foundation D10 and C2). */
export function isTemplateConfigError(err: unknown): boolean {
  return err instanceof MetaApiError && err.code !== null && CONFIG_CODES.has(err.code);
}

const SUBCODE_TEXT: Record<string, string> = {
  "2388024": "A template with this name and language already exists at WhatsApp. Press Sync to bring it in, or choose another name.",
  "2388019": "You have reached WhatsApp's limit on the number of templates. Delete ones you do not use.",
  "2388039": "WhatsApp is reviewing this template and will not accept changes until it has decided.",
  "2388040": "One part is too long for WhatsApp.",
  "2388047": "WhatsApp did not accept the layout of the heading.",
  "2388072": "WhatsApp did not accept the layout of the message.",
  "2388073": "WhatsApp did not accept the layout of the small print.",
  "2388293": "Too many blanks for the length of the message. Add more fixed words.",
  "2388299": "The message cannot start or end with a blank.",
};

/** A plain-English sentence for a create, edit or delete refusal, with Meta's code kept in brackets for support. */
export function explainTemplateError(err: unknown): string {
  if (!(err instanceof MetaApiError)) return "Something went wrong on our side. Nothing was changed at WhatsApp.";
  const tag = err.code ? `Meta ${err.code}${err.subcode ? `/${err.subcode}` : ""}` : null;
  const keep = (sentence: string, withMessage = true): string => {
    const note = tag ? `${tag}${withMessage && err.message ? `: ${err.message.slice(0, 200)}` : ""}` : null;
    return note ? `${sentence} (${note})` : sentence;
  };
  if (err.subcode && SUBCODE_TEXT[err.subcode]) return keep(SUBCODE_TEXT[err.subcode]!);
  if (err.delivery === "unknown") {
    return "WhatsApp did not answer. Nothing was lost. Check the list in a minute before trying again.";
  }
  if (err.code === "80008" || err.retryable) return keep("WhatsApp is busy. Wait a few minutes and try again.");
  if (err.code && CONFIG_CODES.has(err.code)) {
    return keep("WhatsApp would not let us in. The connection needs fixing by the technical lead.");
  }
  const details = err.details as { userMessage?: unknown } | undefined;
  const own = typeof details?.userMessage === "string" && details.userMessage ? details.userMessage : err.message;
  return keep(`WhatsApp refused this: ${own}`, false);
}

/** Does this WhatsApp account belong to one of our numbers? (Events for others are ignored.) */
export async function wabaIsOurs(db: DbExecutor, wabaId: string): Promise<boolean> {
  const [n] = await db.select({ id: inboxPhoneNumber.id }).from(inboxPhoneNumber).where(eq(inboxPhoneNumber.wabaId, wabaId)).limit(1);
  return !!n;
}
