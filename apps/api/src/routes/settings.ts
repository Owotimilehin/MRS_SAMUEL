import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appSetting, SITE_BANNER_KEY, type DbClient, type SiteBannerValue } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";

const BannerBody = z.object({
  enabled: z.boolean(),
  message: z.string().max(280),
});

const DEFAULT_BANNER: SiteBannerValue = { enabled: false, message: "" };

async function readBanner(db: DbClient): Promise<SiteBannerValue> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, SITE_BANNER_KEY));
  if (!row) return DEFAULT_BANNER;
  const v = row.value as Partial<SiteBannerValue>;
  return { enabled: Boolean(v.enabled), message: typeof v.message === "string" ? v.message : "" };
}

/** Owner/admin: read + write the banner. Mounted at /v1/settings. */
export function settingsRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/banner", async (c) => c.json(await readBanner(db)));

  r.patch("/banner", requireCapability("settings.manage"), async (c) => {
    const body = BannerBody.parse(await c.req.json());
    const value: SiteBannerValue = { enabled: body.enabled, message: body.message.trim() };
    const auth = c.get("auth");

    const before = await readBanner(db);
    await db
      .insert(appSetting)
      .values({ key: SITE_BANNER_KEY, value, updatedBy: auth.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSetting.key,
        set: { value, updatedBy: auth.userId, updatedAt: new Date() },
      });

    await writeAudit(db, c, {
      action: "settings.banner.update",
      entityType: "app_setting",
      entityId: SITE_BANNER_KEY,
      before,
      after: value,
    });
    return c.json(value);
  });

  return r;
}

/** Public: read-only banner for the storefront. Mounted at /v1/public/settings. */
export function publicSettingsRoutes(db: DbClient) {
  const r = new Hono();
  r.get("/banner", async (c) => c.json(await readBanner(db)));
  return r;
}
