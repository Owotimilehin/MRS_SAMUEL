/**
 * Facebook Page details (suite spec 10, section 5.3): read a Page's public details,
 * change the ones the suite may change, list who changed what. Mounted at
 * /v1/channels/:accountId/page, before the /v1/channels router.
 *
 * Every route needs channels.manage. A change reaches Facebook only through PATCH,
 * which needs `confirm: true`, sends only the fields the person changed, reads the
 * Page back afterwards and writes an audit row (foundation rule 7). No token is ever
 * read, logged, stored or returned here (R14): the Page token stays inside @ms/domain.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { adminUser, auditLog, inboxPhoneNumber, type DbClient } from "@ms/db";
import {
  MetaApiError,
  PAGE_UNKNOWN_TEXT,
  describePageDetailsError,
  metaConfigFromEnv,
  readInstagramProfile,
  readPage,
  readPageTasks,
  updatePage,
  type ChannelAccount,
  type InstagramProfile,
  type MetaConfig,
  type PageDetailsError,
  type PageSnapshot,
} from "@ms/domain";
import {
  PAGE_EDITABLE_KEYS,
  PAGE_LIMITS,
  normalisePageChanges,
  samePageValue,
  validatePageChanges,
  type PageEditable,
  type PageEditableKey,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { alertOnce } from "../lib/inbox-alerts.js";
import { BusinessError } from "../lib/errors.js";

const Uuid = z.string().uuid();
const CACHE_TTL_MS = 60_000;

const NOT_CONNECTED = "Meta is not connected on this server.";
const SWITCHED_OFF = "This account is switched off in Channels.";
const INSTAGRAM_ONLY = "These details can only be changed in the Instagram app.";
const FACEBOOK_ONLY = "These details can only be changed on Facebook.";
const STALE =
  "These details were changed on Facebook since you opened this page. Check the new values and try again.";

/** Tests shorten the wait before the second read-back (step 6). */
export const pageDetailsTimings = { readBackDelayMs: 1500 };

// ── The live read cache (60 seconds) ─────────────────────────────────────────

interface CachedRead {
  at: number;
  page: PageSnapshot | null;
  instagram: InstagramProfile | null;
  tasks: string[] | null;
}
const cache = new Map<string, CachedRead>();

/** Forget every cached read (tests; a restart does the same). */
export function clearPageDetailsCache(): void {
  cache.clear();
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface PageDetailsView {
  account: { id: string; label: string; kind: "messenger" | "instagram"; is_active: boolean };
  page: PageSnapshot | null;
  instagram: InstagramProfile | null;
  can_edit: boolean;
  cannot_edit_reason: "instagram" | "inactive" | "no_manage_task" | null;
  read_at: string;
  limits: typeof PAGE_LIMITS;
}

const TimeText = z.string().max(5);
const Range = z.object({ open: TimeText, close: TimeText }).strict();
const Ranges = z.array(Range).max(2);
const Week = z
  .object({ mon: Ranges, tue: Ranges, wed: Ranges, thu: Ranges, fri: Ranges, sat: Ranges, sun: Ranges })
  .strict();
const Address = z
  .object({
    street: z.string().max(500),
    city: z.string().max(500),
    state: z.string().max(500),
    country: z.string().max(500),
    zip: z.string().max(100),
  })
  .strict();
// Strict on purpose (R2): name, username, category, cover and "published" are unknown keys, so 400.
const Fields = z
  .object({
    about: z.string().max(5000).nullable(),
    description: z.string().max(10_000).nullable(),
    phone: z.string().max(100).nullable(),
    website: z.string().max(1000).nullable(),
    emails: z.array(z.string().max(500)).max(50),
    always_open: z.boolean(),
    hours: Week.nullable(),
    address: Address.nullable(),
  })
  .partial()
  .strict();
const PatchBody = z.object({ confirm: z.literal(true), expected: Fields, changes: Fields }).strict();

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadAccount(db: DbClient, c: Context): Promise<ChannelAccount> {
  const id = Uuid.safeParse(c.req.param("accountId"));
  if (!id.success) throw new BusinessError("not_found", "not found", 404);
  const [r] = await db
    .select({
      id: inboxPhoneNumber.id,
      kind: inboxPhoneNumber.kind,
      label: inboxPhoneNumber.label,
      externalId: inboxPhoneNumber.externalId,
      pageId: inboxPhoneNumber.pageExternalId,
      isActive: inboxPhoneNumber.isActive,
    })
    .from(inboxPhoneNumber)
    .where(eq(inboxPhoneNumber.id, id.data));
  if (!r || (r.kind !== "messenger" && r.kind !== "instagram")) throw new BusinessError("not_found", "not found", 404);
  return { ...r, kind: r.kind };
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
  return cfg;
}

/** The read-failure sentence (5.5). */
function readFailure(err: unknown): BusinessError {
  if (!(err instanceof MetaApiError)) throw err;
  const d = describePageDetailsError(err);
  return new BusinessError("service_unavailable", `We could not load the Page from Facebook. ${d.text}`, 502, {
    meta_code: d.code,
  });
}

async function fetchRead(cfg: MetaConfig, account: ChannelAccount): Promise<CachedRead> {
  if (account.kind === "instagram") {
    const instagram = await readInstagramProfile(cfg, account);
    return { at: Date.now(), page: null, instagram, tasks: null };
  }
  const page = await readPage(cfg, account);
  const tasks = account.pageId ? await readPageTasks(cfg, account.pageId) : null;
  return { at: Date.now(), page, instagram: null, tasks };
}

/** A read through the cache; `fresh` skips it and stores the result. Meta trouble becomes a 502. */
async function readThroughCache(account: ChannelAccount, opts: { fresh?: boolean } = {}): Promise<CachedRead> {
  const hit = cache.get(account.id);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const cfg = needConfig();
  try {
    const read = await fetchRead(cfg, account);
    cache.set(account.id, read);
    return read;
  } catch (err) {
    throw readFailure(err);
  }
}

function viewOf(account: ChannelAccount, read: CachedRead): PageDetailsView {
  const kind = account.kind as "messenger" | "instagram";
  let reason: PageDetailsView["cannot_edit_reason"] = null;
  if (kind === "instagram") reason = "instagram";
  else if (!account.isActive) reason = "inactive";
  else if (read.tasks !== null && !read.tasks.includes("MANAGE")) reason = "no_manage_task";
  return {
    account: { id: account.id, label: account.label, kind, is_active: account.isActive },
    page: read.page,
    instagram: read.instagram,
    can_edit: reason === null,
    cannot_edit_reason: reason,
    read_at: new Date(read.at).toISOString(),
    limits: PAGE_LIMITS,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Which of `keys` the live Page now shows as `wanted`. */
function matching(live: PageEditable, wanted: Partial<PageEditable>, keys: PageEditableKey[]): {
  saved: PageEditableKey[];
  notSaved: PageEditableKey[];
} {
  const saved: PageEditableKey[] = [];
  const notSaved: PageEditableKey[] = [];
  for (const k of keys) (samePageValue(k, live[k], wanted[k]) ? saved : notSaved).push(k);
  return { saved, notSaved };
}

function pick<T extends object>(src: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (src as Record<string, unknown>)[k];
  return out as Partial<T>;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function channelPageRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("channels.manage"));

  r.get("/", async (c) => {
    const account = await loadAccount(db, c);
    const read = await readThroughCache(account, { fresh: c.req.query("fresh") === "1" });
    return c.json({ data: viewOf(account, read) });
  });

  r.get("/history", async (c) => {
    const account = await loadAccount(db, c);
    const limit = Math.min(50, Math.max(1, Number.parseInt(c.req.query("limit") ?? "20", 10) || 20));
    const rows = await db
      .select({ row: auditLog, by: adminUser.name })
      .from(auditLog)
      .leftJoin(adminUser, eq(adminUser.id, auditLog.actorUserId))
      .where(and(eq(auditLog.action, "channels.page_update"), eq(auditLog.entityId, account.id)))
      .orderBy(desc(auditLog.occurredAt))
      .limit(limit);
    return c.json({
      data: rows.map(({ row, by }) => {
        const before = (row.beforeJson ?? {}) as Record<string, unknown>;
        const after = { ...((row.afterJson ?? {}) as Record<string, unknown>) };
        const result = typeof after.result === "string" ? after.result : "unknown";
        const notSaved = Array.isArray(after.not_saved) ? (after.not_saved as string[]) : [];
        for (const k of ["result", "not_saved", "meta_code", "meta_message"]) delete after[k];
        return {
          at: row.occurredAt.toISOString(),
          by_name: by ?? null,
          fields: Object.keys(before),
          before,
          after,
          result,
          not_saved: notSaved,
        };
      }),
    });
  });

  r.patch("/", async (c) => {
    const account = await loadAccount(db, c);
    // Step 1: confirm is literally true (R3), then the account must be an active Page.
    const body = PatchBody.parse(await c.req.json().catch(() => ({})));
    if (account.kind !== "messenger") throw new BusinessError("conflict", account.kind === "instagram" ? INSTAGRAM_ONLY : FACEBOOK_ONLY, 409);
    if (!account.isActive) throw new BusinessError("conflict", SWITCHED_OFF, 409);

    const changeKeys = Object.keys(body.changes).sort();
    const expectedKeys = Object.keys(body.expected).sort();
    if (changeKeys.length === 0 || changeKeys.join() !== expectedKeys.join()) {
      throw new BusinessError("validation_failed", "Send the changed fields and what each one was before, with the same fields in both.", 400);
    }

    // Step 2: tidy, then check.
    const changes = normalisePageChanges(body.changes as Partial<PageEditable>);
    const problems = validatePageChanges(changes);
    if (problems.length > 0) {
      throw new BusinessError("validation_failed", problems[0]!.message, 400, { field: problems[0]!.field, problems });
    }
    // Always open on: the hours are not sent, so they are not part of this change (R9).
    if (changes.always_open === true) delete changes.hours;
    const expected = body.expected as Partial<PageEditable>;
    const asked = PAGE_EDITABLE_KEYS.filter((k) => k in changes);

    const cfg = needConfig();

    // Step 3: read fresh; a changed field that is no longer what the person saw means stale (R4).
    let liveRead: CachedRead;
    try {
      liveRead = await fetchRead(cfg, account);
    } catch (err) {
      cache.delete(account.id);
      throw readFailure(err);
    }
    cache.set(account.id, liveRead);
    const live = liveRead.page!.editable;
    const clash = asked.some((k) => !samePageValue(k, live[k], expected[k]));
    if (clash) {
      throw new BusinessError("conflict", STALE, 409, { reason: "stale", view: viewOf(account, liveRead) });
    }

    // Step 4: leave out what is already so (R1). Nothing left: nothing to send.
    const remaining = asked.filter((k) => !samePageValue(k, live[k], changes[k]));
    // Switching Always open off sends the hours with it, even when they match what is stored (R9).
    if (changes.always_open === false && remaining.includes("always_open") && changes.hours && !remaining.includes("hours")) {
      remaining.push("hours");
    }
    if (remaining.length === 0) {
      return c.json({ data: { view: viewOf(account, liveRead), saved: [], not_saved: [] } });
    }
    const send = pick(changes, remaining) as Partial<PageEditable>;

    // Step 5: the one call that changes the Page.
    let failure: MetaApiError | null = null;
    try {
      await updatePage(cfg, account, send);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      failure = err;
    }
    const described: PageDetailsError | null = failure ? describePageDetailsError(failure) : null;

    // Step 6: read it back; look once more if something still shows the old value (8, R5, R6).
    let back: CachedRead | null = null;
    let outcome: ReturnType<typeof matching> = { saved: [], notSaved: remaining };
    const readBack = async (): Promise<boolean> => {
      try {
        back = await fetchRead(cfg, account);
        outcome = matching(back.page!.editable, send, remaining);
        return true;
      } catch (err) {
        if (!(err instanceof MetaApiError)) throw err;
        return false;
      }
    };
    const readable = await readBack();
    if (readable && outcome.notSaved.length > 0 && (!failure || failure.delivery === "unknown")) {
      if (pageDetailsTimings.readBackDelayMs > 0) await sleep(pageDetailsTimings.readBackDelayMs);
      await readBack();
    }
    const { saved, notSaved } = outcome;
    const refusedOutright = failure !== null && failure.delivery !== "unknown";
    const result: "saved" | "partly_saved" | "refused" | "unknown" = !readable
      ? refusedOutright
        ? "refused"
        : "unknown"
      : notSaved.length === 0
        ? "saved"
        : saved.length > 0
          ? "partly_saved"
          : refusedOutright
            ? "refused"
            : "unknown";

    // Step 7: one audit row for every attempt that reached Meta (R13).
    await writeAudit(db, c, {
      action: "channels.page_update",
      entityType: "facebook_page",
      entityId: account.id,
      before: pick(live, remaining),
      after: {
        ...send,
        result,
        not_saved: notSaved,
        meta_code: described?.code ?? null,
        meta_message: described?.metaMessage ?? null,
      },
      notify: true,
    });
    if (described?.cls === "config") {
      await alertOnce(db, "channels.page_config", {
        account: account.id,
        account_id: account.id,
        label: account.label,
        code: described.code,
        message: described.metaMessage,
      });
    }

    // Step 8: keep the read-back for the next screen.
    const backRead = back as CachedRead | null;
    if (backRead) cache.set(account.id, backRead);
    else cache.delete(account.id);
    const details = backRead ? { view: viewOf(account, backRead), meta_code: described?.code ?? null } : { meta_code: described?.code ?? null };

    if (failure && result === "unknown") {
      throw new BusinessError("service_unavailable", PAGE_UNKNOWN_TEXT, 504, details);
    }
    if (failure && result === "refused") {
      const status = described!.cls === "temporary" ? 502 : 409;
      throw new BusinessError(status === 502 ? "service_unavailable" : "conflict", described!.text, status, details);
    }
    if (!backRead) {
      // Facebook said yes but we cannot read the Page to check: never call that saved.
      throw new BusinessError("service_unavailable", PAGE_UNKNOWN_TEXT, 504, details);
    }
    return c.json({ data: { view: viewOf(account, backRead), saved, not_saved: notSaved } });
  });

  return r;
}
