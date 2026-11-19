/**
 * Ads, Phase A (suite spec 12, sections 5.4 to 5.6): which chats came from an
 * advert, which paid shop orders those chats led to, and (only when the owner
 * has switched it on) telling Meta that a purchase happened.
 *
 * Touches are read from what the inbox has ALREADY stored (the WhatsApp
 * message's raw `referral`, and the stored Page / Instagram webhook events),
 * so the two ingest files are not changed and a failure here can never lose a
 * customer's message.
 *
 * What is sent to Meta, and when:
 *   - nothing at all unless ads_settings.capi_enabled is true AND the owner has
 *     ticked the privacy statement;
 *   - then, for a paid order from a customer who tapped a WhatsApp advert:
 *     the amount, the time, the WhatsApp account ID and the click ID Meta
 *     itself issued for that tap. Never a phone number, a name, an email, an
 *     address, an order number or what was bought, hashed or not.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  adOrderAttribution,
  adTouch,
  customer,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  inboxWebhookEvent,
  payment,
  saleOrder,
  type AdsSettingsValue,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import { extractAdReferrals, money } from "@ms/shared";
import { MetaApiError, graph, type MetaConfig } from "../inbox/meta.js";
import { publishInboxEvent, signalFor } from "../inbox/core.js";
import { channelAccountByExternalId } from "./accounts.js";
import {
  ADS_CONFIG_CODES,
  adsMetaCode,
  classifyAdsError,
  getAdsSettings,
  newAdRequestId,
  patchAdsSettings,
  raiseAdsAlert,
  writeAdLog,
  type AdsLog,
} from "./ads.js";

const SCAN_DAYS = 3;

interface WaReferral {
  source_url?: unknown;
  source_id?: unknown;
  source_type?: unknown;
  headline?: unknown;
  body?: unknown;
  media_type?: unknown;
  ctwa_clid?: unknown;
}

function text(v: unknown, max = 1000): string | null {
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

async function signalConversation(db: DbClient, conversationId: string | null): Promise<void> {
  if (!conversationId) return;
  const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
  if (conv) await publishInboxEvent(db, signalFor("conversation.updated", conv));
}

/** Create ad_touch rows for advert referrals not yet recorded. Idempotent. Returns how many were created. */
export async function scanAdTouches(db: DbClient, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - SCAN_DAYS * 24 * 3600_000);
  let created = 0;

  // WhatsApp: the raw message is kept in inbox_message.payload, referral and all.
  const waRows = await db
    .select({
      messageId: inboxMessage.id,
      payload: inboxMessage.payload,
      createdAt: inboxMessage.createdAt,
      conversationId: inboxConversation.id,
      customerId: inboxConversation.customerId,
      wabaId: inboxPhoneNumber.wabaId,
    })
    .from(inboxMessage)
    .innerJoin(inboxConversation, eq(inboxConversation.id, inboxMessage.conversationId))
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
    .where(
      and(
        eq(inboxMessage.direction, "in"),
        eq(inboxConversation.channel, "whatsapp"),
        sql`${inboxMessage.createdAt} > ${since.toISOString()}::timestamptz`,
        sql`${inboxMessage.payload} ? 'referral'`,
        sql`not exists (select 1 from ad_touch t where t.source_key = 'msg:' || ${inboxMessage.id}::text)`,
      ),
    )
    .limit(500);
  for (const m of waRows) {
    const ref = (m.payload as { referral?: WaReferral } | null)?.referral;
    if (!ref || typeof ref !== "object") continue;
    const sourceType = text(ref.source_type, 40) ?? "ad";
    const sourceId = text(ref.source_id, 200);
    const [row] = await db
      .insert(adTouch)
      .values({
        sourceKey: `msg:${m.messageId}`,
        channel: "whatsapp",
        customerId: m.customerId,
        conversationId: m.conversationId,
        sourceType,
        adExternalId: sourceType === "ad" ? sourceId : null,
        postExternalId: sourceType === "post" ? sourceId : null,
        headline: text(ref.headline, 300),
        body: text(ref.body, 1000),
        sourceUrl: text(ref.source_url, 1000),
        mediaType: text(ref.media_type, 40),
        ctwaClid: text(ref.ctwa_clid, 500),
        accountExternalId: m.wabaId,
        touchedAt: m.createdAt,
      })
      .onConflictDoNothing({ target: adTouch.sourceKey })
      .returning({ id: adTouch.id });
    if (row) {
      created++;
      await signalConversation(db, m.conversationId);
    }
  }

  // Messenger and Instagram: the stored webhook events. The stored `kind` is a
  // label made from the first item only, so it is not used to choose events
  // (foundation ruling 9.2.3); any processed event that mentions a referral is read.
  const events = await db
    .select({ id: inboxWebhookEvent.id, kind: inboxWebhookEvent.kind, payload: inboxWebhookEvent.payload, receivedAt: inboxWebhookEvent.receivedAt })
    .from(inboxWebhookEvent)
    .where(
      and(
        eq(inboxWebhookEvent.source, "meta"),
        sql`${inboxWebhookEvent.processedAt} is not null`,
        sql`${inboxWebhookEvent.receivedAt} > ${since.toISOString()}::timestamptz`,
        sql`${inboxWebhookEvent.payload}::text like '%"referral"%'`,
      ),
    )
    .orderBy(inboxWebhookEvent.receivedAt)
    .limit(1000);
  for (const ev of events) {
    const object = (ev.payload as { object?: unknown }).object;
    const channel =
      object === "page" || (object == null && ev.kind.startsWith("page."))
        ? ("messenger" as const)
        : object === "instagram" || (object == null && ev.kind.startsWith("instagram."))
          ? ("instagram" as const)
          : null;
    if (!channel) continue;
    for (const r of extractAdReferrals(ev.kind, ev.payload)) {
      const sourceKey = `evt:${ev.id}:${r.index}`;
      const [seen] = await db.select({ id: adTouch.id }).from(adTouch).where(eq(adTouch.sourceKey, sourceKey)).limit(1);
      if (seen) continue;
      // The identity is written when the inbox processes the customer's first
      // message; until then this referral waits (it is looked at again for 3 days).
      const [identity] = await db
        .select({ customerId: inboxIdentity.customerId })
        .from(inboxIdentity)
        .where(
          and(
            eq(inboxIdentity.channel, channel),
            eq(inboxIdentity.accountExternalId, r.accountExternalId),
            eq(inboxIdentity.externalId, r.senderId),
          ),
        )
        .limit(1);
      if (!identity) continue;
      const account = await channelAccountByExternalId(db, channel, r.accountExternalId);
      let conversationId: string | null = null;
      if (account) {
        const [conv] = await db
          .select({ id: inboxConversation.id })
          .from(inboxConversation)
          .where(and(eq(inboxConversation.customerId, identity.customerId), eq(inboxConversation.phoneNumberId, account.id)))
          .orderBy(desc(inboxConversation.lastActivityAt))
          .limit(1);
        conversationId = conv?.id ?? null;
      }
      const [row] = await db
        .insert(adTouch)
        .values({
          sourceKey,
          channel,
          customerId: identity.customerId,
          conversationId,
          sourceType: "ad",
          adExternalId: r.adId,
          headline: r.headline,
          accountExternalId: r.accountExternalId,
          senderExternalId: r.senderId,
          touchedAt: r.at ?? ev.receivedAt,
        })
        .onConflictDoNothing({ target: adTouch.sourceKey })
        .returning({ id: adTouch.id });
      if (row) {
        created++;
        await signalConversation(db, conversationId);
      }
    }
  }
  return created;
}

/**
 * Tie paid shop orders to advert taps (section 5.5). An order is credited when:
 *   1. it is paid, not cancelled, not a draft, and has a customer;
 *   2. a tap exists for the same customer record (read through the tap's
 *      conversation when it has one, so a merge carries the credit with it);
 *   3. the tap came before the order, and no more than `windowDays` before;
 *   4. the most recent such tap gets the whole order ("last advert wins").
 * An order is never split, never credited twice, and never moved afterwards.
 */
export async function attributeOrders(db: DbClient, windowDays: number, now: Date = new Date()): Promise<number> {
  const days = Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 28 ? windowDays : 7;
  const rule = `last_touch_${days}d`;
  const nowIso = now.toISOString();
  const rows = await db.execute<{ id: string }>(sql`
    insert into ad_order_attribution (sale_order_id, touch_id, rule, order_at, value_ngn, capi_status)
    select o.id, t.id, ${rule}, o.created_at, o.subtotal_ngn, 'none'
    from sale_order o
    join lateral (
      select t.id
      from ad_touch t
      left join inbox_conversation c on c.id = t.conversation_id
      where coalesce(c.customer_id, t.customer_id) = o.customer_id
        and t.touched_at <= o.created_at
        and t.touched_at >= o.created_at - make_interval(days => ${days})
      order by t.touched_at desc, t.created_at desc
      limit 1
    ) t on true
    where o.payment_status = 'paid'
      and o.status not in ('cancelled', 'draft')
      and o.customer_id is not null
      and o.created_at > ${nowIso}::timestamptz - make_interval(days => ${days + 3})
      and not exists (select 1 from ad_order_attribution a where a.sale_order_id = o.id)
    on conflict (sale_order_id) do nothing
    returning id
  `);
  return (rows as unknown as { id: string }[]).length;
}

// ── Reporting purchases to Meta ──────────────────────────────────────────────

/** POST /{wabaId}/dataset: creates the dataset, or returns the one that exists (E2). */
export async function ensureDataset(cfg: MetaConfig, wabaId: string): Promise<string> {
  const res = await graph<{ id?: string }>(cfg, "POST", `${wabaId}/dataset`, {});
  if (!res?.id) throw new MetaApiError("Meta did not return a dataset", 200, null, false, "not_sent");
  return String(res.id);
}

/**
 * The whole event. Exactly these fields: nothing that names the customer.
 * `ctwaClid` is the click ID Meta issued for the advert tap.
 */
export function buildPurchaseEvent(input: {
  channel: "whatsapp";
  wabaId: string;
  ctwaClid: string;
  valueNgn: number;
  at: Date;
}): Record<string, unknown> {
  return {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(input.at.getTime() / 1000),
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: { whatsapp_business_account_id: input.wabaId, ctwa_clid: input.ctwaClid },
        custom_data: { currency: "NGN", value: input.valueNgn },
      },
    ],
  };
}

/** The event as kept in the log: the click ID is cut to its first 6 characters. */
export function redactPurchaseEvent(event: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(event)) as { data?: { user_data?: { ctwa_clid?: string } }[] };
  for (const d of copy.data ?? []) {
    if (d.user_data && typeof d.user_data.ctwa_clid === "string") d.user_data.ctwa_clid = `${d.user_data.ctwa_clid.slice(0, 6)}…`;
  }
  return copy as Record<string, unknown>;
}

export const CAPI_NOTES = {
  notWhatsApp: "Only WhatsApp purchases are reported.",
  noClickId: "This advert tap had no click code (for example a WhatsApp Status advert).",
  blocked: "A staff member chose not to report this customer.",
  removed: "This customer record was removed.",
  tooOld: "Too old to report.",
  noPermission: "Meta has not given the suite permission to report purchases.",
  notPaid: "The order is no longer paid.",
} as const;

const REPORT_MAX_AGE_MS = 7 * 24 * 3600_000;

/** Is purchase reporting switched on, with the owner's privacy statement on record? */
export function capiAllowed(settings: AdsSettingsValue): boolean {
  return settings.capi_enabled === true && !!settings.capi_privacy_confirmed_at && !!settings.capi_privacy_confirmed_by;
}

interface ReportCandidate {
  id: string;
  orderAt: Date;
  valueNgn: number;
  saleOrderId: string;
  paymentStatus: string;
  orderStatus: string;
  orderCreatedAt: Date;
  channel: string;
  ctwaClid: string | null;
  wabaId: string | null;
  blockedAt: Date | null;
  customerDeletedAt: Date | null;
}

function candidates(db: DbClient, status: "none" | "queued", limit: number): Promise<ReportCandidate[]> {
  return db
    .select({
      id: adOrderAttribution.id,
      orderAt: adOrderAttribution.orderAt,
      valueNgn: adOrderAttribution.valueNgn,
      saleOrderId: saleOrder.id,
      paymentStatus: saleOrder.paymentStatus,
      orderStatus: saleOrder.status,
      orderCreatedAt: saleOrder.createdAt,
      channel: adTouch.channel,
      ctwaClid: adTouch.ctwaClid,
      wabaId: adTouch.accountExternalId,
      blockedAt: adTouch.reportingBlockedAt,
      customerDeletedAt: customer.deletedAt,
    })
    .from(adOrderAttribution)
    .innerJoin(saleOrder, eq(saleOrder.id, adOrderAttribution.saleOrderId))
    .innerJoin(adTouch, eq(adTouch.id, adOrderAttribution.touchId))
    .innerJoin(customer, eq(customer.id, saleOrder.customerId))
    .where(eq(adOrderAttribution.capiStatus, status))
    .orderBy(adOrderAttribution.createdAt)
    .limit(limit) as unknown as Promise<ReportCandidate[]>;
}

/** The first reason this order must not be reported, or null when it may be. Checked when queueing AND again just before sending. */
function skipReason(c: ReportCandidate, now: Date): string | null {
  if (c.channel !== "whatsapp") return CAPI_NOTES.notWhatsApp;
  if (!c.ctwaClid || !c.wabaId) return CAPI_NOTES.noClickId;
  if (c.blockedAt) return CAPI_NOTES.blocked;
  if (c.customerDeletedAt) return CAPI_NOTES.removed;
  if (now.getTime() - c.orderAt.getTime() > REPORT_MAX_AGE_MS) return CAPI_NOTES.tooOld;
  return null;
}

function stillPaid(c: ReportCandidate): boolean {
  return c.paymentStatus === "paid" && c.orderStatus !== "cancelled" && c.orderStatus !== "draft";
}

/**
 * Decide, for each attributed order not yet looked at, whether it will be
 * reported. Does nothing while reporting is switched off (rows stay 'none', so
 * an order is still reported if the owner turns reporting on within 7 days).
 */
export async function queuePurchaseReports(db: DbClient, settings: AdsSettingsValue, now: Date = new Date()): Promise<number> {
  if (!capiAllowed(settings)) return 0;
  let queued = 0;
  for (const c of await candidates(db, "none", 200)) {
    if (!stillPaid(c)) continue;
    const reason = skipReason(c, now);
    const [row] = await db
      .update(adOrderAttribution)
      .set(reason ? { capiStatus: "skipped", capiNote: reason } : { capiStatus: "queued", capiNote: null })
      .where(and(eq(adOrderAttribution.id, c.id), eq(adOrderAttribution.capiStatus, "none")))
      .returning({ id: adOrderAttribution.id });
    if (row && !reason) queued++;
  }
  return queued;
}

/**
 * Send queued purchase events, one per order, ever (Meta does not remove
 * duplicates). Foundation rule 9: claim the row, write the log, call Meta,
 * record the result. A call with no answer is 'unknown' and is never retried.
 */
export async function sendPurchaseReports(
  db: DbClient,
  cfg: MetaConfig,
  settings: AdsSettingsValue,
  log: AdsLog,
  now: Date = new Date(),
): Promise<number> {
  // A row left 'sending' (the process stopped mid-call) may have reached Meta: never send it again.
  await db
    .update(adOrderAttribution)
    .set({ capiStatus: "unknown", capiNote: "Meta did not answer, so we cannot tell if this was reported." })
    .where(and(eq(adOrderAttribution.capiStatus, "sending"), sql`${adOrderAttribution.capiLockedAt} < now() - interval '5 minutes'`));

  // The switch is read again from the database, so turning it off stops the very next send.
  if (!capiAllowed(settings)) return 0;
  let live = await getAdsSettings(db);
  if (!capiAllowed(live)) return 0;

  let sent = 0;
  for (const c of await candidates(db, "queued", 20)) {
    // Things may have changed since it was queued: a staff member's "do not report", a refund, an erased customer.
    const reason = !stillPaid(c) ? CAPI_NOTES.notPaid : skipReason(c, now);
    if (reason) {
      await db
        .update(adOrderAttribution)
        .set({ capiStatus: "skipped", capiNote: reason })
        .where(and(eq(adOrderAttribution.id, c.id), eq(adOrderAttribution.capiStatus, "queued")));
      continue;
    }
    // 1. Claim.
    const [claimed] = await db
      .update(adOrderAttribution)
      .set({ capiStatus: "sending", capiLockedAt: new Date(), capiAttempts: sql`${adOrderAttribution.capiAttempts} + 1` })
      .where(and(eq(adOrderAttribution.id, c.id), eq(adOrderAttribution.capiStatus, "queued")))
      .returning({ attempts: adOrderAttribution.capiAttempts });
    if (!claimed) continue;

    const [paid] = await db
      .select({ paidAt: payment.paidAt })
      .from(payment)
      .where(and(eq(payment.saleOrderId, c.saleOrderId), eq(payment.status, "paid")))
      .orderBy(desc(payment.paidAt))
      .limit(1);
    const wabaId = c.wabaId!;
    const event = buildPurchaseEvent({
      channel: "whatsapp",
      wabaId,
      ctwaClid: c.ctwaClid!,
      valueNgn: c.valueNgn,
      at: paid?.paidAt ?? c.orderCreatedAt,
    });

    // 2. The log row is written (and committed) before anything is sent.
    const requestId = newAdRequestId();
    const logBase = {
      requestId,
      actorKind: "system" as const,
      actorName: "The suite",
      action: "report_purchase",
      objectLevel: "order",
      objectExternalId: c.saleOrderId,
      summary: `Told Meta about a purchase of ${money(c.valueNgn, "NGN")} that came from an advert.`,
      currency: "NGN",
      request: redactPurchaseEvent(event),
    };
    await writeAdLog(db, { ...logBase, phase: "requested" });

    const finish = async (
      status: "sent" | "queued" | "failed" | "unknown",
      note: string | null,
      outcome: "ok" | "refused" | "unknown",
      err?: MetaApiError,
    ) => {
      await db
        .update(adOrderAttribution)
        .set({ capiStatus: status, capiNote: note, capiLockedAt: null, ...(status === "sent" ? { capiSentAt: new Date() } : {}) })
        .where(eq(adOrderAttribution.id, c.id));
      await writeAdLog(db, {
        ...logBase,
        phase: "result",
        outcome,
        metaCode: err ? adsMetaCode(err) : null,
        metaMessage: err ? err.message : null,
      });
    };

    let stage: "dataset" | "event" = "dataset";
    try {
      // 3. The dataset for this WhatsApp account.
      let datasetId = live.datasets[wabaId];
      if (!datasetId) {
        datasetId = await ensureDataset(cfg, wabaId);
        live = await db.transaction(async (tx) => {
          const cur = await getAdsSettings(tx);
          return patchAdsSettings(tx, { datasets: { ...cur.datasets, [wabaId]: datasetId! } });
        });
      }
      // 4. The event.
      stage = "event";
      await graph(cfg, "POST", `${datasetId}/events`, event);
      await finish("sent", null, "ok");
      sent++;
    } catch (err) {
      if (!(err instanceof MetaApiError)) {
        // Our own failure after the claim: we cannot be sure nothing was sent.
        await finish("unknown", "Meta did not answer, so we cannot tell if this was reported.", "unknown");
        throw err;
      }
      // No answer while asking for the dataset: the event itself was never sent, so trying again is safe.
      const raw = classifyAdsError(err);
      const cls = raw === "unknown" && stage === "dataset" ? "temporary" : raw;
      if (cls === "unknown") {
        await finish("unknown", "Meta did not answer, so we cannot tell if this was reported.", "unknown", err);
      } else if (cls === "temporary" && claimed.attempts < 4) {
        await finish("queued", null, "refused", err);
      } else if (ADS_CONFIG_CODES.has(err.code ?? "")) {
        await finish("failed", CAPI_NOTES.noPermission, "refused", err);
        await raiseAdsAlert(db, "ads.config_error", {
          account: wabaId,
          code: adsMetaCode(err) ?? "",
          message: err.message.slice(0, 500),
          area: "purchases",
        });
        log.warn({ code: err.code }, "ads: Meta refused a purchase report (permission)");
        // Every other row would be refused the same way: stop this run.
        break;
      } else {
        await finish("failed", `${adsMetaCode(err) ?? "error"}: ${err.message}`.slice(0, 500), "refused", err);
      }
    }
  }
  return sent;
}

// ── Contact erase and merge (foundation ruling 9.2.8) ────────────────────────

/**
 * Erase: remove every advert tap recorded for a customer (and, by cascade, the
 * order credits and click IDs that hang off them). Taps tied to a conversation
 * go when the conversation is deleted; this also removes the ones with none.
 * Nothing is sent to Meta about it.
 */
export async function eraseAdTouchesForCustomer(db: DbExecutor, customerId: string): Promise<number> {
  const rows = await db.delete(adTouch).where(eq(adTouch.customerId, customerId)).returning({ id: adTouch.id });
  return rows.length;
}

/** Merge: a thread is being folded into another one. Its taps move with it, or deleting the thread would take them too. */
export async function moveAdTouchesToConversation(
  db: DbExecutor,
  fromConversationId: string,
  toConversationId: string,
  intoCustomerId: string,
): Promise<void> {
  await db
    .update(adTouch)
    .set({ conversationId: toConversationId, customerId: intoCustomerId })
    .where(eq(adTouch.conversationId, fromConversationId));
}

/** Merge: every tap of the old contact now belongs to the kept contact, so order credit follows. */
export async function moveAdTouchesToCustomer(db: DbExecutor, fromCustomerId: string, intoCustomerId: string): Promise<void> {
  await db.update(adTouch).set({ customerId: intoCustomerId }).where(eq(adTouch.customerId, fromCustomerId));
}
