/**
 * Leads from Meta lead forms (suite spec 13).
 *
 * Seeing and working leads needs leads.view. Form set-up, the connection check,
 * "Fetch earlier leads" and "Try again" need channels.manage. Sending the
 * WhatsApp follow-up also needs inbox.templates.
 *
 * Rules kept here:
 *   - The follow-up is never automatic (foundation rule 7): a named person
 *     presses the button, confirms, and the send is written to the audit log.
 *     It is refused unless the lead agreed to WhatsApp contact (rule R18) and
 *     an approved "lead_followup" template exists.
 *   - The conversation behind a lead is governed only by canSeeConversation
 *     (foundation rule 6): its ID is null for a viewer who may not see it.
 *   - A Page token is never stored, logged or returned.
 *   - No database transaction is held open across a call to Meta.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { adminUser, customer, inboxConversation, inboxPhoneNumber, lead, leadForm, type DbClient } from "@ms/db";
import {
  InboxSendError,
  LEAD_FOLLOWUP_TEMPLATE,
  MetaApiError,
  approvedFollowUpTemplate,
  canSeeConversation,
  canUseNumber,
  classifyLeadError,
  describeLeadError,
  ensureLeadgenSubscribed,
  firstLeadPage,
  getPageSubscription,
  leadFollowUpBlock,
  leadLineFor,
  linkLeadConversation,
  listForms,
  loadViewer,
  metaConfigFromEnv,
  pageAccessToken,
  publishInboxEvent,
  renderTemplateBody,
  sendFromConversation,
  signalFor,
  syncLeadForms,
  withPageTokenRetry,
  type FollowUpBlock,
  type InboxViewer,
  type MetaConfig,
} from "@ms/domain";
import { resolveCapabilities, type AdminRole, type Capability, type PermissionOverrides } from "@ms/shared";
import { requireAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { toCsv } from "../lib/csv.js";
import { need } from "./inbox.js";

const Uuid = z.string().uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-20");
const MetaId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const STATUSES = ["new", "contacted", "won", "lost"] as const;
const LOST_REASONS = ["not_interested", "no_answer", "wrong_number", "duplicate", "test", "other"] as const;
type LeadStatus = (typeof STATUSES)[number];

const NOT_CONNECTED = "Meta is not connected on this server.";
const NO_PAGE = "No Facebook Page is connected. Connect one under Channels.";

/** What the person pressing the button reads when the follow-up may not go (spec 13, 7.3). */
export const FOLLOW_UP_BLOCKED_TEXT: Record<FollowUpBlock | "no_permission", string> = {
  no_phone: "This lead has no phone number we can message.",
  no_line: "No WhatsApp number is set up.",
  no_consent: "This form did not ask permission to message on WhatsApp. Call or email instead, or ask the owner to update the form's settings.",
  no_template: "The “lead_followup” template is not approved yet. See Templates.",
  already_sent: "The follow-up has already been sent to this lead.",
  no_permission: "You need permission to send templates.",
};

function templateLanguage(): string {
  return process.env.INBOX_TEMPLATE_LANGUAGE || "en";
}

/**
 * Who is asking. Unlike the inbox's withViewer, a person does not need
 * inbox.view to work leads: leads.view (or channels.manage, for form set-up)
 * is enough. Without inbox.view, canSeeConversation says no to every
 * conversation, so nothing of the inbox leaks.
 */
function withLeadViewer(db: DbClient): MiddlewareHandler {
  return async (c, next) => {
    const userId = c.get("auth").userId;
    const [u] = await db
      .select({ role: adminUser.role, overrides: adminUser.permissionOverrides, isActive: adminUser.isActive, deletedAt: adminUser.deletedAt })
      .from(adminUser)
      .where(eq(adminUser.id, userId));
    const caps = u && u.isActive && !u.deletedAt ? resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides) : [];
    if (!caps.includes("leads.view") && !caps.includes("channels.manage")) {
      throw new BusinessError("forbidden", "missing capability: leads.view", 403);
    }
    c.set("inboxViewer", await loadViewer(db, userId, caps));
    await next();
  };
}

function can(c: Context, cap: Capability): boolean {
  return c.get("inboxViewer").capabilities.includes(cap);
}

async function audit(db: DbClient, c: Context, action: string, entityType: string, entityId: string, after?: unknown, before?: unknown) {
  await writeAudit(db, c, { action, entityType, entityId, after, before, notify: false });
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
  return cfg;
}

/** Escape a user's text for an ILIKE pattern and wrap it in %…%. */
function likeTerm(text: string): string {
  return `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/** Midnight in Lagos (UTC+1, no daylight saving) at the start of a YYYY-MM-DD day. */
function lagosDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+01:00`);
}

/** Today's date in Lagos as YYYY-MM-DD. */
function lagosToday(now: Date): string {
  return new Date(now.getTime() + 3600_000).toISOString().slice(0, 10);
}

const assignee = alias(adminUser, "lead_assignee");
const receivedAt = sql<Date>`coalesce(${lead.metaCreatedAt}, ${lead.createdAt})`;

const rowColumns = {
  lead,
  form_name: leadForm.name,
  assignee_name: sql<string | null>`coalesce(${assignee.name}, ${assignee.email})`,
  conv_number: inboxConversation.phoneNumberId,
  conv_team: inboxConversation.teamId,
  conv_assignee: inboxConversation.assigneeId,
};

type Joined = {
  lead: typeof lead.$inferSelect;
  form_name: string | null;
  assignee_name: string | null;
  conv_number: string | null;
  conv_team: string | null;
  conv_assignee: string | null;
};

function visibleConversationId(v: InboxViewer, r: Joined): string | null {
  if (!r.lead.conversationId || !r.conv_number) return null;
  return canSeeConversation(v, { phoneNumberId: r.conv_number, teamId: r.conv_team, assigneeId: r.conv_assignee })
    ? r.lead.conversationId
    : null;
}

function leadRow(v: InboxViewer, r: Joined) {
  const l = r.lead;
  return {
    id: l.id,
    received_at: l.metaCreatedAt ?? l.createdAt,
    full_name: l.fullName,
    phone: l.phoneE164 ?? l.phoneRaw,
    email: l.email,
    form_id: l.formId,
    form_name: r.form_name ?? l.consent?.form_name ?? "Lead form",
    ad_name: l.adName,
    campaign_name: l.campaignName,
    platform: l.platform,
    is_organic: l.isOrganic,
    is_backfill: l.isBackfill,
    status: l.status as LeadStatus,
    lost_reason: l.lostReason,
    assignee: l.assigneeId ? { id: l.assigneeId, name: r.assignee_name ?? "" } : null,
    customer_id: l.customerId,
    /** Null unless the viewer may see the conversation (rule R17). */
    conversation_id: visibleConversationId(v, r),
    whatsapp_consent: l.whatsappConsent,
    followup_sent_at: l.followupSentAt,
    first_contacted_at: l.firstContactedAt,
  };
}

function joined(db: DbClient) {
  return db
    .select(rowColumns)
    .from(lead)
    .leftJoin(leadForm, eq(leadForm.formId, lead.formId))
    .leftJoin(assignee, eq(assignee.id, lead.assigneeId))
    .leftJoin(inboxConversation, eq(inboxConversation.id, lead.conversationId));
}

async function loadLead(db: DbClient, id: string): Promise<Joined> {
  if (!Uuid.safeParse(id).success) throw new BusinessError("not_found", "lead not found", 404);
  const [row] = await joined(db).where(and(eq(lead.id, id), eq(lead.fetchState, "fetched")));
  if (!row) throw new BusinessError("not_found", "lead not found", 404);
  return row;
}

// ── Filters shared by the list and the CSV ───────────────────────────────────

const ListQuery = z.object({
  status: z.enum([...STATUSES, "open", "all"]).optional(),
  form_id: MetaId.optional(),
  assignee: z.union([z.enum(["me", "none"]), Uuid]).optional(),
  customer_id: Uuid.optional(),
  q: z.string().trim().max(120).optional(),
  from: Day.optional(),
  to: Day.optional(),
  include_tests: z.enum(["true", "false", "1", "0"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});
type ListQuery = z.infer<typeof ListQuery>;

/** Every filter except the status tab (the tab counts are taken across all statuses). */
function listFilters(q: ListQuery, userId: string): SQL[] {
  const conds: SQL[] = [eq(lead.fetchState, "fetched")];
  if (q.form_id) conds.push(eq(lead.formId, q.form_id));
  if (q.assignee === "me") conds.push(eq(lead.assigneeId, userId));
  else if (q.assignee === "none") conds.push(isNull(lead.assigneeId));
  else if (q.assignee) conds.push(eq(lead.assigneeId, q.assignee));
  if (q.customer_id) conds.push(eq(lead.customerId, q.customer_id));
  if (q.q) {
    const term = likeTerm(q.q);
    conds.push(or(ilike(lead.fullName, term), ilike(lead.phoneRaw, term), ilike(lead.phoneE164, term), ilike(lead.email, term))!);
  }
  if (q.from) conds.push(sql`${receivedAt} >= ${lagosDayStart(q.from).toISOString()}::timestamptz`);
  if (q.to) conds.push(sql`${receivedAt} < ${new Date(lagosDayStart(q.to).getTime() + 86_400_000).toISOString()}::timestamptz`);
  if (q.include_tests !== "true" && q.include_tests !== "1") conds.push(sql`${lead.lostReason} is distinct from 'test'`);
  return conds;
}

function statusFilter(status: ListQuery["status"]): SQL[] {
  if (!status || status === "all") return [];
  if (status === "open") return [inArray(lead.status, ["new", "contacted"])];
  return [eq(lead.status, status)];
}

const PatchBody = z
  .object({
    status: z.enum(STATUSES).optional(),
    lost_reason: z.enum(LOST_REASONS).nullable().optional(),
    assignee_id: Uuid.nullable().optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

const FormPatchBody = z
  .object({
    is_enabled: z.boolean().optional(),
    whatsapp_consent_key: z.string().min(1).max(200).nullable().optional(),
    consent_covers_whatsapp: z.boolean().optional(),
    phone_number_id: Uuid.nullable().optional(),
  })
  .strict();

const Confirm = z.object({ confirm: z.literal(true) }).strict();
const FollowUpBody = z.object({ confirm: z.literal(true), again: z.boolean().optional() }).strict();

function formRow(f: typeof leadForm.$inferSelect, counts: { total: number; last30: number }) {
  return {
    id: f.id,
    form_id: f.formId,
    name: f.name,
    status: f.status,
    is_enabled: f.isEnabled,
    questions_count: f.questions.length,
    disclaimers: f.disclaimers,
    whatsapp_consent_key: f.whatsappConsentKey,
    consent_covers_whatsapp: f.consentCoversWhatsapp,
    phone_number_id: f.phoneNumberId,
    leads_total: counts.total,
    leads_30d: counts.last30,
    backfill: {
      requested_at: f.backfillRequestedAt,
      done_at: f.backfillDoneAt,
      count: f.backfillCount,
      /** True when Meta would not let us read this form's earlier leads (rule R21). */
      stopped: f.backfillError !== null,
    },
    synced_at: f.syncedAt,
  };
}

/** First word of the name for the template's {{1}}, or "there" (rule R19). */
export function followUpFirstName(fullName: string | null): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 60) : "there";
}

export function leadRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", withLeadViewer(db));

  // ── List ───────────────────────────────────────────────────────────────────
  r.get("/", async (c) => {
    need(c, "leads.view");
    const v = c.get("inboxViewer");
    const q = ListQuery.parse(c.req.query());
    const filters = listFilters(q, v.userId);
    const rows = await joined(db)
      .where(
        and(
          ...filters,
          ...statusFilter(q.status),
          ...(q.before ? [sql`${receivedAt} < ${new Date(q.before).toISOString()}::timestamptz`] : []),
        ),
      )
      .orderBy(desc(receivedAt), desc(lead.id))
      .limit(q.limit);
    const [counts] = await db
      .select({
        new: sql<number>`count(*) filter (where ${lead.status} = 'new')::int`,
        contacted: sql<number>`count(*) filter (where ${lead.status} = 'contacted')::int`,
        won: sql<number>`count(*) filter (where ${lead.status} = 'won')::int`,
        lost: sql<number>`count(*) filter (where ${lead.status} = 'lost')::int`,
      })
      .from(lead)
      .where(and(...filters));
    const [problems] = await db
      .select({
        pending: sql<number>`count(*) filter (where ${lead.fetchState} = 'pending')::int`,
        failed: sql<number>`count(*) filter (where ${lead.fetchState} = 'failed')::int`,
        oldest_pending_at: sql<string | null>`min(${lead.createdAt}) filter (where ${lead.fetchState} = 'pending')`,
      })
      .from(lead);
    return c.json({
      data: {
        leads: rows.map((row) => leadRow(v, row)),
        counts: counts ?? { new: 0, contacted: 0, won: 0, lost: 0 },
        problems: {
          pending: problems?.pending ?? 0,
          failed: problems?.failed ?? 0,
          oldest_pending_at: problems?.oldest_pending_at ? new Date(problems.oldest_pending_at).toISOString() : null,
        },
      },
    });
  });

  // ── Staff who can own a lead ───────────────────────────────────────────────
  r.get("/staff", async (c) => {
    need(c, "leads.view");
    const users = await db
      .select({ id: adminUser.id, name: adminUser.name, email: adminUser.email, role: adminUser.role, overrides: adminUser.permissionOverrides })
      .from(adminUser)
      .where(and(eq(adminUser.isActive, true), isNull(adminUser.deletedAt)))
      .orderBy(asc(adminUser.name), asc(adminUser.email));
    return c.json({
      data: users
        .filter((u) => resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides).includes("leads.view"))
        .map((u) => ({ id: u.id, name: u.name ?? u.email })),
    });
  });

  // ── Forms ──────────────────────────────────────────────────────────────────
  r.get("/forms", async (c) => {
    need(c, "leads.view");
    const forms = await db.select().from(leadForm).orderBy(asc(leadForm.name), asc(leadForm.createdAt));
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const counts = await db
      .select({
        formId: lead.formId,
        total: sql<number>`count(*)::int`,
        last30: sql<number>`count(*) filter (where ${receivedAt} >= ${since}::timestamptz)::int`,
      })
      .from(lead)
      .where(and(eq(lead.fetchState, "fetched"), sql`${lead.lostReason} is distinct from 'test'`))
      .groupBy(lead.formId);
    const byForm = new Map(counts.map((x) => [x.formId, x]));
    const lines = await db
      .select({ id: inboxPhoneNumber.id, label: inboxPhoneNumber.label })
      .from(inboxPhoneNumber)
      .where(
        and(
          eq(inboxPhoneNumber.kind, "phone"),
          eq(inboxPhoneNumber.isActive, true),
          sql`${inboxPhoneNumber.waPhoneNumberId} is not null`,
          sql`${inboxPhoneNumber.channels} <> 'voice'`,
        ),
      )
      .orderBy(asc(inboxPhoneNumber.createdAt));
    return c.json({
      data: forms.map((f) => formRow(f, { total: byForm.get(f.formId)?.total ?? 0, last30: byForm.get(f.formId)?.last30 ?? 0 })),
      // The WhatsApp numbers a form can use (for the Forms dialog's picker).
      lines,
    });
  });

  r.post("/forms/sync", async (c) => {
    need(c, "channels.manage");
    const cfg = needConfig();
    const result = await syncLeadForms(db, cfg);
    if (result.pages === 0) throw new BusinessError("conflict", NO_PAGE, 409, { reason: "no_page" });
    if (result.forms === 0 && result.problems.length > 0) {
      const p = result.problems[0]!;
      throw new BusinessError("conflict", p.plain, 409, { reason: "meta_refused", meta_code: p.code });
    }
    await audit(db, c, "lead_form.sync", "lead_form", "sync", { forms: result.forms, problems: result.problems.map((p) => p.code) });
    return c.json({ data: { forms: result.forms, problems: result.problems } });
  });

  r.patch("/forms/:id", async (c) => {
    need(c, "channels.manage");
    const id = c.req.param("id");
    if (!Uuid.safeParse(id).success) throw new BusinessError("not_found", "form not found", 404);
    const body = FormPatchBody.parse(await c.req.json());
    const [form] = await db.select().from(leadForm).where(eq(leadForm.id, id));
    if (!form) throw new BusinessError("not_found", "form not found", 404);

    if (body.whatsapp_consent_key && !form.disclaimers.some((d) => d.key === body.whatsapp_consent_key)) {
      throw new BusinessError("validation_failed", "That tick-box is not on this form.", 422, { reason: "unknown_consent_key" });
    }
    if (body.phone_number_id) {
      const line = await leadLineFor(db, body.phone_number_id);
      if (!line || line.id !== body.phone_number_id) {
        throw new BusinessError("validation_failed", "Choose a WhatsApp number that is switched on.", 422, { reason: "bad_line" });
      }
    }
    const patch: Partial<typeof leadForm.$inferInsert> = {};
    if (body.is_enabled !== undefined) patch.isEnabled = body.is_enabled;
    if (body.whatsapp_consent_key !== undefined) patch.whatsappConsentKey = body.whatsapp_consent_key;
    if (body.consent_covers_whatsapp !== undefined) patch.consentCoversWhatsapp = body.consent_covers_whatsapp;
    if (body.phone_number_id !== undefined) patch.phoneNumberId = body.phone_number_id;
    if (Object.keys(patch).length === 0) return c.json({ data: formRow(form, { total: 0, last30: 0 }) });

    const consentChanged = body.whatsapp_consent_key !== undefined || body.consent_covers_whatsapp !== undefined;
    const { updated, reviewed } = await db.transaction(async (tx) => {
      const [row] = await tx.update(leadForm).set({ ...patch, updatedAt: new Date() }).where(eq(leadForm.id, id)).returning();
      let n = 0;
      if (consentChanged) {
        // Rule R18 applied to the leads already stored, from what each one actually ticked
        // (their own copy of the wording). Works both ways: taking the rule away closes it again.
        const key = row!.whatsappConsentKey;
        const covers = row!.consentCoversWhatsapp;
        const changed = await tx
          .update(lead)
          .set({
            whatsappConsent: sql`(${covers}::boolean or (${key}::text is not null and exists (
              select 1 from jsonb_array_elements(coalesce(${lead.consent} -> 'disclaimers', '[]'::jsonb)) d
              where d ->> 'key' = ${key}::text and d ->> 'is_checked' = 'true')))`,
            updatedAt: new Date(),
          })
          .where(and(eq(lead.formId, form.formId), eq(lead.fetchState, "fetched"), isNull(lead.erasedAt)))
          .returning({ id: lead.id });
        n = changed.length;
      }
      return { updated: row!, reviewed: n };
    });
    await audit(
      db,
      c,
      "lead_form.update",
      "lead_form",
      id,
      { ...body, leads_reviewed: reviewed },
      {
        is_enabled: form.isEnabled,
        whatsapp_consent_key: form.whatsappConsentKey,
        consent_covers_whatsapp: form.consentCoversWhatsapp,
        phone_number_id: form.phoneNumberId,
      },
    );
    return c.json({ data: formRow(updated, { total: 0, last30: 0 }) });
  });

  r.post("/forms/:id/backfill", async (c) => {
    need(c, "channels.manage");
    const id = c.req.param("id");
    if (!Uuid.safeParse(id).success) throw new BusinessError("not_found", "form not found", 404);
    Confirm.parse(await c.req.json());
    const [form] = await db.select().from(leadForm).where(eq(leadForm.id, id));
    if (!form) throw new BusinessError("not_found", "form not found", 404);
    const now = new Date();
    const [started] = await db
      .update(leadForm)
      .set({ backfillRequestedAt: now, backfillCursor: null, backfillDoneAt: null, backfillCount: 0, backfillError: null, updatedAt: now })
      .where(and(eq(leadForm.id, id), sql`(${leadForm.backfillRequestedAt} is null or ${leadForm.backfillDoneAt} is not null)`))
      .returning({ id: leadForm.id });
    if (!started) {
      throw new BusinessError("conflict", "Earlier leads are already being fetched for this form.", 409, { reason: "backfill_running" });
    }
    await audit(db, c, "lead_form.backfill", "lead_form", id, { form_id: form.formId });
    return c.json({ data: { queued: true } }, 202);
  });

  // ── Connection ─────────────────────────────────────────────────────────────
  r.get("/health", async (c) => {
    need(c, "channels.manage");
    const problems: { code: string; plain: string }[] = [];
    const out = { page: null as { id: string; name: string } | null, token_ok: false, subscribed: false, can_list_forms: false, problems };
    const cfg = metaConfigFromEnv();
    if (!cfg) {
      problems.push({ code: "not_configured", plain: NOT_CONNECTED });
      return c.json({ data: out });
    }
    const [page] = await db
      .select({ id: inboxPhoneNumber.externalId, name: inboxPhoneNumber.externalName, label: inboxPhoneNumber.label })
      .from(inboxPhoneNumber)
      .where(and(eq(inboxPhoneNumber.kind, "messenger"), eq(inboxPhoneNumber.isActive, true), sql`${inboxPhoneNumber.externalId} is not null`))
      .orderBy(asc(inboxPhoneNumber.createdAt))
      .limit(1);
    if (!page?.id) {
      problems.push({ code: "no_page", plain: NO_PAGE });
      return c.json({ data: out });
    }
    out.page = { id: page.id, name: page.name ?? page.label };
    let token: string;
    try {
      token = await pageAccessToken(cfg, page.id);
      out.token_ok = true;
    } catch (err) {
      problems.push(describeLeadError(err));
      return c.json({ data: out });
    }
    try {
      out.subscribed = (await getPageSubscription(cfg, token, page.id)).includes("leadgen");
    } catch (err) {
      problems.push(describeLeadError(err));
    }
    try {
      await listForms(cfg, token, page.id);
      out.can_list_forms = true;
    } catch (err) {
      const p = describeLeadError(err);
      if (!problems.some((x) => x.code === p.code)) problems.push(p);
    }
    return c.json({ data: out });
  });

  r.post("/health/subscribe", async (c) => {
    need(c, "channels.manage");
    Confirm.parse(await c.req.json());
    const cfg = needConfig();
    const page = await firstLeadPage(db);
    if (!page) throw new BusinessError("conflict", NO_PAGE, 409, { reason: "no_page" });
    try {
      const res = await withPageTokenRetry(cfg, page.pageId, (token) => ensureLeadgenSubscribed(cfg, token, page.pageId));
      await audit(db, c, "lead.subscribe_page", "inbox_phone_number", page.pageId, { changed: res.changed, fields: res.fields });
      return c.json({ data: { subscribed: true, changed: res.changed, fields: res.fields } });
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      const p = describeLeadError(err);
      const temporary = classifyLeadError(err) === "temporary";
      throw new BusinessError(temporary ? "service_unavailable" : "conflict", p.plain, temporary ? 502 : 409, {
        reason: temporary ? "meta_busy" : "meta_refused",
        meta_code: p.code,
      });
    }
  });

  r.post("/retry-failed", async (c) => {
    need(c, "channels.manage");
    const now = new Date();
    const rows = await db
      .update(lead)
      .set({ fetchState: "pending", fetchAttempts: 0, nextFetchAt: now, updatedAt: now })
      .where(eq(lead.fetchState, "failed"))
      .returning({ id: lead.id });
    await audit(db, c, "lead.retry_failed", "lead", "retry", { requeued: rows.length });
    return c.json({ data: { requeued: rows.length } });
  });

  // ── Report (rule R23) ──────────────────────────────────────────────────────
  r.get("/report", async (c) => {
    need(c, "leads.view");
    const q = z.object({ from: Day.optional(), to: Day.optional() }).parse(c.req.query());
    const today = lagosToday(new Date());
    const to = q.to ?? today;
    const from = q.from ?? new Date(lagosDayStart(to).getTime() - 29 * 86_400_000 + 3600_000).toISOString().slice(0, 10);
    const start = lagosDayStart(from);
    const end = new Date(lagosDayStart(to).getTime() + 86_400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || !(end > start) || end.getTime() - start.getTime() > 400 * 86_400_000) {
      throw new BusinessError("validation_failed", "Pick a range of up to 400 days", 400);
    }
    const inRange = and(
      eq(lead.fetchState, "fetched"),
      sql`${lead.lostReason} is distinct from 'test'`,
      sql`${receivedAt} >= ${start.toISOString()}::timestamptz`,
      sql`${receivedAt} < ${end.toISOString()}::timestamptz`,
    );
    const tally = {
      leads: sql<number>`count(*)::int`,
      new: sql<number>`count(*) filter (where ${lead.status} = 'new')::int`,
      contacted: sql<number>`count(*) filter (where ${lead.status} in ('contacted','won') or (${lead.status} = 'lost' and ${lead.firstContactedAt} is not null))::int`,
      won: sql<number>`count(*) filter (where ${lead.status} = 'won')::int`,
      lost: sql<number>`count(*) filter (where ${lead.status} = 'lost')::int`,
    };
    const rate = (won: number, lost: number): number | null => (won + lost > 0 ? won / (won + lost) : null);

    const [totals] = await db
      .select({
        ...tally,
        median: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from ${lead.firstContactedAt} - ${receivedAt}) / 60.0)
          filter (where ${lead.firstContactedAt} is not null)`,
      })
      .from(lead)
      .where(inRange);
    const byForm = await db
      .select({ form_id: lead.formId, form_name: sql<string | null>`max(${leadForm.name})`, ...tally })
      .from(lead)
      .leftJoin(leadForm, eq(leadForm.formId, lead.formId))
      .where(inRange)
      .groupBy(lead.formId)
      .orderBy(sql`count(*) desc`, asc(lead.formId));
    const byAd = await db
      .select({
        ad_id: lead.adId,
        ad_name: sql<string | null>`max(${lead.adName})`,
        campaign_name: sql<string | null>`max(${lead.campaignName})`,
        ...tally,
      })
      .from(lead)
      .where(and(inRange, sql`${lead.adId} is not null`))
      .groupBy(lead.adId)
      .orderBy(sql`count(*) desc`, asc(lead.adId));
    const byDay = await db
      .select({
        day: sql<string>`to_char(${receivedAt} at time zone 'Africa/Lagos', 'YYYY-MM-DD')`,
        leads: sql<number>`count(*)::int`,
      })
      .from(lead)
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const t = totals ?? { leads: 0, new: 0, contacted: 0, won: 0, lost: 0, median: null };
    return c.json({
      data: {
        range: { from, to },
        totals: {
          leads: t.leads,
          new: t.new,
          contacted: t.contacted,
          won: t.won,
          lost: t.lost,
          win_rate: rate(t.won, t.lost),
          median_minutes_to_first_contact: t.median === null || t.median === undefined ? null : Number(t.median),
        },
        by_form: byForm.map((f) => ({
          form_id: f.form_id,
          form_name: f.form_name ?? "Lead form",
          leads: f.leads,
          contacted: f.contacted,
          won: f.won,
          lost: f.lost,
          win_rate: rate(f.won, f.lost),
        })),
        by_ad: byAd.map((a) => ({
          ad_id: a.ad_id,
          ad_name: a.ad_name,
          campaign_name: a.campaign_name,
          leads: a.leads,
          contacted: a.contacted,
          won: a.won,
          lost: a.lost,
          win_rate: rate(a.won, a.lost),
        })),
        by_day: byDay,
      },
    });
  });

  // ── CSV ────────────────────────────────────────────────────────────────────
  r.get("/export.csv", async (c) => {
    need(c, "leads.view");
    need(c, "inbox.export");
    const v = c.get("inboxViewer");
    const q = ListQuery.parse(c.req.query());
    const rows = await joined(db)
      .where(and(...listFilters(q, v.userId), ...statusFilter(q.status)))
      .orderBy(desc(receivedAt), desc(lead.id))
      .limit(5000);
    await audit(db, c, "lead.export", "lead", "export", { rows: rows.length });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="leads.csv"');
    const iso = (d: Date | null) => (d ? d.toISOString() : "");
    return c.body(
      toCsv(
        ["Received", "Name", "Phone", "Email", "Form", "Advert", "Campaign", "Status", "Lost reason", "Owner", "First contacted"],
        rows.map((row) => {
          const x = leadRow(v, row);
          return [
            iso(x.received_at),
            x.full_name,
            x.phone,
            x.email,
            x.form_name,
            x.ad_name,
            x.campaign_name,
            x.status,
            x.lost_reason,
            x.assignee?.name ?? "",
            iso(x.first_contacted_at),
          ];
        }),
      ),
    );
  });

  // ── One lead ───────────────────────────────────────────────────────────────

  /** Everything the follow-up needs to know about a lead, for the detail view and the send. */
  async function followUpFacts(l: typeof lead.$inferSelect) {
    const [form] = await db.select().from(leadForm).where(eq(leadForm.formId, l.formId));
    const line = await leadLineFor(db, form?.phoneNumberId ?? null);
    const language = templateLanguage();
    const template = line ? await approvedFollowUpTemplate(db, line, language) : null;
    return { form: form ?? null, line, language, template };
  }

  r.get("/:id", async (c) => {
    need(c, "leads.view");
    const v = c.get("inboxViewer");
    const row = await loadLead(db, c.req.param("id"));
    const l = row.lead;
    const facts = await followUpFacts(l);
    const block = leadFollowUpBlock({
      phoneE164: l.phoneE164,
      hasLine: !!facts.line,
      whatsappConsent: l.whatsappConsent,
      templateApproved: !!facts.template,
      followupSentAt: l.followupSentAt,
      again: true, // "already sent" is not a block here: the button reads "Send again"
    });
    const blocked: FollowUpBlock | "no_permission" | null = block ?? (can(c, "inbox.templates") ? null : "no_permission");
    const convId = visibleConversationId(v, row);
    const canOpen =
      can(c, "inbox.view") &&
      (l.conversationId ? convId !== null : !!l.phoneE164 && !!facts.line && canUseNumber(v, facts.line.id));
    const [cust] = l.customerId
      ? await db.select({ name: customer.name }).from(customer).where(eq(customer.id, l.customerId))
      : [];
    return c.json({
      data: {
        ...leadRow(v, row),
        answers: l.answers,
        consent: l.consent,
        note: l.note,
        erased: l.erasedAt !== null,
        customer_name: cust?.name ?? null,
        can_open_conversation: canOpen,
        can_follow_up: blocked === null,
        follow_up_blocked_reason: blocked,
        /** What the confirm dialog shows: exactly what will be sent, to whom and from which number. */
        follow_up_preview:
          facts.line && facts.template && l.phoneE164
            ? {
                phone: l.phoneE164,
                line_label: facts.line.label,
                text: renderTemplateBody(facts.template.components, [followUpFirstName(l.fullName)]) ?? `Template: ${LEAD_FOLLOWUP_TEMPLATE}`,
              }
            : null,
      },
    });
  });

  r.patch("/:id", async (c) => {
    need(c, "leads.view");
    const v = c.get("inboxViewer");
    const row = await loadLead(db, c.req.param("id"));
    const l = row.lead;
    const body = PatchBody.parse(await c.req.json());
    const now = new Date();
    const patch: Partial<typeof lead.$inferInsert> = {};

    // Rule R15.
    const status = (body.status ?? l.status) as LeadStatus;
    if (status === "lost") {
      const reason = body.lost_reason ?? (l.status === "lost" ? l.lostReason : null);
      if (!reason) throw new BusinessError("validation_failed", "Choose why this lead was lost.", 422, { reason: "reason_required" });
      patch.lostReason = reason;
    } else {
      if (body.lost_reason) {
        throw new BusinessError("validation_failed", "A reason only goes with Lost.", 422, { reason: "reason_not_allowed" });
      }
      if (l.lostReason !== null) patch.lostReason = null;
    }
    if (body.status !== undefined && body.status !== l.status) {
      patch.status = body.status;
      patch.closedAt = body.status === "won" || body.status === "lost" ? now : null;
      if (l.status === "new" && !l.firstContactedAt) patch.firstContactedAt = now;
    }

    // Rule R16.
    let assignConversation = false;
    if (body.assignee_id !== undefined && body.assignee_id !== l.assigneeId) {
      if (body.assignee_id) {
        const [u] = await db
          .select({ role: adminUser.role, overrides: adminUser.permissionOverrides, isActive: adminUser.isActive, deletedAt: adminUser.deletedAt })
          .from(adminUser)
          .where(eq(adminUser.id, body.assignee_id));
        const caps = u && u.isActive && !u.deletedAt ? resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides) : [];
        if (!caps.includes("leads.view")) {
          throw new BusinessError("validation_failed", "That person can't work on leads.", 422, { reason: "bad_assignee" });
        }
        // The conversation follows only when that person may work on its line (the inbox's own rule).
        if (l.conversationId && row.conv_number && !row.conv_assignee && caps.includes("inbox.view")) {
          assignConversation = canUseNumber(await loadViewer(db, body.assignee_id, caps), row.conv_number);
        }
      }
      patch.assigneeId = body.assignee_id;
    }
    if (body.note !== undefined) patch.note = body.note.trim() ? body.note : null;

    if (Object.keys(patch).length > 0) {
      await db.transaction(async (tx) => {
        await tx.update(lead).set({ ...patch, updatedAt: now }).where(eq(lead.id, l.id));
        if (assignConversation && l.conversationId && body.assignee_id) {
          const [conv] = await tx
            .update(inboxConversation)
            .set({ assigneeId: body.assignee_id })
            .where(and(eq(inboxConversation.id, l.conversationId), isNull(inboxConversation.assigneeId)))
            .returning();
          if (conv) await publishInboxEvent(tx, signalFor("conversation.updated", conv));
        }
      });
      await audit(db, c, "lead.update", "lead", l.id, body, {
        status: l.status,
        lost_reason: l.lostReason,
        assignee_id: l.assigneeId,
        note_changed: body.note !== undefined,
      });
    }
    return c.json({ data: leadRow(v, await loadLead(db, l.id)) });
  });

  /**
   * Make sure the lead has a conversation the viewer may see. The whole step
   * rolls back when they may not, so nothing is created for someone who cannot
   * use it.
   */
  async function openConversation(c: Context, l: typeof lead.$inferSelect): Promise<string> {
    const v = c.get("inboxViewer");
    if (!l.phoneE164) throw new BusinessError("conflict", FOLLOW_UP_BLOCKED_TEXT.no_phone, 409, { reason: "no_phone" });
    const [form] = await db.select().from(leadForm).where(eq(leadForm.formId, l.formId));
    const line = await leadLineFor(db, form?.phoneNumberId ?? null);
    if (!line) throw new BusinessError("conflict", FOLLOW_UP_BLOCKED_TEXT.no_line, 409, { reason: "no_line" });
    if (!canUseNumber(v, line.id)) throw new BusinessError("forbidden", "You can't use this WhatsApp number.", 403);
    return db.transaction(async (tx) => {
      const conversationId = await linkLeadConversation(tx, l.id, { announce: false });
      if (!conversationId) throw new BusinessError("conflict", FOLLOW_UP_BLOCKED_TEXT.no_phone, 409, { reason: "no_phone" });
      const [conv] = await tx.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
      if (!conv || !canSeeConversation(v, conv)) {
        throw new BusinessError("forbidden", "You don't have access to this lead's conversation.", 403);
      }
      return conversationId;
    });
  }

  r.post("/:id/conversation", async (c) => {
    need(c, "leads.view");
    need(c, "inbox.view");
    const { lead: l } = await loadLead(db, c.req.param("id"));
    const conversationId = await openConversation(c, l);
    await audit(db, c, "lead.open_conversation", "lead", l.id, { conversation_id: conversationId });
    return c.json({ data: { conversation_id: conversationId } });
  });

  /**
   * Send the approved "lead_followup" WhatsApp template to a lead (rules R19, R20).
   * Never automatic: a person with leads.view and inbox.templates presses the
   * button and confirms (`confirm: true`), and the send is audited.
   */
  r.post("/:id/follow-up", async (c) => {
    need(c, "leads.view");
    need(c, "inbox.templates");
    const v = c.get("inboxViewer");
    const { lead: l } = await loadLead(db, c.req.param("id"));
    const body = FollowUpBody.parse(await c.req.json());

    const facts = await followUpFacts(l);
    const block = leadFollowUpBlock({
      phoneE164: l.phoneE164,
      hasLine: !!facts.line,
      whatsappConsent: l.whatsappConsent,
      templateApproved: !!facts.template,
      followupSentAt: l.followupSentAt,
      again: body.again === true,
    });
    if (block) throw new BusinessError("conflict", FOLLOW_UP_BLOCKED_TEXT[block], 409, { reason: block });
    const cfg = needConfig();
    const conversationId = await openConversation(c, l);

    // Claim the send first, so two clicks at once cannot send it twice. Undone if nothing went.
    const now = new Date();
    const prev = l.followupSentAt;
    const unchanged = prev
      ? sql`date_trunc('milliseconds', ${lead.followupSentAt}) = ${prev.toISOString()}::timestamptz`
      : isNull(lead.followupSentAt);
    const [claimed] = await db.update(lead).set({ followupSentAt: now }).where(and(eq(lead.id, l.id), unchanged)).returning({ id: lead.id });
    if (!claimed) {
      throw new BusinessError("conflict", FOLLOW_UP_BLOCKED_TEXT.already_sent, 409, { reason: "already_sent" });
    }
    const release = () =>
      db
        .update(lead)
        .set({ followupSentAt: prev })
        .where(and(eq(lead.id, l.id), sql`date_trunc('milliseconds', ${lead.followupSentAt}) = ${now.toISOString()}::timestamptz`));

    const firstName = followUpFirstName(l.fullName);
    let msg;
    try {
      msg = await sendFromConversation(db, cfg, {
        conversationId,
        userId: v.userId,
        content: { type: "template", name: LEAD_FOLLOWUP_TEMPLATE, language: facts.language, bodyParams: [firstName] },
      });
    } catch (err) {
      await release();
      if (err instanceof InboxSendError) {
        if (err.code === "template_not_approved") {
          throw new BusinessError("conflict", FOLLOW_UP_BLOCKED_TEXT.no_template, 409, { reason: "no_template" });
        }
        const status = err.code === "not_configured" ? 503 : 409;
        throw new BusinessError(status === 503 ? "service_unavailable" : "conflict", err.message, status, { reason: err.code });
      }
      throw err;
    }

    const unconfirmed = (msg.payload as { unconfirmed?: boolean } | null)?.unconfirmed === true;
    if (msg.status === "failed") {
      // Nothing changes on the lead, except when WhatsApp gave no answer at all: it may have
      // gone, so the lead keeps "sent" and a second send needs "Send again" (foundation rule 9).
      if (!unconfirmed) await release();
      await audit(db, c, "lead.follow_up", "lead", l.id, {
        conversation_id: conversationId,
        message_id: msg.id,
        template: LEAD_FOLLOWUP_TEMPLATE,
        language: facts.language,
        status: "failed",
        unconfirmed,
        error_code: msg.errorCode,
      });
      throw new BusinessError("validation_failed", msg.errorMessage ?? "WhatsApp did not accept the message.", 422, {
        reason: "send_failed",
        message_id: msg.id,
        unconfirmed,
      });
    }

    // Rule R15: the first move away from "new".
    await db
      .update(lead)
      .set({ status: "contacted", firstContactedAt: sql`coalesce(${lead.firstContactedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
      .where(and(eq(lead.id, l.id), eq(lead.status, "new")));
    await audit(db, c, "lead.follow_up", "lead", l.id, {
      conversation_id: conversationId,
      message_id: msg.id,
      template: LEAD_FOLLOWUP_TEMPLATE,
      language: facts.language,
      status: msg.status,
      again: body.again === true,
    });
    return c.json({ data: { message_id: msg.id, status: msg.status } });
  });

  return r;
}
