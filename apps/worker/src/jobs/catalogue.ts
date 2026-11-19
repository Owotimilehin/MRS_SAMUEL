/**
 * Catalogue background jobs (suite spec 08, section 6). Thin wrappers: they
 * read the configuration and call the domain functions, which hold the rules.
 *
 *   - runCatalogueSync:       push what changed in the shop to the Meta catalogue
 *   - runCatalogueBatchCheck: ask Meta whether each sent batch was taken
 *   - runCatalogueReconcile:  nightly, compare Meta's list with ours
 *   - runChatOrderJobs:       the two automatic customer messages, each behind
 *                             an owner switch that is off by default
 *
 * Every job returns at once when Meta is not configured or no catalogue is
 * linked, and nothing is ever sent to Meta's catalogue unless "Keep WhatsApp
 * in step with the shop" is switched on (catalogue_link.sync_enabled).
 */
import type { DbClient } from "@ms/db";
import {
  catalogueReconcileDue,
  catalogueSyncDue,
  checkOpenBatches,
  getCatalogueLink,
  metaConfigFromEnv,
  reconcileCatalogue,
  runChatOrderPrompts,
  runOrderUpdates,
  syncCatalogue,
  type MetaConfig,
} from "@ms/domain";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/** The storefront's address, derived the same way createCheckout does. */
export function storefrontBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.PUBLIC_CUSTOMER_URL || (env.PUBLIC_ADMIN_URL ?? "https://www.mrssamuel.com").replace("admin.", "www.");
  return base.replace(/\/+$/, "");
}

export async function runCatalogueSync(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<{ pushed: number; removed: number; blocked: number } | null> {
  if (!cfg) return null;
  const link = await getCatalogueLink(db);
  if (!link || !catalogueSyncDue(link, now)) return null;
  const full = link.fullSyncRequestedAt !== null;
  const result = await syncCatalogue(db, cfg, { storefrontBase: storefrontBase(), force: full, kind: full ? "full" : "changes" });
  if (result.pushed || result.removed) log.info({ ...result, full }, "catalogue: batch sent to Meta");
  return result;
}

export async function runCatalogueBatchCheck(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
): Promise<number> {
  if (!cfg) return 0;
  const finished = await checkOpenBatches(db, cfg);
  if (finished) log.info({ finished }, "catalogue: batches finished");
  return finished;
}

export async function runCatalogueReconcile(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<{ missing: number; extra: number; unmanaged: number } | null> {
  if (!cfg) return null;
  const link = await getCatalogueLink(db);
  if (!link || !catalogueReconcileDue(link, now)) return null;
  const counts = await reconcileCatalogue(db, cfg, { storefrontBase: storefrontBase() });
  log.info(counts, "catalogue: nightly reconcile");
  return counts;
}

/**
 * Section 6.4. Two messages a customer can get without a person clicking:
 *   - the "delivery or pickup?" question and its follow-ups, only while the
 *     owner's "Ask automatically when a cart arrives" switch is on;
 *   - "paid", "on its way", "delivered", only while the owner's "Tell
 *     customers…" switch is on.
 * Both switches are off until the owner turns them on (foundation C6). The
 * domain functions check the switches themselves; this wrapper only supplies
 * the configuration.
 */
export async function runChatOrderJobs(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
): Promise<{ prompts: number; updates: number } | null> {
  if (!cfg) return null;
  const link = await getCatalogueLink(db);
  if (!link || (!link.askFulfilmentAuto && !link.orderUpdatesEnabled)) return null;
  const prompts = await runChatOrderPrompts(db, cfg, log);
  const updates = await runOrderUpdates(db, cfg, log, { language: process.env.INBOX_TEMPLATE_LANGUAGE || "en" });
  if (prompts || updates) log.info({ prompts, updates }, "catalogue: chat order messages sent");
  return { prompts, updates };
}
