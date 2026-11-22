/**
 * Meta connection health (Watchdog, blueprint stage 1): what the worker's
 * hourly check last found. Read-only; Meta is never called from here.
 *
 * Guard: inbox.view or channels.manage. The banner is for everyone who answers
 * customers (inbox.view): they are the ones who need to know replies are not
 * going out. channels.manage alone also passes, for the Channels page's dots.
 * The record holds labels, a status and a plain-English reason only; no token,
 * no Meta IDs beyond the item key.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { appSetting, type DbClient } from "@ms/db";
import { parseMetaHealthValue } from "@ms/domain";
import { META_HEALTH_KEY, sortHealthItems, worstStatus, type MetaHealthItem, type MetaHealthStatus } from "@ms/shared";
import { requireAnyCapability, requireAuth } from "../middleware/auth.js";

/** The worker checks hourly; after this long without a run the record is "stale". */
const STALE_AFTER_MS = 3 * 3600_000;

export interface MetaHealthResponse {
  checked_at: string | null;
  /** True when the worker has not completed a check for over 3 hours (or never). */
  stale: boolean;
  overall: MetaHealthStatus;
  items: Omit<MetaHealthItem, "alerted_at">[];
}

export async function readMetaHealth(db: DbClient, now: Date = new Date()): Promise<MetaHealthResponse> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, META_HEALTH_KEY));
  const v = parseMetaHealthValue(row?.value ?? null);
  const items = sortHealthItems(Object.values(v?.items ?? {})).map(({ alerted_at: _a, ...rest }) => rest);
  const checked = v?.checked_at ? Date.parse(v.checked_at) : NaN;
  return {
    checked_at: v?.checked_at ?? null,
    stale: !Number.isFinite(checked) || now.getTime() - checked > STALE_AFTER_MS,
    overall: worstStatus(items),
    items,
  };
}

/** Mounted at /v1/meta-health. */
export function metaHealthRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireAnyCapability("inbox.view", "channels.manage"));
  r.get("/", async (c) => c.json({ data: await readMetaHealth(db) }));
  return r;
}
