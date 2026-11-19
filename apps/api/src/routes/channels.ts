/**
 * Channels (suite spec 01): the places customers reach us. Phone lines are
 * listed here but changed under Settings, Numbers; a Facebook Page and its
 * Instagram account are connected, renamed, routed and switched off here.
 *
 * Every route needs channels.manage. Meta is only read here (which Pages we
 * can reach, a Page token to prove access); names and the Instagram ID always
 * come from Meta's answer, never from the browser (rule R3). A Page token is
 * never stored, logged or returned (rule R4).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { inboxConversation, inboxHoursProfile, inboxPhoneNumber, inboxTeam, type DbClient, type DbExecutor } from "@ms/db";
import {
  MetaApiError,
  clearPageTokenCache,
  describePage,
  isPageSubscribed,
  listConnectablePages,
  metaConfigFromEnv,
  pageAccessToken,
  subscribePageKeepingFields,
  unparkEventsForAccount,
  type ConnectablePage,
  type MetaConfig,
} from "@ms/domain";
import type { ChannelKind } from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { clearInboxViewerCache } from "./inbox.js";

const PageId = z.string().regex(/^\d{5,25}$/, "A Page ID is 5 to 25 digits");
const Label = z.string().trim().min(1).max(60);
const Uuid = z.string().uuid();

const NOT_CONNECTED = "Meta is not connected on this server.";
const PHONE_ELSEWHERE = "Phone lines are changed under Settings, Numbers.";
const NO_PAGE_ACCESS =
  "Meta would not give us access to this Page. Check it is assigned to our system user with messaging rights.";
const NO_INSTAGRAM = "This Page has no Instagram account linked to it.";
const INSTAGRAM_UNLINKED = "This Instagram account is no longer linked to the Facebook Page.";
const NOT_RECEIVING =
  "Meta is not sending us messages for this Page. We tried to switch it back on; check again in a minute.";
const DEFAULT_LABEL: Record<"messenger" | "instagram", string> = { messenger: "Facebook Page", instagram: "Instagram" };

/** A Meta refusal as a sentence a shop worker can act on (spec 01, section 3). */
export function channelErrorSentence(err: MetaApiError): string {
  if (err.code === "190") return "Meta says our connection has expired. Ask the technical lead to renew it.";
  if (err.code === "10" || err.code === "200" || err.code === "299") {
    return "Meta says we are not allowed to see this Page. Ask the technical lead to check the Page is assigned to our system user.";
  }
  if (err.retryable) return "Meta did not answer. Try again in a minute.";
  return `Meta refused this: ${err.message}`;
}

function metaRefusal(err: unknown): never {
  if (err instanceof MetaApiError) {
    throw new BusinessError("conflict", channelErrorSentence(err), 409, { meta_code: err.code });
  }
  throw err;
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
  return cfg;
}

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  label: string;
  e164: string | null;
  external_id: string | null;
  page_external_id: string | null;
  external_name: string | null;
  /** Phone lines only: voice | whatsapp | both. */
  channels: string;
  default_team_id: string | null;
  team_name: string | null;
  hours_profile_id: string | null;
  hours_profile_name: string | null;
  is_active: boolean;
  open_conversations: number;
  /** Spec 02: when Meta was last told to send this Page's messages to us. */
  webhook_subscribed_at: Date | null;
  /** Spec 02: the last configuration problem Meta reported, in plain words (cleared by the next success). */
  problem_text: string | null;
  problem_at: Date | null;
}

async function channelRows(db: DbExecutor, ids?: string[]): Promise<ChannelRow[]> {
  if (ids && ids.length === 0) return [];
  const rows = await db
    .select({
      id: inboxPhoneNumber.id,
      kind: inboxPhoneNumber.kind,
      label: inboxPhoneNumber.label,
      e164: inboxPhoneNumber.e164,
      external_id: inboxPhoneNumber.externalId,
      page_external_id: inboxPhoneNumber.pageExternalId,
      external_name: inboxPhoneNumber.externalName,
      channels: inboxPhoneNumber.channels,
      default_team_id: inboxPhoneNumber.defaultTeamId,
      team_name: inboxTeam.name,
      hours_profile_id: inboxPhoneNumber.hoursProfileId,
      hours_profile_name: inboxHoursProfile.name,
      is_active: inboxPhoneNumber.isActive,
      webhook_subscribed_at: inboxPhoneNumber.webhookSubscribedAt,
      problem_text: inboxPhoneNumber.problemText,
      problem_at: inboxPhoneNumber.problemAt,
      open_conversations: sql<number>`(select count(*)::int from ${inboxConversation} c
        where c.phone_number_id = ${inboxPhoneNumber.id} and c.status <> 'closed')`,
    })
    .from(inboxPhoneNumber)
    .leftJoin(inboxTeam, eq(inboxTeam.id, inboxPhoneNumber.defaultTeamId))
    .leftJoin(inboxHoursProfile, eq(inboxHoursProfile.id, inboxPhoneNumber.hoursProfileId))
    .where(ids ? inArray(inboxPhoneNumber.id, ids) : undefined)
    .orderBy(asc(inboxPhoneNumber.kind), asc(inboxPhoneNumber.label));
  return rows.map((r) => ({ ...r, kind: r.kind as ChannelKind }));
}

export interface AvailablePage {
  page_id: string;
  name: string;
  can_message: boolean;
  messenger_connected: boolean;
  instagram: { id: string; username: string | null; connected: boolean } | null;
}

/** Mark which Pages and Instagram accounts already have an active row. */
async function toAvailable(db: DbExecutor, pages: ConnectablePage[]): Promise<AvailablePage[]> {
  const active = await db
    .select({ kind: inboxPhoneNumber.kind, externalId: inboxPhoneNumber.externalId })
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.isActive, true), inArray(inboxPhoneNumber.kind, ["messenger", "instagram"])));
  const on = (kind: string, id: string) => active.some((a) => a.kind === kind && a.externalId === id);
  return pages.map((p) => ({
    page_id: p.pageId,
    name: p.name,
    can_message: p.canMessage,
    messenger_connected: on("messenger", p.pageId),
    instagram: p.instagram
      ? { id: p.instagram.id, username: p.instagram.username, connected: on("instagram", p.instagram.id) }
      : null,
  }));
}

/** A team or hours profile picked in the browser must exist (else a clear 400, not a foreign-key 500). */
async function checkRouting(db: DbExecutor, teamId: string | null | undefined, hoursId: string | null | undefined) {
  if (teamId) {
    const [t] = await db.select({ id: inboxTeam.id }).from(inboxTeam).where(eq(inboxTeam.id, teamId));
    if (!t) throw new BusinessError("validation_failed", "That team no longer exists.", 400);
  }
  if (hoursId) {
    const [h] = await db.select({ id: inboxHoursProfile.id }).from(inboxHoursProfile).where(eq(inboxHoursProfile.id, hoursId));
    if (!h) throw new BusinessError("validation_failed", "Those opening hours no longer exist.", 400);
  }
}

const ConnectBody = z
  .object({
    page_id: PageId,
    messenger: z.boolean(),
    instagram: z.boolean(),
    label_messenger: Label.optional(),
    label_instagram: Label.optional(),
    default_team_id: Uuid.nullable().optional(),
    hours_profile_id: Uuid.nullable().optional(),
  })
  .refine((b) => b.messenger || b.instagram, { message: "Pick the Page, its Instagram account, or both" });

const PatchBody = z
  .object({
    label: Label.optional(),
    default_team_id: Uuid.nullable().optional(),
    hours_profile_id: Uuid.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

function idParam(c: Context): string {
  const parsed = Uuid.safeParse(c.req.param("id"));
  if (!parsed.success) throw new BusinessError("not_found", "not found", 404);
  return parsed.data;
}

export function channelRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("channels.manage"));

  /** Every channel account, with the teams and opening hours the dialogs offer. */
  r.get("/", async (c) => {
    const data = await channelRows(db);
    const teams = await db
      .select({ id: inboxTeam.id, name: inboxTeam.name })
      .from(inboxTeam)
      .where(eq(inboxTeam.isActive, true))
      .orderBy(asc(inboxTeam.name));
    const hours = await db
      .select({ id: inboxHoursProfile.id, name: inboxHoursProfile.name })
      .from(inboxHoursProfile)
      .orderBy(asc(inboxHoursProfile.name));
    return c.json({ data, teams, hours_profiles: hours });
  });

  /** The Pages our system user can reach at Meta, each with its Instagram account. */
  r.get("/available", async (c) => {
    const cfg = needConfig();
    const pages = await listConnectablePages(cfg).catch(metaRefusal);
    return c.json({ data: await toAvailable(db, pages) });
  });

  /** One Page by ID, for when Meta's list comes back empty. */
  r.get("/available/:pageId", async (c) => {
    const parsed = PageId.safeParse(c.req.param("pageId"));
    if (!parsed.success) throw new BusinessError("validation_failed", "A Page ID is 5 to 25 digits", 400);
    const cfg = needConfig();
    const page = await describePage(cfg, parsed.data).catch(metaRefusal);
    const [data] = await toAvailable(db, [page]);
    return c.json({ data });
  });

  r.post("/connect", async (c) => {
    const body = ConnectBody.parse(await c.req.json());
    const cfg = needConfig();
    await checkRouting(db, body.default_team_id, body.hours_profile_id);

    // 1. What Meta says about the Page (names and the Instagram ID come from here only).
    const page = await describePage(cfg, body.page_id).catch(metaRefusal);
    // 2. Prove we can act for the Page.
    try {
      await pageAccessToken(cfg, body.page_id);
    } catch (err) {
      if (err instanceof MetaApiError) {
        throw new BusinessError("conflict", NO_PAGE_ACCESS, 409, { meta_code: err.code });
      }
      throw err;
    }
    // 3. Instagram needs a linked account.
    if (body.instagram && !page.instagram) throw new BusinessError("validation_failed", NO_INSTAGRAM, 400);

    const wanted: { kind: "messenger" | "instagram"; externalId: string; externalName: string | null; label?: string | undefined }[] = [];
    if (body.messenger) {
      wanted.push({ kind: "messenger", externalId: page.pageId, externalName: page.name || null, label: body.label_messenger });
    }
    if (body.instagram && page.instagram) {
      wanted.push({
        kind: "instagram",
        externalId: page.instagram.id,
        externalName: page.instagram.username,
        label: body.label_instagram,
      });
    }

    // 4. One row per kind: switch an existing one back on, else create it.
    const ids = await db.transaction(async (tx) => {
      const out: string[] = [];
      for (const w of wanted) {
        const routing = {
          ...(body.default_team_id !== undefined ? { defaultTeamId: body.default_team_id } : {}),
          ...(body.hours_profile_id !== undefined ? { hoursProfileId: body.hours_profile_id } : {}),
        };
        const reactivate = async (id: string) => {
          await tx
            .update(inboxPhoneNumber)
            .set({
              isActive: true,
              pageExternalId: page.pageId,
              externalName: w.externalName,
              ...(w.label ? { label: w.label } : {}),
              ...routing,
              updatedAt: new Date(),
            })
            .where(eq(inboxPhoneNumber.id, id));
          return id;
        };
        const byKey = and(eq(inboxPhoneNumber.kind, w.kind), eq(inboxPhoneNumber.externalId, w.externalId));
        const [existing] = await tx.select({ id: inboxPhoneNumber.id }).from(inboxPhoneNumber).where(byKey);
        if (existing) {
          out.push(await reactivate(existing.id));
          continue;
        }
        // ON CONFLICT DO NOTHING: two people clicking at once never make two rows (rule R2).
        const [inserted] = await tx
          .insert(inboxPhoneNumber)
          .values({
            kind: w.kind,
            externalId: w.externalId,
            pageExternalId: page.pageId,
            externalName: w.externalName,
            e164: null,
            channels: "whatsapp",
            label: w.label ?? DEFAULT_LABEL[w.kind],
            defaultTeamId: body.default_team_id ?? null,
            hoursProfileId: body.hours_profile_id ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: inboxPhoneNumber.id });
        if (inserted) {
          out.push(inserted.id);
        } else {
          const [raced] = await tx.select({ id: inboxPhoneNumber.id }).from(inboxPhoneNumber).where(byKey);
          if (!raced) throw new Error("channel row vanished during connect");
          out.push(await reactivate(raced.id));
        }
      }
      return out;
    });

    // 4b. Spec 02: ask Meta to send this Page's messages to us (outside the transaction:
    // never hold a database transaction open across a call to Meta). A refusal keeps
    // the rows and shows the problem on the Channels page.
    const now = new Date();
    try {
      await subscribePageKeepingFields(cfg, page.pageId);
      await db
        .update(inboxPhoneNumber)
        .set({ webhookSubscribedAt: now, webhookCheckedAt: now, updatedAt: now })
        .where(and(eq(inboxPhoneNumber.pageExternalId, page.pageId), inArray(inboxPhoneNumber.kind, ["messenger", "instagram"])));
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      await db
        .update(inboxPhoneNumber)
        .set({
          problemText: `Connected, but Meta would not switch on message delivery: ${channelErrorSentence(err)}`,
          problemCode: err.code ? (err.subcode ? `${err.code}/${err.subcode}` : err.code) : null,
          problemAt: now,
          updatedAt: now,
        })
        .where(inArray(inboxPhoneNumber.id, ids));
    }
    // Messages Meta sent before the account was connected come in now (rule R4).
    for (const w of wanted) await unparkEventsForAccount(db, w.kind, w.externalId);

    const rows = await channelRows(db, ids);
    // 5. One audit entry per row.
    for (const row of rows) {
      await writeAudit(db, c, {
        action: "channels.connect",
        entityType: "inbox_phone_number",
        entityId: row.id,
        after: { kind: row.kind, label: row.label, external_name: row.external_name },
        notify: true,
      });
    }
    // 6. People who see every line see the new one at once.
    clearInboxViewerCache();
    return c.json({ data: rows }, 201);
  });

  r.patch("/:id", async (c) => {
    const id = idParam(c);
    const body = PatchBody.parse(await c.req.json());
    const [before] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, id));
    if (!before) throw new BusinessError("not_found", "not found", 404);
    if (before.kind === "phone") throw new BusinessError("validation_failed", PHONE_ELSEWHERE, 400);
    await checkRouting(db, body.default_team_id, body.hours_profile_id);

    await db
      .update(inboxPhoneNumber)
      .set({
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.default_team_id !== undefined ? { defaultTeamId: body.default_team_id } : {}),
        ...(body.hours_profile_id !== undefined ? { hoursProfileId: body.hours_profile_id } : {}),
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
        updatedAt: new Date(),
      })
      .where(eq(inboxPhoneNumber.id, id));

    const onlySwitch = body.is_active !== undefined && Object.keys(body).length === 1;
    const action = onlySwitch ? (body.is_active ? "channels.switch_on" : "channels.switch_off") : "channels.update";
    await writeAudit(db, c, {
      action,
      entityType: "inbox_phone_number",
      entityId: id,
      after: body,
      before: {
        label: before.label,
        default_team_id: before.defaultTeamId,
        hours_profile_id: before.hoursProfileId,
        is_active: before.isActive,
      },
      notify: true,
    });
    if (body.is_active !== undefined) clearInboxViewerCache();
    const [row] = await channelRows(db, [id]);
    return c.json({ data: row });
  });

  /** Is the Page (and its Instagram account) still reachable? Always 200; the answer is in the body. */
  r.post("/:id/check", async (c) => {
    const id = idParam(c);
    const [num] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, id));
    if (!num) throw new BusinessError("not_found", "not found", 404);
    if (num.kind === "phone" || !num.pageExternalId) throw new BusinessError("validation_failed", PHONE_ELSEWHERE, 400);
    const cfg = metaConfigFromEnv();
    if (!cfg) return c.json({ data: { ok: false, problem: NOT_CONNECTED, external_name: num.externalName } });

    const pageId = num.pageExternalId;
    let page: ConnectablePage;
    try {
      clearPageTokenCache(pageId);
      await pageAccessToken(cfg, pageId);
      page = await describePage(cfg, pageId);
    } catch (err) {
      if (err instanceof MetaApiError) {
        return c.json({ data: { ok: false, problem: channelErrorSentence(err), external_name: num.externalName } });
      }
      throw err;
    }
    if (num.kind === "instagram" && page.instagram?.id !== num.externalId) {
      return c.json({ data: { ok: false, problem: INSTAGRAM_UNLINKED, external_name: num.externalName } });
    }
    const externalName = (num.kind === "instagram" ? page.instagram?.username : page.name) || num.externalName;
    await db
      .update(inboxPhoneNumber)
      .set({ externalName, updatedAt: new Date() })
      .where(eq(inboxPhoneNumber.id, id));

    // Spec 02: is Meta still sending us this Page's messages? If not, switch it back on once.
    const now = new Date();
    let resubscribed = false;
    try {
      let subscribed = await isPageSubscribed(cfg, pageId);
      if (!subscribed) {
        await subscribePageKeepingFields(cfg, pageId);
        resubscribed = true;
        subscribed = await isPageSubscribed(cfg, pageId);
      }
      await db
        .update(inboxPhoneNumber)
        .set({
          webhookCheckedAt: now,
          // Rows connected before spec 02 learn their subscription here.
          ...(resubscribed
            ? { webhookSubscribedAt: now }
            : subscribed
              ? { webhookSubscribedAt: sql`coalesce(${inboxPhoneNumber.webhookSubscribedAt}, now())` }
              : {}),
        })
        .where(eq(inboxPhoneNumber.id, id));
      if (!subscribed) return c.json({ data: { ok: false, problem: NOT_RECEIVING, external_name: externalName } });
    } catch (err) {
      if (err instanceof MetaApiError) {
        return c.json({ data: { ok: false, problem: channelErrorSentence(err), external_name: externalName } });
      }
      throw err;
    }
    // All good: the next success clears any earlier problem (rule R20).
    await db
      .update(inboxPhoneNumber)
      .set({ problemCode: null, problemText: null, problemAt: null, updatedAt: now })
      .where(eq(inboxPhoneNumber.id, id));
    return c.json({ data: { ok: true, problem: null, external_name: externalName } });
  });

  return r;
}
