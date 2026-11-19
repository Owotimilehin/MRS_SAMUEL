/**
 * Messenger and Instagram background jobs (suite spec 02, section 6):
 *   - refreshIdentityProfiles: fill in the names and pictures Meta gives us for
 *     people who wrote on Messenger or Instagram (never the customer row)
 *   - ensureMetaSubscriptions: hourly, make sure every connected Page still
 *     sends its messages to us; switch delivery back on when Meta dropped it
 *
 * ensureMetaSubscriptions is the one unattended write to Meta in spec 02. It
 * changes nothing a customer can see. Switching the channel off on the
 * Channels page stops it for that Page.
 */
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { inboxConversation, inboxIdentity, inboxPhoneNumber, outboxEvent, type DbClient } from "@ms/db";
import {
  classifyMessagingError,
  fetchSenderProfile,
  isPageSubscribed,
  metaConfigFromEnv,
  MetaApiError,
  publishInboxEvent,
  signalFor,
  subscribePage,
  updateIdentityProfile,
  type MetaConfig,
} from "@ms/domain";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

const PROFILE_BATCH = 20;

/**
 * Up to 20 Messenger/Instagram identities never looked up, or looked up more
 * than 3 days ago and seen since. Only values Meta actually returned are
 * written, so a failed look-up never wipes a known name (rule R18);
 * profile_fetched_at is always stamped, so it is not retried for 3 days.
 */
export async function refreshIdentityProfiles(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
): Promise<number> {
  if (!cfg) return 0;
  const due = await db
    .select({
      id: inboxIdentity.id,
      channel: inboxIdentity.channel,
      externalId: inboxIdentity.externalId,
      customerId: inboxIdentity.customerId,
      lineId: inboxPhoneNumber.id,
      pageId: inboxPhoneNumber.pageExternalId,
      label: inboxPhoneNumber.label,
    })
    .from(inboxIdentity)
    .innerJoin(
      inboxPhoneNumber,
      and(
        eq(inboxPhoneNumber.kind, inboxIdentity.channel),
        eq(inboxPhoneNumber.externalId, inboxIdentity.accountExternalId),
        eq(inboxPhoneNumber.isActive, true),
      ),
    )
    .where(
      and(
        inArray(inboxIdentity.channel, ["messenger", "instagram"]),
        or(
          sql`${inboxIdentity.profileFetchedAt} is null`,
          and(
            sql`${inboxIdentity.profileFetchedAt} < now() - interval '3 days'`,
            gt(inboxIdentity.lastSeenAt, inboxIdentity.profileFetchedAt),
          ),
        ),
      ),
    )
    .orderBy(sql`${inboxIdentity.profileFetchedAt} asc nulls first`, asc(inboxIdentity.createdAt))
    .limit(PROFILE_BATCH);

  let done = 0;
  for (const ident of due) {
    if (!ident.pageId) continue;
    const channel = ident.channel as "messenger" | "instagram";
    try {
      const p = await fetchSenderProfile(cfg, channel, ident.pageId, ident.externalId);
      await updateIdentityProfile(db, ident.id, {
        ...(p.displayName !== null ? { displayName: p.displayName } : {}),
        ...(p.username !== null ? { username: p.username } : {}),
        ...(p.profilePicUrl !== null ? { profilePicUrl: p.profilePicUrl } : {}),
      });
      // Open screens show the name at once.
      const convs = await db
        .select()
        .from(inboxConversation)
        .where(
          and(
            eq(inboxConversation.customerId, ident.customerId),
            eq(inboxConversation.phoneNumberId, ident.lineId),
            ne(inboxConversation.status, "closed"),
          ),
        );
      for (const conv of convs) await publishInboxEvent(db, signalFor("conversation.updated", conv));
      done++;
    } catch (err) {
      const cls =
        err instanceof MetaApiError ? classifyMessagingError(err, channel === "messenger" ? "Messenger" : "Instagram", ident.label).cls : "temporary";
      log.warn({ err, identityId: ident.id, cls }, "inbox profile look-up failed; will retry");
      if (cls === "config") break; // the same problem would stop every other look-up too
    }
  }
  return done;
}

/** Raise inbox.meta_config once a day per account (the worker's copy of the API's alertOnce). */
async function alertConfigOnce(db: DbClient, payload: { account: string; code: string; text: string }): Promise<void> {
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.eventType, "inbox.meta_config"),
        gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)),
        sql`${outboxEvent.payload}->>'account' = ${payload.account}`,
      ),
    )
    .limit(1);
  if (!recent) await db.insert(outboxEvent).values({ eventType: "inbox.meta_config", payload });
}

/**
 * Hourly: for each Page behind an active Messenger or Instagram line, check our
 * app is still subscribed to its webhooks; if not, subscribe it again (Meta
 * drops the subscription after an hour of failed deliveries, spec 02 M1).
 */
export async function ensureMetaSubscriptions(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
): Promise<number> {
  if (!cfg) return 0;
  const lines = await db
    .select({ pageId: inboxPhoneNumber.pageExternalId, label: inboxPhoneNumber.label })
    .from(inboxPhoneNumber)
    .where(and(inArray(inboxPhoneNumber.kind, ["messenger", "instagram"]), eq(inboxPhoneNumber.isActive, true)))
    .orderBy(asc(inboxPhoneNumber.kind));
  const pages = new Map<string, string>();
  for (const l of lines) if (l.pageId && !pages.has(l.pageId)) pages.set(l.pageId, l.label);

  let resubscribed = 0;
  for (const [pageId, label] of pages) {
    const ofPage = and(
      eq(inboxPhoneNumber.pageExternalId, pageId),
      inArray(inboxPhoneNumber.kind, ["messenger", "instagram"]),
      eq(inboxPhoneNumber.isActive, true),
    );
    try {
      const subscribed = await isPageSubscribed(cfg, pageId);
      const now = new Date();
      await db.update(inboxPhoneNumber).set({ webhookCheckedAt: now }).where(ofPage);
      if (!subscribed) {
        await subscribePage(cfg, pageId);
        await db.update(inboxPhoneNumber).set({ webhookSubscribedAt: new Date() }).where(ofPage);
        log.warn({ pageId }, "meta page was not subscribed to our webhooks; subscribed it again");
        resubscribed++;
      }
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      const { staffText } = classifyMessagingError(err, "Messenger", label);
      const text = `Meta is not sending us messages for this Page: ${staffText}`;
      const code = err.code ? (err.subcode ? `${err.code}/${err.subcode}` : err.code) : "";
      await db.update(inboxPhoneNumber).set({ problemText: text, problemCode: code || null, problemAt: new Date() }).where(ofPage);
      await alertConfigOnce(db, { account: pageId, code, text });
      log.warn({ err, pageId }, "meta subscription check failed");
    }
  }
  return resubscribed;
}
