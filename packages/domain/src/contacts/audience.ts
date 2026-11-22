/**
 * Who a broadcast would go to (suite spec 14, rules R46 to R52). Pure reads: nothing
 * here writes or sends. `buildAudience` reads the facts for every list member in one
 * query and `decideAudience` gives each the first reason that applies, so the rules
 * themselves can be tested without a database.
 */
import { eq, sql } from "drizzle-orm";
import { contactList, inboxPhoneNumber, type DbExecutor } from "@ms/db";
import { parseContactFilter, perDayFor, type BroadcastSettings, type ContactFilter } from "@ms/shared";
import { whatsappRecipient } from "../inbox/send.js";
import { listMembersSql } from "./filter.js";

export interface AudienceRow {
  customerId: string;
  name: string | null;
  /** The WhatsApp number (digits) or user ID the message would go to. */
  toWa: string | null;
  /** The phone shown on screen. */
  phone: string | null;
  /** null = will send. */
  reason: string | null;
}

/** The facts about one list member that the rules read. */
export interface AudienceFacts {
  customerId: string;
  name: string | null;
  phone: string | null;
  createdAt: Date;
  /** Their newest WhatsApp identity's external ID, if any. */
  waExternalId: string | null;
  /** The current WhatsApp promotions answer: "granted", "withdrawn" or null (not asked). */
  consent: string | null;
  waUnreachable: boolean;
  lastOrderAt: Date | null;
  ordersCount: number;
  /** Sent another promotion broadcast inside the owner's gap. */
  recentPromotion: boolean;
  /** WhatsApp held back a promotion to them (131049) in the last 24 hours. */
  heldBack: boolean;
}

/** The address a member's broadcast message goes to, as stored on the recipient row. */
export function audienceAddress(waExternalId: string | null, phone: string | null): string | null {
  const to = whatsappRecipient(waExternalId ? { channel: "whatsapp", externalId: waExternalId } : null, phone);
  if (!to) return null;
  return typeof to === "string" ? to : to.bsuid;
}

/**
 * R47: each member gets the FIRST reason that applies, in this order, or none.
 * `facts` must be ordered oldest contact first so the oldest keeps a shared number.
 */
export function decideAudience(
  facts: readonly AudienceFacts[],
  o: { category: string; settings: Pick<BroadcastSettings, "audience_rule" | "recent_customer_months" | "min_days_between">; now: Date },
): AudienceRow[] {
  const marketing = o.category.toUpperCase() === "MARKETING";
  const recentCutoff = new Date(o.now.getTime());
  recentCutoff.setUTCMonth(recentCutoff.getUTCMonth() - o.settings.recent_customer_months);
  const seen = new Set<string>();
  const out: AudienceRow[] = [];
  for (const f of facts) {
    const toWa = audienceAddress(f.waExternalId, f.phone);
    let reason: string | null = null;
    if (!toWa) reason = "no_phone";
    else if (f.consent === "withdrawn") reason = "opted_out";
    else if (f.waUnreachable) reason = "not_whatsapp";
    else if (marketing) {
      const recentCustomer =
        o.settings.audience_rule === "consent_or_recent_customer" && f.lastOrderAt !== null && f.lastOrderAt.getTime() >= recentCutoff.getTime();
      if (f.consent !== "granted" && !recentCustomer) reason = "no_consent";
    } else if (f.ordersCount === 0 && !f.waExternalId) {
      // An update template: only a stranger (no order, never on WhatsApp with us) is left out.
      reason = "no_consent";
    }
    // Any earlier member holds the number, even one left out for another reason: a number
    // whose earlier owner asked us to stop is not sent to under a second record.
    if (!reason && toWa && seen.has(toWa)) reason = "duplicate_number";
    if (!reason && marketing && o.settings.min_days_between > 0 && f.recentPromotion) reason = "recent";
    if (!reason && f.heldBack) reason = "held_back";
    if (toWa) seen.add(toWa);
    out.push({ customerId: f.customerId, name: f.name, toWa, phone: f.phone, reason });
  }
  return out;
}

export interface AudienceList {
  id: string;
  kind: "static" | "smart";
  filter: ContactFilter | null;
}

/** A list row read for a broadcast; null when it is gone. */
export async function loadAudienceList(db: DbExecutor, listId: string): Promise<(AudienceList & { name: string; archivedAt: Date | null }) | null> {
  const [l] = await db.select().from(contactList).where(eq(contactList.id, listId));
  if (!l) return null;
  const kind = l.kind === "smart" ? "smart" : "static";
  const parsed = kind === "smart" ? parseContactFilter(l.filter ?? {}, { forSmartList: true }) : null;
  return { id: l.id, name: l.name, kind, filter: parsed && parsed.ok ? parsed.filter : null, archivedAt: l.archivedAt ?? null };
}

/** How many people a list holds now (R50 refuses more than 20,000). */
export async function audienceListCount(db: DbExecutor, list: AudienceList, now: Date): Promise<number> {
  const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM (${listMembersSql(list, now)}) m`)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * The list's members with the reason each would be skipped (R46, R47). Pure read.
 * `broadcastId` is left out of the "recent" check, so a broadcast never counts itself.
 */
export async function buildAudience(
  db: DbExecutor,
  b: { listId: string; phoneNumberId: string; templateCategory: string; broadcastId: string },
  s: BroadcastSettings,
  now: Date,
): Promise<AudienceRow[]> {
  const list = await loadAudienceList(db, b.listId);
  if (!list) return [];
  const gapSince = new Date(now.getTime() - s.min_days_between * 86_400_000);
  const heldSince = new Date(now.getTime() - 24 * 3600_000);
  const rows = (await db.execute(sql`
    SELECT c.id AS customer_id, c.name, c.phone, c.created_at,
      (SELECT i.external_id FROM inbox_identity i WHERE i.customer_id = c.id AND i.channel = 'whatsapp'
        ORDER BY i.updated_at DESC NULLS LAST, i.created_at DESC LIMIT 1) AS wa_external_id,
      (SELECT k.state FROM contact_consent k WHERE k.customer_id = c.id AND k.channel = 'whatsapp' AND k.purpose = 'marketing' AND k.is_current
        LIMIT 1) AS consent,
      (s.wa_unreachable_at IS NOT NULL) AS wa_unreachable,
      s.last_order_at, coalesce(s.orders_count, 0)::int AS orders_count,
      EXISTS (SELECT 1 FROM broadcast_recipient r JOIN broadcast ob ON ob.id = r.broadcast_id
        WHERE r.customer_id = c.id AND ob.id <> ${b.broadcastId}::uuid AND upper(coalesce(ob.template_category, '')) = 'MARKETING'
          AND r.sent_at IS NOT NULL AND r.sent_at >= ${gapSince.toISOString()}::timestamptz) AS recent_promotion,
      EXISTS (SELECT 1 FROM broadcast_recipient r WHERE r.customer_id = c.id AND r.error_code = '131049'
          AND r.failed_at >= ${heldSince.toISOString()}::timestamptz) AS held_back
    FROM (${listMembersSql(list, now)}) m
    JOIN customer c ON c.id = m.customer_id
    LEFT JOIN contact_summary s ON s.customer_id = c.id
    WHERE c.deleted_at IS NULL
    ORDER BY c.created_at ASC, c.id ASC`)) as unknown as {
    customer_id: string;
    name: string | null;
    phone: string | null;
    created_at: string | Date;
    wa_external_id: string | null;
    consent: string | null;
    wa_unreachable: boolean;
    last_order_at: string | Date | null;
    orders_count: number;
    recent_promotion: boolean;
    held_back: boolean;
  }[];
  const facts: AudienceFacts[] = rows.map((r) => ({
    customerId: r.customer_id,
    name: r.name,
    phone: r.phone,
    createdAt: new Date(r.created_at),
    waExternalId: r.wa_external_id,
    consent: r.consent,
    waUnreachable: r.wa_unreachable === true,
    lastOrderAt: r.last_order_at ? new Date(r.last_order_at) : null,
    ordersCount: Number(r.orders_count ?? 0),
    recentPromotion: r.recent_promotion === true,
    heldBack: r.held_back === true,
  }));
  return decideAudience(facts, { category: b.templateCategory, settings: s, now });
}

/**
 * R51: how many new people today's sending may still reach. The WhatsApp limit is
 * shared by every number of the business, so templates sent from ANY line of the
 * same account in the last 24 hours count against it (inbox sends included).
 */
export async function dailyAllowance(
  db: DbExecutor,
  lineId: string,
  s: Pick<BroadcastSettings, "daily_share">,
  now: Date,
): Promise<{ tier: string | null; perDay: number; used24h: number; leftToday: number }> {
  const [line] = await db
    .select({ tier: inboxPhoneNumber.messagingLimit, wabaId: inboxPhoneNumber.wabaId })
    .from(inboxPhoneNumber)
    .where(eq(inboxPhoneNumber.id, lineId));
  const tier = line?.tier ?? null;
  const perDay = perDayFor(tier, s.daily_share);
  const since = new Date(now.getTime() - 24 * 3600_000);
  const sameAccount = line?.wabaId
    ? sql`p.waba_id = ${line.wabaId}`
    : sql`p.id = ${lineId}::uuid`;
  const rows = (await db.execute(sql`
    SELECT count(DISTINCT c.customer_id)::int AS n
    FROM inbox_message m
    JOIN inbox_conversation c ON c.id = m.conversation_id
    JOIN inbox_phone_number p ON p.id = c.phone_number_id
    WHERE ${sameAccount} AND m.direction = 'out' AND m.type = 'template' AND m.status <> 'failed'
      AND m.created_at > ${since.toISOString()}::timestamptz AND m.created_at <= ${now.toISOString()}::timestamptz`)) as unknown as { n: number }[];
  const used24h = Number(rows[0]?.n ?? 0);
  return { tier, perDay, used24h, leftToday: Math.max(0, perDay - used24h) };
}
