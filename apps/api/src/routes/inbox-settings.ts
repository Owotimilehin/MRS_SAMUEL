import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  adminUser,
  inboxCall,
  inboxHoliday,
  inboxHoursProfile,
  inboxHoursRule,
  inboxIvrMenu,
  inboxIvrOption,
  inboxPhoneNumber,
  inboxTeam,
  inboxTeamMember,
  inboxUserNumberAccess,
  type DbClient,
} from "@ms/db";
import { getNumberInfo, metaConfigFromEnv, registerNumber, unparkEventsForNumber, MetaApiError } from "@ms/domain";
import { toE164 } from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError, pgErrorCode } from "../lib/errors.js";
import { clearInboxViewerCache } from "./inbox.js";
import { presignGreetingPut, presignInboxGet } from "../lib/r2.js";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "use HH:MM");
const Uuid = z.string().uuid();
/** Storage key of an uploaded greeting (from POST /greetings/upload). */
const GreetingKey = z.string().regex(/^inbox\/greetings\/[0-9a-f-]{36}\.(mp3|wav)$/).nullable().optional();

async function audit(db: DbClient, c: Context, action: string, entityType: string, entityId: string, after?: unknown, before?: unknown) {
  await writeAudit(db, c, { action, entityType, entityId, after, before, notify: true });
}

function idParam(c: Context, name = "id"): string {
  const parsed = Uuid.safeParse(c.req.param(name));
  if (!parsed.success) throw new BusinessError("not_found", "not found", 404);
  return parsed.data;
}

const NumberBody = z.object({
  e164: z.string().min(5).max(20),
  label: z.string().trim().min(1).max(60),
  channels: z.enum(["voice", "whatsapp", "both"]),
  waba_id: z.string().max(40).nullable().optional(),
  wa_phone_number_id: z.string().max(40).nullable().optional(),
  wa_fallback_number_id: Uuid.nullable().optional(),
  voice_provider: z.string().max(40).nullable().optional(),
  inbound_match: z.string().max(80).nullable().optional(),
  max_concurrent_calls: z.number().int().positive().max(1000).nullable().optional(),
  default_team_id: Uuid.nullable().optional(),
  hours_profile_id: Uuid.nullable().optional(),
  ivr_menu_id: Uuid.nullable().optional(),
  after_hours_text: z.string().max(600).nullable().optional(),
  after_hours_audio_key: GreetingKey,
  is_active: z.boolean().optional(),
});

function numberValues(b: { [K in keyof z.infer<typeof NumberBody>]?: z.infer<typeof NumberBody>[K] | undefined }) {
  const out: Partial<typeof inboxPhoneNumber.$inferInsert> = {};
  if (b.e164 !== undefined) {
    const e = toE164(b.e164);
    if (!e) throw new BusinessError("validation_failed", "Phone number doesn't look right", 400);
    out.e164 = e;
  }
  if (b.label !== undefined) out.label = b.label;
  if (b.channels !== undefined) out.channels = b.channels;
  if (b.waba_id !== undefined) out.wabaId = b.waba_id;
  if (b.wa_phone_number_id !== undefined) out.waPhoneNumberId = b.wa_phone_number_id;
  if (b.wa_fallback_number_id !== undefined) out.waFallbackNumberId = b.wa_fallback_number_id;
  if (b.voice_provider !== undefined) out.voiceProvider = b.voice_provider;
  if (b.inbound_match !== undefined) out.inboundMatch = b.inbound_match;
  if (b.max_concurrent_calls !== undefined) out.maxConcurrentCalls = b.max_concurrent_calls;
  if (b.default_team_id !== undefined) out.defaultTeamId = b.default_team_id;
  if (b.hours_profile_id !== undefined) out.hoursProfileId = b.hours_profile_id;
  if (b.ivr_menu_id !== undefined) out.ivrMenuId = b.ivr_menu_id;
  if (b.after_hours_text !== undefined) out.afterHoursText = b.after_hours_text;
  if (b.after_hours_audio_key !== undefined) out.afterHoursAudioKey = b.after_hours_audio_key;
  if (b.is_active !== undefined) out.isActive = b.is_active;
  return out;
}

/**
 * Admin settings for the unified inbox. Everything here needs inbox.settings;
 * who-can-use-which-number additionally needs users.manage.
 * Nothing is hard-deleted except config rows that hold no history (hours rules,
 * holidays, menu options, team memberships).
 */
export function inboxSettingsRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  // ── Numbers ──
  /**
   * Phone lines only. `?kind=all` also returns the other channel accounts
   * (Facebook Page, Instagram), for the Staff access tab. Pages and Instagram
   * accounts are set up under /v1/channels.
   */
  r.get("/numbers", requireCapability("inbox.settings"), async (c) => {
    const all = c.req.query("kind") === "all";
    const rows = await db
      .select()
      .from(inboxPhoneNumber)
      .where(all ? undefined : eq(inboxPhoneNumber.kind, "phone"))
      .orderBy(asc(inboxPhoneNumber.label));
    const live = await db
      .select({ numberId: inboxCall.phoneNumberId, n: sql<number>`count(*)::int` })
      .from(inboxCall)
      .where(and(eq(inboxCall.outcome, "in_progress"), isNull(inboxCall.endedAt), sql`${inboxCall.startedAt} > now() - interval '4 hours'`))
      .groupBy(inboxCall.phoneNumberId);
    return c.json({
      data: rows.map((n) => ({ ...n, calls_in_progress: live.find((l) => l.numberId === n.id)?.n ?? 0 })),
    });
  });

  r.post("/numbers", requireCapability("inbox.settings"), async (c) => {
    const body = NumberBody.parse(await c.req.json());
    const values = { ...(numberValues(body) as typeof inboxPhoneNumber.$inferInsert), kind: "phone" };
    try {
      const [row] = await db.insert(inboxPhoneNumber).values(values).returning();
      if (row!.waPhoneNumberId) await unparkEventsForNumber(db, row!.waPhoneNumberId);
      await audit(db, c, "inbox.number_create", "inbox_phone_number", row!.id, { label: row!.label, e164: row!.e164 });
      return c.json({ data: row }, 201);
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new BusinessError("conflict", "That number (or WhatsApp phone number ID) is already set up", 409);
      }
      throw err;
    }
  });

  r.patch("/numbers/:id", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const body = NumberBody.partial().parse(await c.req.json());
    if (body.wa_fallback_number_id === id) throw new BusinessError("validation_failed", "A number can't be its own fallback", 400);
    const [before] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, id));
    // A Page or Instagram account is changed under Channels, never here (rule R19).
    if (!before || before.kind !== "phone") throw new BusinessError("not_found", "not found", 404);
    const [row] = await db
      .update(inboxPhoneNumber)
      .set({ ...numberValues(body), updatedAt: new Date() })
      .where(eq(inboxPhoneNumber.id, id))
      .returning();
    if (row?.waPhoneNumberId && row.waPhoneNumberId !== before.waPhoneNumberId) {
      await unparkEventsForNumber(db, row.waPhoneNumberId);
    }
    await audit(db, c, "inbox.number_update", "inbox_phone_number", id, body, before);
    return c.json({ data: row });
  });

  /** Register the number for Cloud API with its 6-digit PIN (Meta: 10 tries per 72h). */
  r.post("/numbers/:id/register", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/, "PIN is 6 digits") }).parse(await c.req.json());
    const cfg = metaConfigFromEnv();
    if (!cfg) throw new BusinessError("service_unavailable", "WhatsApp is not configured on this server", 503);
    const [num] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, id));
    if (!num || num.kind !== "phone") throw new BusinessError("not_found", "not found", 404);
    if (!num.waPhoneNumberId) throw new BusinessError("validation_failed", "Add the WhatsApp phone number ID first", 400);
    try {
      await registerNumber(cfg, num.waPhoneNumberId, pin);
    } catch (err) {
      if (err instanceof MetaApiError) throw new BusinessError("conflict", `Meta refused: ${err.message}`, 409);
      throw err;
    }
    await db.update(inboxPhoneNumber).set({ waStatus: "registered", updatedAt: new Date() }).where(eq(inboxPhoneNumber.id, id));
    await audit(db, c, "inbox.number_register", "inbox_phone_number", id, { label: num.label });
    return c.json({ ok: true });
  });

  /** Pull status, quality rating and limit tier from Meta. */
  r.post("/numbers/:id/refresh", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const cfg = metaConfigFromEnv();
    if (!cfg) throw new BusinessError("service_unavailable", "WhatsApp is not configured on this server", 503);
    const [num] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, id));
    if (!num || num.kind !== "phone") throw new BusinessError("not_found", "not found", 404);
    if (!num.waPhoneNumberId) throw new BusinessError("validation_failed", "This number has no WhatsApp phone number ID", 400);
    const info = await getNumberInfo(cfg, num.waPhoneNumberId).catch((err: unknown) => {
      throw new BusinessError("conflict", err instanceof Error ? err.message : "Meta lookup failed", 409);
    });
    const [row] = await db
      .update(inboxPhoneNumber)
      .set({
        waStatus: info.status ?? num.waStatus,
        qualityRating: info.quality_rating ?? num.qualityRating,
        messagingLimit: info.messaging_limit_tier ?? num.messagingLimit,
        updatedAt: new Date(),
      })
      .where(eq(inboxPhoneNumber.id, id))
      .returning();
    return c.json({ data: row });
  });

  // ── Teams ──
  r.get("/teams", requireCapability("inbox.settings"), async (c) => {
    const teams = await db.select().from(inboxTeam).orderBy(asc(inboxTeam.name));
    const members = await db
      .select({ teamId: inboxTeamMember.teamId, userId: inboxTeamMember.userId, isLead: inboxTeamMember.isLead, name: adminUser.name, email: adminUser.email })
      .from(inboxTeamMember)
      .innerJoin(adminUser, eq(adminUser.id, inboxTeamMember.userId));
    return c.json({
      data: teams.map((t) => ({
        ...t,
        members: members.filter((m) => m.teamId === t.id).map((m) => ({ user_id: m.userId, name: m.name ?? m.email, is_lead: m.isLead })),
      })),
    });
  });

  const TeamBody = z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(300).nullable().optional(), is_active: z.boolean().optional() });
  r.post("/teams", requireCapability("inbox.settings"), async (c) => {
    const body = TeamBody.parse(await c.req.json());
    const [row] = await db.insert(inboxTeam).values({ name: body.name, description: body.description ?? null }).returning();
    await audit(db, c, "inbox.team_create", "inbox_team", row!.id, body);
    return c.json({ data: row }, 201);
  });
  r.patch("/teams/:id", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const body = TeamBody.partial().parse(await c.req.json());
    const [row] = await db
      .update(inboxTeam)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
      })
      .where(eq(inboxTeam.id, id))
      .returning();
    if (!row) throw new BusinessError("not_found", "not found", 404);
    await audit(db, c, "inbox.team_update", "inbox_team", id, body);
    return c.json({ data: row });
  });
  /** Replace a team's members. */
  r.put("/teams/:id/members", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const body = z
      .object({ members: z.array(z.object({ user_id: Uuid, is_lead: z.boolean().default(false) })).max(500) })
      .parse(await c.req.json());
    await db.transaction(async (tx) => {
      await tx.delete(inboxTeamMember).where(eq(inboxTeamMember.teamId, id));
      if (body.members.length) {
        await tx.insert(inboxTeamMember).values(body.members.map((m) => ({ teamId: id, userId: m.user_id, isLead: m.is_lead })));
      }
    });
    clearInboxViewerCache();
    await audit(db, c, "inbox.team_members_set", "inbox_team", id, body);
    return c.json({ ok: true });
  });

  // ── Number access per user ──
  r.get("/access", requireCapability("users.manage"), async (c) => {
    const rows = await db.select().from(inboxUserNumberAccess);
    return c.json({ data: rows.map((x) => ({ user_id: x.userId, phone_number_id: x.phoneNumberId })) });
  });
  r.put("/access/:userId", requireCapability("users.manage"), async (c) => {
    const userId = idParam(c, "userId");
    const { number_ids } = z.object({ number_ids: z.array(Uuid).max(200) }).parse(await c.req.json());
    const before = await db.select().from(inboxUserNumberAccess).where(eq(inboxUserNumberAccess.userId, userId));
    await db.transaction(async (tx) => {
      await tx.delete(inboxUserNumberAccess).where(eq(inboxUserNumberAccess.userId, userId));
      if (number_ids.length) {
        await tx.insert(inboxUserNumberAccess).values([...new Set(number_ids)].map((n) => ({ userId, phoneNumberId: n })));
      }
    });
    clearInboxViewerCache(userId);
    await audit(db, c, "inbox.number_access_set", "admin_user", userId, { number_ids }, { number_ids: before.map((b) => b.phoneNumberId) });
    return c.json({ ok: true });
  });

  // ── Business hours ──
  r.get("/hours", requireCapability("inbox.settings"), async (c) => {
    const profiles = await db.select().from(inboxHoursProfile).orderBy(asc(inboxHoursProfile.name));
    const rules = await db.select().from(inboxHoursRule);
    const holidays = await db.select().from(inboxHoliday).orderBy(asc(inboxHoliday.date));
    return c.json({
      data: {
        profiles: profiles.map((p) => ({
          ...p,
          rules: rules.filter((x) => x.profileId === p.id).sort((a, b) => a.weekday - b.weekday || a.openTime.localeCompare(b.openTime)),
        })),
        holidays,
      },
    });
  });

  const ProfileBody = z.object({
    name: z.string().trim().min(1).max(60),
    rules: z
      .array(z.object({ weekday: z.number().int().min(0).max(6), open_time: HHMM, close_time: HHMM }))
      .max(50)
      .refine((rs) => rs.every((x) => x.close_time > x.open_time), "Closing time must be after opening time"),
  });
  r.post("/hours", requireCapability("inbox.settings"), async (c) => {
    const body = ProfileBody.parse(await c.req.json());
    const row = await db.transaction(async (tx) => {
      const [p] = await tx.insert(inboxHoursProfile).values({ name: body.name }).returning();
      if (body.rules.length) {
        await tx.insert(inboxHoursRule).values(body.rules.map((x) => ({ profileId: p!.id, weekday: x.weekday, openTime: x.open_time, closeTime: x.close_time })));
      }
      return p!;
    });
    await audit(db, c, "inbox.hours_create", "inbox_hours_profile", row.id, body);
    return c.json({ data: row }, 201);
  });
  r.put("/hours/:id", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const body = ProfileBody.parse(await c.req.json());
    await db.transaction(async (tx) => {
      const [p] = await tx.update(inboxHoursProfile).set({ name: body.name }).where(eq(inboxHoursProfile.id, id)).returning();
      if (!p) throw new BusinessError("not_found", "not found", 404);
      await tx.delete(inboxHoursRule).where(eq(inboxHoursRule.profileId, id));
      if (body.rules.length) {
        await tx.insert(inboxHoursRule).values(body.rules.map((x) => ({ profileId: id, weekday: x.weekday, openTime: x.open_time, closeTime: x.close_time })));
      }
    });
    await audit(db, c, "inbox.hours_update", "inbox_hours_profile", id, body);
    return c.json({ ok: true });
  });

  const HolidayBody = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().trim().min(1).max(80), profile_id: Uuid.nullable().optional() });
  r.post("/holidays", requireCapability("inbox.settings"), async (c) => {
    const body = HolidayBody.parse(await c.req.json());
    const [row] = await db.insert(inboxHoliday).values({ date: body.date, label: body.label, profileId: body.profile_id ?? null }).returning();
    await audit(db, c, "inbox.holiday_create", "inbox_holiday", row!.id, body);
    return c.json({ data: row }, 201);
  });
  r.delete("/holidays/:id", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const [row] = await db.delete(inboxHoliday).where(eq(inboxHoliday.id, id)).returning();
    if (!row) throw new BusinessError("not_found", "not found", 404);
    await audit(db, c, "inbox.holiday_delete", "inbox_holiday", id, undefined, row);
    return c.json({ ok: true });
  });

  // ── Greeting recordings ──
  r.post("/greetings/upload", requireCapability("inbox.settings"), async (c) => {
    const body = z
      .object({ filename: z.string().max(240).optional(), content_type: z.string().max(100), size_bytes: z.number().int().positive() })
      .parse(await c.req.json());
    return c.json({ data: await presignGreetingPut({ contentType: body.content_type, sizeBytes: body.size_bytes }) }, 201);
  });
  r.get("/greetings/url", requireCapability("inbox.settings"), async (c) => {
    const key = z.string().regex(/^inbox\/greetings\/[0-9a-f-]{36}\.(mp3|wav)$/).safeParse(c.req.query("key"));
    if (!key.success) throw new BusinessError("not_found", "not found", 404);
    return c.json({ data: { url: await presignInboxGet(key.data), expires_in: 600 } });
  });

  // ── Phone menu (IVR) ──
  r.get("/ivr", requireCapability("inbox.settings"), async (c) => {
    const menus = await db.select().from(inboxIvrMenu).orderBy(asc(inboxIvrMenu.name));
    const options = menus.length
      ? await db.select().from(inboxIvrOption).where(inArray(inboxIvrOption.menuId, menus.map((m) => m.id)))
      : [];
    return c.json({
      data: menus.map((m) => ({ ...m, options: options.filter((o) => o.menuId === m.id).sort((a, b) => a.digit.localeCompare(b.digit)) })),
    });
  });

  const MenuBody = z.object({
    name: z.string().trim().min(1).max(60),
    greeting_text: z.string().trim().min(1).max(1000),
    greeting_audio_key: GreetingKey,
    options: z
      .array(
        z.object({
          digit: z.string().regex(/^\d$/),
          label: z.string().trim().min(1).max(60),
          action: z.enum(["ring_team", "voicemail", "play"]),
          team_id: Uuid.nullable().optional(),
          play_text: z.string().max(1000).nullable().optional(),
          audio_key: GreetingKey,
        }),
      )
      .max(10)
      .refine((os) => new Set(os.map((o) => o.digit)).size === os.length, "Each key can only be used once")
      .refine((os) => os.every((o) => o.action !== "ring_team" || !!o.team_id), "Pick a team for every 'ring team' option")
      .refine((os) => os.every((o) => o.action !== "play" || !!o.play_text || !!o.audio_key), "Add the message to read out, or upload a recording"),
  });

  async function saveMenu(tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0], menuId: string, body: z.infer<typeof MenuBody>) {
    await tx.delete(inboxIvrOption).where(eq(inboxIvrOption.menuId, menuId));
    if (body.options.length) {
      await tx.insert(inboxIvrOption).values(
        body.options.map((o) => ({
          menuId,
          digit: o.digit,
          label: o.label,
          action: o.action,
          teamId: o.team_id ?? null,
          playText: o.play_text ?? null,
          audioKey: o.audio_key ?? null,
        })),
      );
    }
  }

  r.post("/ivr", requireCapability("inbox.settings"), async (c) => {
    const body = MenuBody.parse(await c.req.json());
    const row = await db.transaction(async (tx) => {
      const [m] = await tx.insert(inboxIvrMenu).values({ name: body.name, greetingText: body.greeting_text, greetingAudioKey: body.greeting_audio_key ?? null }).returning();
      await saveMenu(tx, m!.id, body);
      return m!;
    });
    await audit(db, c, "inbox.ivr_create", "inbox_ivr_menu", row.id, body);
    return c.json({ data: row }, 201);
  });
  r.put("/ivr/:id", requireCapability("inbox.settings"), async (c) => {
    const id = idParam(c);
    const body = MenuBody.parse(await c.req.json());
    await db.transaction(async (tx) => {
      const [m] = await tx
        .update(inboxIvrMenu)
        .set({ name: body.name, greetingText: body.greeting_text, greetingAudioKey: body.greeting_audio_key ?? null })
        .where(eq(inboxIvrMenu.id, id))
        .returning();
      if (!m) throw new BusinessError("not_found", "not found", 404);
      await saveMenu(tx, id, body);
    });
    await audit(db, c, "inbox.ivr_update", "inbox_ivr_menu", id, body);
    return c.json({ ok: true });
  });

  return r;
}
