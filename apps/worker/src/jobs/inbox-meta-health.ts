/**
 * Watchdog (blueprint stage 1): every hour, check the Meta connection still
 * works and keep the result where the suite can show it.
 *
 * Reads only from Meta (debug_token, each WhatsApp number, each WhatsApp
 * account); Pages and Instagram come from what ensureMetaSubscriptions last
 * wrote on their rows. The result is one app_settings row (META_HEALTH_KEY), so
 * no migration. When an item becomes broken, one owner alert is raised
 * (outbox "meta.connection_broken"); staying broken never alerts again.
 *
 * The token is never logged, stored or put in the alert.
 */
import { eq } from "drizzle-orm";
import { appSetting, inboxPhoneNumber, outboxEvent, type DbClient } from "@ms/db";
import {
  collectMetaHealth,
  mergeMetaHealth,
  metaConfigFromEnv,
  numberMessagingLimit,
  parseMetaHealthValue,
  type AccountBlock,
  type HealthLine,
  type MetaConfig,
} from "@ms/domain";
import { META_HEALTH_KEY } from "@ms/shared";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/**
 * Where the WhatsApp account_update webhook records a block on the account
 * ({ [waba id]: { waba_id, event, detail, at } }, the broadcasts work). Read
 * when the row exists; never written here.
 */
export const ACCOUNT_BLOCK_KEY = "broadcast_account_block";

export const META_HEALTH_ALERT = "meta.connection_broken";

async function readSetting(db: DbClient, key: string): Promise<unknown> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, key));
  return row?.value ?? null;
}

function accountBlocks(raw: unknown): Record<string, AccountBlock> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, AccountBlock> = {};
  for (const [waba, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const b = v as Record<string, unknown>;
    out[waba] = {
      event: typeof b.event === "string" ? b.event : null,
      detail: typeof b.detail === "string" ? b.detail : null,
      at: typeof b.at === "string" ? b.at : null,
    };
  }
  return out;
}

export async function checkMetaHealth(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<{ items: number; alerted: number }> {
  if (!cfg) return { items: 0, alerted: 0 };

  const rows = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.isActive, true));
  const lines: HealthLine[] = rows
    .filter((r) => r.kind === "phone" || r.kind === "messenger" || r.kind === "instagram")
    .map((r) => ({
      id: r.id,
      kind: r.kind as HealthLine["kind"],
      label: r.label,
      channels: r.channels,
      wabaId: r.wabaId,
      waPhoneNumberId: r.waPhoneNumberId,
      webhookCheckedAt: r.webhookCheckedAt,
      webhookSubscribedAt: r.webhookSubscribedAt,
      problemText: r.problemText,
      problemAt: r.problemAt,
    }));

  const prev = parseMetaHealthValue(await readSetting(db, META_HEALTH_KEY));
  const blocks = accountBlocks(await readSetting(db, ACCOUNT_BLOCK_KEY));
  const { outcomes, numberInfo } = await collectMetaHealth(cfg, lines, now, { accountBlocks: blocks });

  // Keep the number's own columns fresh while we have Meta's answer (the quality webhook writes them too).
  for (const [lineId, info] of numberInfo) {
    const limit = numberMessagingLimit(info);
    const set = {
      ...(info.status ? { waStatus: info.status } : {}),
      ...(info.quality_rating ? { qualityRating: info.quality_rating } : {}),
      ...(limit ? { messagingLimit: limit } : {}),
    };
    if (Object.keys(set).length > 0) {
      await db.update(inboxPhoneNumber).set({ ...set, updatedAt: now }).where(eq(inboxPhoneNumber.id, lineId));
    }
  }

  const { value, newlyBroken } = mergeMetaHealth(prev, outcomes, now);
  await db.transaction(async (tx) => {
    await tx
      .insert(appSetting)
      .values({ key: META_HEALTH_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: now } });
    if (newlyBroken.length > 0) {
      await tx.insert(outboxEvent).values({
        eventType: META_HEALTH_ALERT,
        payload: { items: newlyBroken.map((i) => ({ key: i.key, kind: i.kind, label: i.label, reason: i.reason, impact: i.impact })) },
      });
    }
  });

  const counts = { ok: 0, warning: 0, broken: 0 };
  for (const i of Object.values(value.items)) counts[i.status]++;
  if (newlyBroken.length > 0) log.warn({ ...counts, alerted: newlyBroken.map((i) => i.key) }, "meta connection: something is broken");
  else log.info(counts, "meta connection checked");
  return { items: Object.keys(value.items).length, alerted: newlyBroken.length };
}
