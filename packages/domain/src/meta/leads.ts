/**
 * Leads from Meta lead forms ("instant forms"), suite spec 13.
 *
 * The webhook path only stores IDs (ingestLeadgenChange: no call to Meta, safe
 * to run twice). The worker then fetches each lead with a Page access token
 * (processLead), maps the answers, records what the person agreed to, links the
 * customer and, for a switched-on form, opens a conversation with an announcing
 * message.
 *
 * Rules that matter here:
 *   - An existing customer row is never changed by a lead. The form's own
 *     answers stay on the lead row.
 *   - A lead is not a message from the customer: it never opens the 24-hour
 *     WhatsApp window (last_inbound_wa_at is not touched).
 *   - Nothing in this file sends a message to anyone. The follow-up is sent by
 *     a person through the leads route.
 *   - Page tokens are never stored, logged or returned.
 *   - No database transaction is held open across a call to Meta.
 */
import { and, asc, eq, gt, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import {
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  lead,
  leadForm,
  outboxEvent,
  type DbClient,
  type DbExecutor,
  type LeadAnswer,
  type LeadConsent,
  type LeadDisclaimer,
  type LeadQuestion,
} from "@ms/db";
import { toE164 } from "@ms/shared";
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";
import { findOrCreateCustomer, findOrOpenConversation, publishInboxEvent, signalFor, touchConversation } from "../inbox/core.js";
import { withPageTokenRetry, subscribedFieldsOf, type SubscribedApp } from "./messaging.js";

export type { LeadAnswer, LeadConsent, LeadDisclaimer, LeadQuestion } from "@ms/db";

/** The approved WhatsApp template a person may send to a lead (rule R20). */
export const LEAD_FOLLOWUP_TEMPLATE = "lead_followup";
/** The label put on a conversation opened by a lead. */
export const LEAD_LABEL = "lead";
/** How far back "Fetch earlier leads" reaches (rule R22). */
export const LEAD_BACKFILL_DAYS = 90;
/** A temporary failure is retried this many times before the lead is marked failed. */
export const LEAD_MAX_FETCH_ATTEMPTS = 8;
const FORM_REFRESH_MS = 24 * 3600_000;
const DEFAULT_FORM_NAME = "Lead form";

// ── Webhook: store the IDs only ─────────────────────────────────────────────

export interface LeadgenChange {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  adgroup_id?: string;
  ad_id?: string;
  created_time?: number;
}

const META_ID = /^[A-Za-z0-9_-]{1,64}$/;

function metaId(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return META_ID.test(s) ? s : null;
}

/** Unix seconds (or milliseconds) to a Date; null when it is not a usable number. */
function unixToDate(v: unknown): Date | null {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}

/**
 * Called from the shared webhook's dispatch (ingestMetaEntry) for every change
 * with field "leadgen". No Meta call. Idempotent: one row per leadgen_id
 * (rule R1). A change with no leadgen_id or no form_id is ignored.
 */
export async function ingestLeadgenChange(db: DbExecutor, value: LeadgenChange): Promise<{ created: boolean }> {
  const v = (value ?? {}) as Record<string, unknown>;
  const leadgenId = metaId(v.leadgen_id);
  const formId = metaId(v.form_id);
  if (!leadgenId || !formId) return { created: false };
  const rows = await db
    .insert(lead)
    .values({
      leadgenId,
      formId,
      pageId: metaId(v.page_id),
      adId: metaId(v.ad_id) ?? metaId(v.adgroup_id),
      metaCreatedAt: unixToDate(v.created_time),
      fetchState: "pending",
    })
    .onConflictDoNothing({ target: lead.leadgenId })
    .returning({ id: lead.id });
  return { created: rows.length > 0 };
}

// ── Graph calls (all with the Page token) ───────────────────────────────────

export interface MetaLead {
  id: string;
  created_time?: string;
  ad_id?: string;
  form_id?: string;
  campaign_id?: string;
  field_data?: { name: string; values: string[] }[];
  custom_disclaimer_responses?: { checkbox_key: string; is_checked: boolean | string }[];
}

const LEAD_FIELDS = "id,created_time,ad_id,form_id,campaign_id,field_data,custom_disclaimer_responses";

export async function fetchLead(cfg: MetaConfig, pageToken: string, leadgenId: string): Promise<MetaLead> {
  const res = await graph<MetaLead | null>(cfg, "GET", `${encodeURIComponent(leadgenId)}?fields=${LEAD_FIELDS}`, undefined, {
    token: pageToken,
  });
  if (!res?.id) throw new MetaApiError("Meta returned no lead", 502, null, true);
  return res;
}

export interface LeadExtras {
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_name?: string;
  is_organic?: boolean;
  platform?: string;
}

/** The advert names for a lead. Field names are [unverified]: never throws; {} on any error (rule R6). */
export async function fetchLeadExtras(cfg: MetaConfig, pageToken: string, leadgenId: string): Promise<LeadExtras> {
  try {
    const r = await graph<Record<string, unknown> | null>(
      cfg,
      "GET",
      `${encodeURIComponent(leadgenId)}?fields=ad_name,adset_id,adset_name,campaign_name,is_organic,platform`,
      undefined,
      { token: pageToken },
    );
    if (!r) return {};
    const out: LeadExtras = {};
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : typeof v === "number" ? String(v) : undefined);
    const adName = str(r.ad_name);
    const adsetId = str(r.adset_id);
    const adsetName = str(r.adset_name);
    const campaignName = str(r.campaign_name);
    const platform = str(r.platform);
    if (adName) out.ad_name = adName;
    if (adsetId) out.adset_id = adsetId;
    if (adsetName) out.adset_name = adsetName;
    if (campaignName) out.campaign_name = campaignName;
    if (platform) out.platform = platform.toLowerCase();
    if (typeof r.is_organic === "boolean") out.is_organic = r.is_organic;
    else if (r.is_organic === "true" || r.is_organic === "false") out.is_organic = r.is_organic === "true";
    return out;
  } catch {
    return {};
  }
}

const MAX_FORM_PAGES = 20;

/** The Page's lead forms: id and name. Follows paging.next, at most 20 pages. */
export async function listForms(cfg: MetaConfig, pageToken: string, pageId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let next: string | null = `${encodeURIComponent(pageId)}/leadgen_forms?fields=id,name&limit=100`;
  for (let page = 0; next && page < MAX_FORM_PAGES; page++) {
    const res: { data?: { id?: string | number; name?: string }[]; paging?: { next?: string } } | null = await graph(
      cfg,
      "GET",
      next,
      undefined,
      { token: pageToken },
    );
    for (const f of res?.data ?? []) {
      const id = metaId(f.id);
      if (id) out.push({ id, name: (typeof f.name === "string" && f.name.trim()) || DEFAULT_FORM_NAME });
    }
    next = res?.paging?.next ?? null;
  }
  return out;
}

export interface MetaForm {
  id: string;
  name: string;
  questions: LeadQuestion[];
  status?: string;
  locale?: string;
  privacy_policy_url?: string;
  disclaimers: LeadDisclaimer[];
}

function cleanQuestions(raw: unknown): LeadQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: LeadQuestion[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    if (!q || typeof q !== "object") continue;
    const type = typeof q.type === "string" ? q.type : "CUSTOM";
    const key = typeof q.key === "string" && q.key ? q.key : "";
    if (!key) continue;
    const label = typeof q.label === "string" && q.label.trim() ? q.label.trim() : key;
    const one: LeadQuestion = { key, label, type };
    if (Array.isArray(q.options)) {
      one.options = (q.options as Record<string, unknown>[])
        .filter((o) => o && typeof o === "object")
        .map((o) => ({ key: String(o.key ?? ""), value: String(o.value ?? "") }));
    }
    out.push(one);
  }
  return out;
}

function cleanDisclaimers(legal: unknown): LeadDisclaimer[] {
  const boxes = (legal as { custom_disclaimer?: { checkboxes?: unknown } } | null | undefined)?.custom_disclaimer?.checkboxes;
  if (!Array.isArray(boxes)) return [];
  const out: LeadDisclaimer[] = [];
  for (const b of boxes as Record<string, unknown>[]) {
    if (!b || typeof b !== "object" || typeof b.key !== "string" || !b.key) continue;
    out.push({ key: b.key, text: typeof b.text === "string" ? b.text : "", is_required: b.is_required === true || b.is_required === "true" });
  }
  return out;
}

/**
 * A form's questions, then (second, optional call whose failure is ignored;
 * those field names are [unverified]) its status, locale and consent wording.
 */
export async function fetchForm(cfg: MetaConfig, pageToken: string, formId: string): Promise<MetaForm> {
  const id = encodeURIComponent(formId);
  const first = await graph<{ id?: string; name?: string; questions?: unknown } | null>(
    cfg,
    "GET",
    `${id}?fields=id,name,questions`,
    undefined,
    { token: pageToken },
  );
  const form: MetaForm = {
    id: metaId(first?.id) ?? formId,
    name: (typeof first?.name === "string" && first.name.trim()) || DEFAULT_FORM_NAME,
    questions: cleanQuestions(first?.questions),
    disclaimers: [],
  };
  try {
    const more = await graph<Record<string, unknown> | null>(
      cfg,
      "GET",
      `${id}?fields=status,locale,privacy_policy_url,legal_content`,
      undefined,
      { token: pageToken },
    );
    if (more) {
      if (typeof more.status === "string") form.status = more.status;
      if (typeof more.locale === "string") form.locale = more.locale;
      const legal = more.legal_content as { privacy_policy?: { url?: unknown } } | undefined;
      const url = typeof more.privacy_policy_url === "string" ? more.privacy_policy_url : legal?.privacy_policy?.url;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) form.privacy_policy_url = url;
      form.disclaimers = cleanDisclaimers(more.legal_content);
    }
  } catch {
    // Optional: the lead still works without the form's wording (rule R4).
  }
  return form;
}

/** One page (100) of a form's leads created after `sinceUnix`. `after` is null on the last page. */
export async function listFormLeads(
  cfg: MetaConfig,
  pageToken: string,
  formId: string,
  o: { sinceUnix: number; after?: string },
): Promise<{ leads: MetaLead[]; after: string | null }> {
  const filtering = encodeURIComponent(
    JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(o.sinceUnix) }]),
  );
  const path =
    `${encodeURIComponent(formId)}/leads?fields=${LEAD_FIELDS}&limit=100&filtering=${filtering}` +
    (o.after ? `&after=${encodeURIComponent(o.after)}` : "");
  const res = await graph<{ data?: MetaLead[]; paging?: { cursors?: { after?: string }; next?: string } } | null>(
    cfg,
    "GET",
    path,
    undefined,
    { token: pageToken },
  );
  const leads = (res?.data ?? []).filter((l) => l && metaId(l.id));
  // Meta gives a cursor on the last page too; only `next` says there is more.
  const after = leads.length > 0 && res?.paging?.next && res.paging.cursors?.after ? res.paging.cursors.after : null;
  return { leads, after };
}

/** The webhook fields our app is subscribed to on this Page. */
export async function getPageSubscription(cfg: MetaConfig, pageToken: string, pageId: string): Promise<string[]> {
  const res = await graph<{ data?: SubscribedApp[] } | null>(cfg, "GET", `${encodeURIComponent(pageId)}/subscribed_apps`, undefined, {
    token: pageToken,
  });
  return subscribedFieldsOf(res?.data, cfg.appId);
}

/**
 * Rule R2: if "leadgen" is already subscribed do nothing; otherwise post the
 * UNION of the current fields and "leadgen", so the fields the inbox needs are
 * never dropped, whichever way Meta treats the list.
 */
export async function ensureLeadgenSubscribed(
  cfg: MetaConfig,
  pageToken: string,
  pageId: string,
): Promise<{ changed: boolean; fields: string[] }> {
  const current = await getPageSubscription(cfg, pageToken, pageId);
  if (current.includes("leadgen")) return { changed: false, fields: current };
  const fields = [...new Set([...current.filter((f) => /^[a-z][a-z0-9_]{0,63}$/.test(f)), "leadgen"])];
  const res = await graph<{ success?: boolean | string } | null>(
    cfg,
    "POST",
    `${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=${fields.join(",")}`,
    undefined,
    { token: pageToken },
  );
  if (res && (res.success === false || res.success === "false")) {
    throw new MetaApiError("Meta did not confirm the subscription", 502, null, true);
  }
  return { changed: true, fields };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

type ContactKind = "FULL_NAME" | "FIRST_NAME" | "LAST_NAME" | "EMAIL" | "PHONE";

/** The field_data name Meta uses for a standard question type (rule R7). */
const NAME_FOR_TYPE: Record<ContactKind, string> = {
  FULL_NAME: "full_name",
  FIRST_NAME: "first_name",
  LAST_NAME: "last_name",
  EMAIL: "email",
  PHONE: "phone_number",
};
const TYPE_FOR_NAME: Record<string, ContactKind> = {
  full_name: "FULL_NAME",
  first_name: "FIRST_NAME",
  last_name: "LAST_NAME",
  email: "EMAIL",
  phone_number: "PHONE",
  phone: "PHONE",
};
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => v !== null && v !== undefined).map((v) => String(v));
}

/** Pure. Turn Meta's field_data into answers and contact details, using the form's questions (rule R7). */
export function mapLeadAnswers(
  fieldData: { name: string; values: string[] }[],
  questions: LeadQuestion[],
): { answers: LeadAnswer[]; fullName: string | null; phoneRaw: string | null; phoneE164: string | null; email: string | null } {
  const data = (Array.isArray(fieldData) ? fieldData : []).filter((f) => f && typeof f.name === "string");
  const used = new Set<number>();
  const answers: LeadAnswer[] = [];
  const contact: Partial<Record<ContactKind, string>> = {};
  const note = (kind: ContactKind | undefined, values: string[]) => {
    const first = values[0]?.trim();
    if (kind && first && contact[kind] === undefined) contact[kind] = first;
  };

  for (const q of questions ?? []) {
    const type = (q.type ?? "").toUpperCase();
    const kind = type in NAME_FOR_TYPE ? (type as ContactKind) : undefined;
    let idx = data.findIndex((f, i) => !used.has(i) && f.name === q.key);
    if (idx < 0) {
      const fallback = kind ? NAME_FOR_TYPE[kind] : type.toLowerCase();
      idx = data.findIndex((f, i) => !used.has(i) && f.name === fallback);
    }
    if (idx < 0) continue;
    used.add(idx);
    const values = cleanValues(data[idx]!.values);
    answers.push({ key: q.key, label: q.label || q.key, values });
    note(kind, values);
  }
  // Answers with no matching question (and every answer when the form's questions are unknown).
  data.forEach((f, i) => {
    if (used.has(i)) return;
    const values = cleanValues(f.values);
    answers.push({ key: f.name, label: f.name, values });
    note(TYPE_FOR_NAME[f.name.toLowerCase()], values);
  });

  const joined = [contact.FIRST_NAME, contact.LAST_NAME].filter(Boolean).join(" ");
  const fullName = (contact.FULL_NAME ?? joined).trim().slice(0, 120) || null;
  const emailRaw = contact.EMAIL?.trim().toLowerCase() ?? "";
  const email = emailRaw && EMAIL_SHAPE.test(emailRaw) ? emailRaw.slice(0, 254) : null;
  const phoneRaw = contact.PHONE?.trim().slice(0, 40) || null;
  return { answers, fullName, phoneRaw, phoneE164: toE164(phoneRaw), email };
}

function isTicked(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

/**
 * Pure. The wording the person saw and what they ticked, and whether that
 * allows a WhatsApp follow-up (rule R18): the owner says the form's wording
 * covers it, or the chosen tick-box came back ticked.
 */
export function buildConsent(
  form: {
    name: string;
    privacyPolicyUrl: string | null;
    disclaimers: LeadDisclaimer[];
    whatsappConsentKey: string | null;
    consentCoversWhatsapp: boolean;
  },
  responses: { checkbox_key: string; is_checked: boolean | string }[],
  now: Date,
): { consent: LeadConsent; whatsappConsent: boolean } {
  const ticked = new Map<string, boolean>();
  for (const r of Array.isArray(responses) ? responses : []) {
    if (r && typeof r.checkbox_key === "string") ticked.set(r.checkbox_key, isTicked(r.is_checked));
  }
  const known = new Set((form.disclaimers ?? []).map((d) => d.key));
  const disclaimers = [
    ...(form.disclaimers ?? []).map((d) => ({ key: d.key, text: d.text, is_checked: ticked.get(d.key) === true })),
    // A tick-box Meta reported that we have no wording for: keep the answer, with empty text.
    ...[...ticked.entries()].filter(([key]) => !known.has(key)).map(([key, is_checked]) => ({ key, text: "", is_checked })),
  ];
  const byKey = form.whatsappConsentKey ? ticked.get(form.whatsappConsentKey) === true : false;
  return {
    consent: {
      form_name: form.name,
      privacy_policy_url: form.privacyPolicyUrl,
      disclaimers,
      captured_at: now.toISOString(),
    },
    whatsappConsent: form.consentCoversWhatsapp === true || byKey,
  };
}

const CONTACT_KEYS = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "phone"]);
const MAX_TIMELINE_ANSWERS = 10;

function cut(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Pure. The text shown in the conversation timeline (rule R14). */
export function leadTimelineBody(
  formName: string,
  platform: string | null,
  a: { fullName: string | null; phoneRaw: string | null; email: string | null; answers: LeadAnswer[] },
): string {
  const p = (platform ?? "").toLowerCase();
  const where = p === "fb" ? "Facebook" : p === "ig" ? "Instagram" : "a Meta advert";
  const lines = [`Filled in the form “${formName}” on ${where}.`];
  if (a.fullName) lines.push(cut(`Name: ${a.fullName}`));
  if (a.phoneRaw) lines.push(cut(`Phone: ${a.phoneRaw}`));
  if (a.email) lines.push(cut(`Email: ${a.email}`));
  const contactValues = new Set(
    [a.fullName, a.phoneRaw, a.email].filter((v): v is string => !!v).map((v) => v.trim().toLowerCase()),
  );
  const others = (a.answers ?? []).filter((x) => {
    if (CONTACT_KEYS.has(x.key.toLowerCase())) return false;
    const joined = x.values.join(", ").trim().toLowerCase();
    return joined !== "" && !contactValues.has(joined);
  });
  for (const x of others.slice(0, MAX_TIMELINE_ANSWERS)) lines.push(cut(`${x.label}: ${x.values.join(", ")}`));
  if (others.length > MAX_TIMELINE_ANSWERS) lines.push(`…and ${others.length - MAX_TIMELINE_ANSWERS} more answers`);
  return lines.join("\n");
}

export type LeadErrorClass = "config" | "temporary" | "gone" | "refusal";

const LEAD_CONFIG_CODES = new Set(["190", "10", "200", "299", "283", "no_page_token"]);
const LEAD_TEMPORARY_CODES = new Set([
  "1", "2", "4", "17", "32", "613",
  "80000", "80001", "80002", "80003", "80004", "80005", "80006", "80007", "80008", "80009", "80014",
]);

/**
 * Classify a failure on a lead call (spec 13 section 3, foundation D10, C2, C3).
 * "gone" is code 100 with a message that does not speak of permissions: on
 * GET /{leadgen-id} that means the lead was deleted or is too old.
 */
export function classifyLeadError(err: unknown): LeadErrorClass {
  if (!(err instanceof MetaApiError)) return "temporary";
  const code = err.code ?? "";
  if (LEAD_CONFIG_CODES.has(code)) return "config";
  if (code === "100") return /permission|leads_retrieval|pages_manage_ads/i.test(err.message) ? "config" : "gone";
  if (LEAD_TEMPORARY_CODES.has(code) || err.status === 429 || err.status >= 500 || err.status === 0) return "temporary";
  return "refusal";
}

/** Meta's code for the record: "<code>/<subcode>", the code, or the HTTP status. */
export function leadErrorCode(err: unknown): string {
  if (!(err instanceof MetaApiError)) return "error";
  if (err.code) return err.subcode ? `${err.code}/${err.subcode}` : err.code;
  return err.status ? `http_${err.status}` : "no_answer";
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** A lead failure as a line a shop worker can act on (spec 13, section 7.4). Pure. */
export function describeLeadError(err: unknown): { code: string; plain: string } {
  const code = leadErrorCode(err);
  const cls = classifyLeadError(err);
  const metaCode = err instanceof MetaApiError ? (err.code ?? "") : "";
  if (metaCode === "190") return { code, plain: "Our connection to Meta has expired. Tell the owner." };
  if (cls === "config") {
    return {
      code,
      plain:
        "Meta says we are not allowed to read leads for this Page. In Meta Business Settings open Integrations → Leads Access, " +
        "choose the Page, and add the suite's system user and app. Also check the system user can create adverts for the Page.",
    };
  }
  if (cls === "temporary") return { code, plain: "Meta is busy. Try again in a few minutes." };
  return { code, plain: `Meta refused: “${errorMessage(err)}” (code ${code}).` };
}

/** Wait before the next try after `attempts` failures: 30 s, 1 min, 2 min, … at most 1 hour. Pure. */
export function leadRetryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts), 3600_000);
}

export type FollowUpBlock = "no_phone" | "no_line" | "no_consent" | "no_template" | "already_sent";

/**
 * Pure. Why the WhatsApp follow-up may not be sent to this lead, in the order
 * rule R19 checks, or null when it may. Consent comes before everything a
 * person could fix by pressing a button.
 */
export function leadFollowUpBlock(f: {
  phoneE164: string | null;
  hasLine: boolean;
  whatsappConsent: boolean;
  templateApproved: boolean;
  followupSentAt: Date | null;
  again: boolean;
}): FollowUpBlock | null {
  if (!f.phoneE164) return "no_phone";
  if (!f.hasLine) return "no_line";
  if (!f.whatsappConsent) return "no_consent";
  if (!f.templateApproved) return "no_template";
  if (f.followupSentAt && !f.again) return "already_sent";
  return null;
}

// ── Owner alert ──────────────────────────────────────────────────────────────

/**
 * Tell the owner once a day that Meta will not let us read leads (same pattern
 * as alertUnknownNumbers and alertOnce; the case is in apps/worker/src/outbox.ts).
 */
export async function alertLeadFetchBlocked(
  db: DbExecutor,
  p: { code: string; message: string; account?: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(and(eq(outboxEvent.eventType, "lead.fetch_blocked"), gt(outboxEvent.createdAt, new Date(now.getTime() - 24 * 3600_000))))
    .limit(1);
  if (recent) return false;
  await db.insert(outboxEvent).values({
    eventType: "lead.fetch_blocked",
    payload: { account: p.account ?? "leads", code: p.code, message: p.message.slice(0, 300) },
  });
  return true;
}

// ── Lines, forms ─────────────────────────────────────────────────────────────

const usableWhatsAppLine = and(
  eq(inboxPhoneNumber.kind, "phone"),
  eq(inboxPhoneNumber.isActive, true),
  isNotNull(inboxPhoneNumber.waPhoneNumberId),
  ne(inboxPhoneNumber.channels, "voice"),
);

export interface LeadLine {
  id: string;
  label: string;
  wabaId: string | null;
}

/**
 * The WhatsApp line for a form's leads (rule R11): the form's own line when it
 * is still a switched-on WhatsApp number, else the oldest switched-on WhatsApp
 * number. Null when there is none.
 */
export async function leadLineFor(db: DbExecutor, formPhoneNumberId: string | null): Promise<LeadLine | null> {
  const cols = { id: inboxPhoneNumber.id, label: inboxPhoneNumber.label, wabaId: inboxPhoneNumber.wabaId };
  if (formPhoneNumberId) {
    const [own] = await db.select(cols).from(inboxPhoneNumber).where(and(eq(inboxPhoneNumber.id, formPhoneNumberId), usableWhatsAppLine));
    if (own) return own;
  }
  const [first] = await db.select(cols).from(inboxPhoneNumber).where(usableWhatsAppLine).orderBy(asc(inboxPhoneNumber.createdAt)).limit(1);
  return first ?? null;
}

/** The approved lead_followup template for a line, in the given language; null when there is none. */
export async function approvedFollowUpTemplate(
  db: DbExecutor,
  line: { wabaId: string | null },
  language: string,
): Promise<{ name: string; language: string; components: unknown[] } | null> {
  const rows = await db
    .select({ name: inboxTemplate.name, language: inboxTemplate.language, status: inboxTemplate.status, components: inboxTemplate.components })
    .from(inboxTemplate)
    .where(
      and(
        eq(inboxTemplate.name, LEAD_FOLLOWUP_TEMPLATE),
        eq(inboxTemplate.language, language),
        ...(line.wabaId ? [eq(inboxTemplate.wabaId, line.wabaId)] : []),
      ),
    );
  const ok = rows.find((t) => t.status.toUpperCase() === "APPROVED");
  return ok ? { name: ok.name, language: ok.language, components: ok.components } : null;
}

type FormRow = typeof leadForm.$inferSelect;

async function upsertForm(db: DbExecutor, pageId: string, f: MetaForm, now: Date): Promise<FormRow> {
  const values = {
    name: f.name,
    pageId,
    status: f.status ?? null,
    locale: f.locale ?? null,
    questions: f.questions,
    privacyPolicyUrl: f.privacy_policy_url ?? null,
    disclaimers: f.disclaimers,
    syncedAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(leadForm)
    .values({ formId: f.id, ...values })
    .onConflictDoUpdate({ target: leadForm.formId, set: values })
    .returning();
  return row!;
}

/**
 * Make sure the lead's form is known (processLead step 3). A failure to read it
 * from Meta does not stop the lead: a placeholder named "Lead form" is kept and
 * the wording is read again with the next lead or the next forms sync.
 */
async function ensureForm(db: DbExecutor, cfg: MetaConfig, pageToken: string | null, formId: string, pageId: string, now: Date): Promise<FormRow> {
  const [existing] = await db.select().from(leadForm).where(eq(leadForm.formId, formId));
  if (existing && existing.questions.length > 0) return existing;
  if (pageToken) {
    try {
      return await upsertForm(db, pageId, await fetchForm(cfg, pageToken, formId), now);
    } catch {
      // fall through to the placeholder
    }
  }
  if (existing) return existing;
  await db.insert(leadForm).values({ formId, pageId, name: DEFAULT_FORM_NAME }).onConflictDoNothing({ target: leadForm.formId });
  const [row] = await db.select().from(leadForm).where(eq(leadForm.formId, formId));
  return row!;
}

/** The Pages we read lead forms for: every switched-on Facebook Page account. */
async function activePages(db: DbExecutor): Promise<{ pageId: string; label: string }[]> {
  const rows = await db
    .select({ pageId: inboxPhoneNumber.externalId, label: inboxPhoneNumber.label })
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.kind, "messenger"), eq(inboxPhoneNumber.isActive, true), isNotNull(inboxPhoneNumber.externalId)))
    .orderBy(asc(inboxPhoneNumber.createdAt));
  return rows.filter((r): r is { pageId: string; label: string } => !!r.pageId);
}

/** The first switched-on Facebook Page account, or null. */
export async function firstLeadPage(db: DbExecutor): Promise<{ pageId: string; label: string } | null> {
  return (await activePages(db))[0] ?? null;
}

const MAX_FORM_READS_PER_SYNC = 50;

/**
 * Read every connected Page's forms from Meta and store them (the Forms dialog's
 * "Refresh forms" and the 6-hourly job). A form's wording is read for new forms
 * and for forms last read more than 24 hours ago (rule R4). Never throws for a
 * Meta refusal: each Page that failed becomes a problem line.
 */
export async function syncLeadForms(
  db: DbClient,
  cfg: MetaConfig,
  now: Date = new Date(),
): Promise<{ forms: number; pages: number; problems: { code: string; plain: string }[] }> {
  const pages = await activePages(db);
  const problems: { code: string; plain: string }[] = [];
  let forms = 0;
  let reads = 0;
  for (const page of pages) {
    try {
      const listed = await withPageTokenRetry(cfg, page.pageId, (token) => listForms(cfg, token, page.pageId));
      for (const f of listed) {
        const [row] = await db
          .insert(leadForm)
          .values({ formId: f.id, pageId: page.pageId, name: f.name })
          .onConflictDoUpdate({ target: leadForm.formId, set: { name: f.name, pageId: page.pageId, updatedAt: now } })
          .returning();
        forms++;
        const stale = !row!.syncedAt || now.getTime() - row!.syncedAt.getTime() > FORM_REFRESH_MS;
        if (!stale || reads >= MAX_FORM_READS_PER_SYNC) continue;
        reads++;
        try {
          const full = await withPageTokenRetry(cfg, page.pageId, (token) => fetchForm(cfg, token, f.id));
          await upsertForm(db, page.pageId, { ...full, id: f.id }, now);
        } catch (err) {
          if (classifyLeadError(err) === "temporary") break; // Meta is busy: the rest wait for the next run
        }
      }
    } catch (err) {
      problems.push(describeLeadError(err));
    }
  }
  return { forms, pages: pages.length, problems };
}

// ── Finishing a lead ─────────────────────────────────────────────────────────

/** The customer for a lead (rules R9, R10). Existing customers are never changed. Runs inside a transaction. */
async function resolveLeadCustomer(
  db: DbExecutor,
  who: { fullName: string | null; phoneE164: string | null; email: string | null },
): Promise<string | null> {
  if (who.phoneE164) {
    const found = await findOrCreateCustomer(db, who.phoneE164, { name: who.fullName, email: who.email, source: "online" });
    return found.id;
  }
  if (!who.email) return null;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`lead-email:${who.email}`}))`);
  const [existing] = await db
    .select({ id: customer.id })
    .from(customer)
    .where(and(isNull(customer.deletedAt), sql`lower(${customer.email}) = ${who.email}`))
    .orderBy(asc(customer.createdAt))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(customer)
    .values({ name: who.fullName, email: who.email, phone: null, source: "online" })
    .returning({ id: customer.id });
  return row!.id;
}

/**
 * Steps 5 and 6 of processLead: map the answers, record the consent and, in one
 * transaction, write the lead, resolve the customer and (for a lead that is not
 * a back-fill, on a switched-on form) open the conversation. Never calls Meta.
 */
async function finishLead(
  db: DbClient,
  leadId: string,
  metaLead: MetaLead,
  form: FormRow,
  extras: LeadExtras,
  now: Date,
): Promise<boolean> {
  const mapped = mapLeadAnswers(metaLead.field_data ?? [], form.questions);
  const { consent, whatsappConsent } = buildConsent(
    {
      name: form.name,
      privacyPolicyUrl: form.privacyPolicyUrl,
      disclaimers: form.disclaimers,
      whatsappConsentKey: form.whatsappConsentKey,
      consentCoversWhatsapp: form.consentCoversWhatsapp,
    },
    metaLead.custom_disclaimer_responses ?? [],
    now,
  );
  const created = metaLead.created_time ? new Date(metaLead.created_time) : null;
  const metaCreatedAt = created && !Number.isNaN(created.getTime()) ? created : null;

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(lead).where(eq(lead.id, leadId)).for("update");
    if (!row || row.fetchState !== "pending") return false;
    const customerId = await resolveLeadCustomer(tx, mapped);
    const adId = metaId(metaLead.ad_id) ?? row.adId;
    await tx
      .update(lead)
      .set({
        answers: mapped.answers,
        fullName: mapped.fullName,
        phoneRaw: mapped.phoneRaw,
        phoneE164: mapped.phoneE164,
        email: mapped.email,
        consent,
        whatsappConsent,
        customerId,
        adId,
        adName: extras.ad_name ?? null,
        adsetId: extras.adset_id ?? null,
        adsetName: extras.adset_name ?? null,
        campaignId: metaId(metaLead.campaign_id) ?? row.campaignId,
        campaignName: extras.campaign_name ?? null,
        platform: extras.platform ?? null,
        // Meta's own word when it gave one; otherwise a lead with no advert is organic.
        isOrganic: extras.is_organic ?? (adId ? null : true),
        metaCreatedAt: metaCreatedAt ?? row.metaCreatedAt,
        pageId: row.pageId ?? form.pageId,
        fetchState: "fetched",
        fetchErrorCode: null,
        fetchError: null,
        updatedAt: now,
      })
      .where(eq(lead.id, leadId));
    if (!row.isBackfill && form.isEnabled) await linkLeadConversation(tx, leadId, { announce: true }, now);
    return true;
  });
}

/**
 * Worker: fetch one pending lead and finish it (rules R5 to R14).
 * "retry" = Meta is busy, try later (the job stops its tick).
 */
export async function processLead(
  db: DbClient,
  cfg: MetaConfig,
  leadId: string,
  now: Date = new Date(),
): Promise<"fetched" | "retry" | "failed" | "gone"> {
  const [row] = await db.select().from(lead).where(eq(lead.id, leadId));
  if (!row) return "gone";
  if (row.fetchState !== "pending") return row.fetchState as "fetched" | "failed" | "gone";

  const pageId = row.pageId ?? (await firstLeadPage(db))?.pageId ?? null;
  const fail = async (state: "failed" | "gone", code: string, message: string) => {
    await db
      .update(lead)
      .set({ fetchState: state, fetchErrorCode: code, fetchError: message.slice(0, 500), updatedAt: now })
      .where(and(eq(lead.id, leadId), eq(lead.fetchState, "pending")));
  };
  if (!pageId) {
    await fail("failed", "no_page", "No Facebook Page is connected.");
    return "failed";
  }

  /** Meta is busy (or we tripped): try again later, with backoff; the eighth failure ends as failed. */
  const retryLater = async (code: string, message: string): Promise<"retry" | "failed"> => {
    const attempts = row.fetchAttempts + 1;
    const exhausted = attempts >= LEAD_MAX_FETCH_ATTEMPTS;
    await db
      .update(lead)
      .set({
        fetchAttempts: attempts,
        ...(exhausted ? { fetchState: "failed" } : { nextFetchAt: new Date(now.getTime() + leadRetryDelayMs(row.fetchAttempts)) }),
        fetchErrorCode: code,
        fetchError: message,
        updatedAt: now,
      })
      .where(and(eq(lead.id, leadId), eq(lead.fetchState, "pending")));
    return exhausted ? "failed" : "retry";
  };

  // 2. The lead itself.
  let metaLead: MetaLead;
  let pageToken: string;
  try {
    [metaLead, pageToken] = await withPageTokenRetry(cfg, pageId, async (token) => [await fetchLead(cfg, token, row.leadgenId), token] as [MetaLead, string]);
  } catch (err) {
    const cls = classifyLeadError(err);
    const code = leadErrorCode(err);
    const message = errorMessage(err);
    if (cls === "temporary") return retryLater(code, message);
    if (cls === "gone") {
      await fail("gone", code, message);
      return "gone";
    }
    await fail("failed", code, message);
    if (cls === "config") await alertLeadFetchBlocked(db, { code, message, account: pageId }, now);
    return "failed";
  }

  try {
    // 3. The form (a failure to read it does not stop the lead). 4. Advert names (best effort).
    const form = await ensureForm(db, cfg, pageToken, row.formId, pageId, now);
    const extras = await fetchLeadExtras(cfg, pageToken, row.leadgenId);
    // 5 and 6.
    await finishLead(db, leadId, metaLead, form, extras, now);
  } catch (err) {
    // Our own trouble (the database, a bug): keep the lead and try again later, never in a tight loop.
    return retryLater("internal", errorMessage(err));
  }
  return "fetched";
}

/**
 * Create or find the conversation for a fetched lead (rules R11 to R13). Runs
 * inside a transaction. Returns null when the lead has no usable phone or there
 * is no WhatsApp line.
 *
 * announce true (a new lead on a switched-on form): the announcing message
 * counts as unread and signals message.created with direction "in", so the
 * existing sound, pop-up and phone push fire. announce false (the "Open
 * conversation" button): no unread, no alert.
 *
 * last_inbound_wa_at is never touched: a lead is not a WhatsApp message from
 * the customer, so the 24-hour window stays closed until they write (D4).
 */
export async function linkLeadConversation(
  db: DbExecutor,
  leadId: string,
  o: { announce: boolean },
  now: Date = new Date(),
): Promise<string | null> {
  const [row] = await db.select().from(lead).where(eq(lead.id, leadId)).for("update");
  if (!row || row.fetchState !== "fetched" || !row.phoneE164) return null;
  const [form] = await db.select().from(leadForm).where(eq(leadForm.formId, row.formId));
  const line = await leadLineFor(db, form?.phoneNumberId ?? null);
  if (!line) return null;

  const customerId =
    row.customerId ??
    (await findOrCreateCustomer(db, row.phoneE164, { name: row.fullName, email: row.email, source: "online" })).id;
  const { conversation } = await findOrOpenConversation(db, customerId, line.id, now);

  // The announcing message, once per lead per conversation.
  const [already] = await db
    .select({ id: inboxMessage.id })
    .from(inboxMessage)
    .where(
      and(
        eq(inboxMessage.conversationId, conversation.id),
        eq(inboxMessage.type, "lead"),
        sql`${inboxMessage.payload} ->> 'lead_id' = ${leadId}`,
      ),
    )
    .limit(1);
  if (!already) {
    const formName = form?.name ?? row.consent?.form_name ?? DEFAULT_FORM_NAME;
    const [msg] = await db
      .insert(inboxMessage)
      .values({
        conversationId: conversation.id,
        direction: "in",
        type: "lead",
        status: "received",
        body: leadTimelineBody(formName, row.platform, row),
        channel: conversation.channel,
        waMessageId: null,
        payload: { lead_id: leadId },
        // Without an alert there is no phone push either.
        notifiedAt: o.announce ? null : now,
        createdAt: now,
      })
      .returning({ id: inboxMessage.id });
    // No inboundWa: the reply window stays closed (rule R13).
    await touchConversation(db, conversation.id, {
      preview: `New lead: ${formName}`,
      ...(o.announce ? { unreadIncrement: true } : {}),
      at: now,
    });
    const [conv] = await db
      .update(inboxConversation)
      .set({
        labels: sql`case when ${LEAD_LABEL} = any(${inboxConversation.labels}) then ${inboxConversation.labels} else array_append(${inboxConversation.labels}, ${LEAD_LABEL}) end`,
      })
      .where(eq(inboxConversation.id, conversation.id))
      .returning();
    if (o.announce) await publishInboxEvent(db, { ...signalFor("message.created", conv!, msg!.id), direction: "in" });
    await publishInboxEvent(db, signalFor("conversation.updated", conv!));
  }

  if (row.conversationId !== conversation.id || row.customerId !== customerId) {
    await db.update(lead).set({ conversationId: conversation.id, customerId, updatedAt: now }).where(eq(lead.id, leadId));
  }
  return conversation.id;
}

// ── Worker passes ────────────────────────────────────────────────────────────

/**
 * lead_fetch: up to `limit` pending leads that are due, oldest first. Stops at
 * the first temporary error (Meta is busy; the rest wait for the next tick).
 */
export async function fetchPendingLeads(
  db: DbClient,
  cfg: MetaConfig,
  o: { limit?: number; now?: Date } = {},
): Promise<{ fetched: number; failed: number; gone: number; retry: number }> {
  const now = o.now ?? new Date();
  const due = await db
    .select({ id: lead.id })
    .from(lead)
    .where(and(eq(lead.fetchState, "pending"), lte(lead.nextFetchAt, now)))
    .orderBy(asc(lead.createdAt))
    .limit(o.limit ?? 10);
  const out = { fetched: 0, failed: 0, gone: 0, retry: 0 };
  for (const l of due) {
    const r = await processLead(db, cfg, l.id, now);
    out[r]++;
    if (r === "retry") break;
  }
  return out;
}

/**
 * lead_backfill: one page (100 leads) for one form that asked for its earlier
 * leads (rule R21). Each lead not already stored is saved as is_backfill and
 * finished from the page's own data: no call per lead, no conversation, no
 * alert, no message. Returns what happened, or null when nothing is waiting.
 */
export async function backfillLeadsPage(
  db: DbClient,
  cfg: MetaConfig,
  now: Date = new Date(),
): Promise<{ formId: string; stored: number; done: boolean; stopped: boolean } | null> {
  const [form] = await db
    .select()
    .from(leadForm)
    .where(and(isNotNull(leadForm.backfillRequestedAt), isNull(leadForm.backfillDoneAt)))
    .orderBy(asc(leadForm.backfillRequestedAt))
    .limit(1);
  if (!form) return null;
  // The window is fixed when the back-fill is asked for, so every page uses the same start.
  const since = new Date((form.backfillRequestedAt ?? now).getTime() - LEAD_BACKFILL_DAYS * 86_400_000);

  let page: { leads: MetaLead[]; after: string | null };
  let pageToken: string;
  try {
    [page, pageToken] = await withPageTokenRetry(cfg, form.pageId, async (token) => [
      await listFormLeads(cfg, token, form.formId, {
        sinceUnix: Math.floor(since.getTime() / 1000),
        ...(form.backfillCursor ? { after: form.backfillCursor } : {}),
      }),
      token,
    ] as [{ leads: MetaLead[]; after: string | null }, string]);
  } catch (err) {
    if (classifyLeadError(err) === "temporary") return { formId: form.formId, stored: 0, done: false, stopped: false };
    // Configuration problem or refusal: stop, say why, tell the owner once.
    const code = leadErrorCode(err);
    const message = errorMessage(err);
    await db
      .update(leadForm)
      .set({ backfillDoneAt: now, backfillError: `${code}: ${message}`.slice(0, 500), updatedAt: now })
      .where(eq(leadForm.id, form.id));
    if (classifyLeadError(err) === "config") await alertLeadFetchBlocked(db, { code, message, account: form.pageId }, now);
    return { formId: form.formId, stored: 0, done: true, stopped: true };
  }

  // Step 3 of processLead, once for the page: the form's questions.
  const known = page.leads.length > 0 ? await ensureForm(db, cfg, pageToken, form.formId, form.pageId, now) : form;
  let stored = 0;
  for (const l of page.leads) {
    const leadgenId = metaId(l.id);
    if (!leadgenId) continue;
    const created = l.created_time ? new Date(l.created_time) : null;
    const [inserted] = await db
      .insert(lead)
      .values({
        leadgenId,
        formId: form.formId,
        pageId: form.pageId,
        adId: metaId(l.ad_id),
        campaignId: metaId(l.campaign_id),
        metaCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
        isBackfill: true,
        fetchState: "pending",
        // Finished just below from this page's data. If that is interrupted, lead_fetch picks it up later.
        nextFetchAt: new Date(now.getTime() + 5 * 60_000),
      })
      .onConflictDoNothing({ target: lead.leadgenId })
      .returning({ id: lead.id });
    if (!inserted) continue; // already stored from the webhook or an earlier page (rule R8)
    if (await finishLead(db, inserted.id, l, known, {}, now)) stored++;
  }
  await db
    .update(leadForm)
    .set({
      backfillCursor: page.after,
      backfillCount: sql`${leadForm.backfillCount} + ${stored}`,
      backfillError: null,
      ...(page.after ? {} : { backfillDoneAt: now }),
      updatedAt: now,
    })
    .where(eq(leadForm.id, form.id));
  return { formId: form.formId, stored, done: !page.after, stopped: false };
}

