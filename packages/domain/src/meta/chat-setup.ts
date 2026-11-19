/**
 * Chat set-up for Messenger and Instagram (suite spec 04): the Messenger Profile
 * API (welcome text, Get started button, starter questions, persistent menu).
 *
 * One API serves both channels; it is called with the Page access token. Nothing
 * here stores, logs or returns a token. A publish is always a deliberate action by
 * a person (foundation rule 7); this file never runs on a timer.
 *
 * The pure functions come first (Meta's shape <-> ours, the plan of calls); the
 * Graph calls and publishChatSetup follow.
 */
import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { channelChatSetup, inboxPhoneNumber, outboxEvent, type DbClient } from "@ms/db";
import {
  CHAT_SETUP_LIMITS,
  CHAT_SETUP_PAYLOAD,
  normaliseChatSetup,
  validateChatSetup,
  describeChatSetupPayload,
  type ChatSetupConfig,
  type ChatSetupMenuItem,
} from "@ms/shared";
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";
import type { ChannelAccount } from "./accounts.js";
import { classifyMessagingError, withPageTokenRetry } from "./messaging.js";

export type ProfileKind = "messenger" | "instagram";

export interface LiveProfile {
  get_started?: { payload: string };
  greeting?: { locale: string; text: string }[];
  ice_breakers?: { locale?: string; call_to_actions?: { question: string; payload: string }[] }[];
  persistent_menu?: {
    locale: string;
    composer_input_disabled?: boolean;
    call_to_actions: { type: string; title: string; payload?: string; url?: string }[];
  }[];
}

/** The only four properties this feature ever reads, sets or deletes (rule R5). */
export const PROFILE_FIELDS = ["get_started", "greeting", "ice_breakers", "persistent_menu"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** The properties that exist for a kind (Instagram has no welcome text or Get started: N3). */
export function profileFieldsFor(kind: ProfileKind): ProfileField[] {
  return kind === "messenger" ? [...PROFILE_FIELDS] : ["ice_breakers", "persistent_menu"];
}

/** The entry for the default locale, or the first entry when none is marked. */
function defaultEntry<T extends { locale?: string }>(list: T[] | undefined): T | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.find((e) => e?.locale === "default") ?? list[0];
}

function otherLocalesOf(list: { locale?: string }[] | undefined): string[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  const def = defaultEntry(list);
  return list.filter((e) => e !== def).map((e) => e?.locale ?? "unknown");
}

/** Meta's shape -> ours, plus what we could not represent. Pure. */
export function profileToConfig(
  live: LiveProfile,
  kind: ProfileKind,
): { config: ChatSetupConfig; otherLocales: string[]; foreignPayloads: boolean; composerDisabled: boolean } {
  const L = CHAT_SETUP_LIMITS;
  let foreignPayloads = false;
  const foreign = (payload: unknown) => {
    if (describeChatSetupPayload(typeof payload === "string" ? payload : null) === null) foreignPayloads = true;
  };

  const locales = new Set<string>();
  const note = (list: { locale?: string }[] | undefined) => otherLocalesOf(list).forEach((l) => locales.add(l));

  let greeting: string | null = null;
  let getStarted = false;
  if (kind === "messenger") {
    note(live.greeting);
    const g = defaultEntry(live.greeting);
    greeting = typeof g?.text === "string" && g.text.length > 0 ? g.text : null;
    if (live.get_started) {
      getStarted = true;
      foreign(live.get_started.payload);
    }
  }

  note(live.ice_breakers);
  const ice = defaultEntry(live.ice_breakers);
  const questions = (ice?.call_to_actions ?? []).filter((q) => typeof q?.question === "string");
  questions.forEach((q) => foreign(q.payload));
  const iceBreakers = questions.map((q) => q.question).slice(0, L.iceBreakerCount);

  note(live.persistent_menu);
  const menuEntry = defaultEntry(live.persistent_menu);
  const composerDisabled = kind === "messenger" && menuEntry?.composer_input_disabled === true;
  const menu: ChatSetupMenuItem[] = [];
  for (const item of menuEntry?.call_to_actions ?? []) {
    if (item?.type === "postback") {
      foreign(item.payload);
      menu.push({ type: "postback", title: item.title ?? "" });
    } else if (item?.type === "web_url") {
      menu.push({ type: "web_url", title: item.title ?? "", url: item.url ?? "" });
    } else {
      foreignPayloads = true;
    }
  }
  if (menu.length > L.menuCount) menu.length = L.menuCount;

  return {
    config: { greeting, getStarted, iceBreakers, menu },
    otherLocales: [...locales],
    foreignPayloads,
    composerDisabled,
  };
}

/** Ours -> Meta's properties for the default locale. Pure. */
export function configToProfile(config: ChatSetupConfig, kind: ProfileKind): LiveProfile {
  const out: LiveProfile = {};
  if (kind === "messenger") {
    if (config.greeting !== null && config.greeting !== "") out.greeting = [{ locale: "default", text: config.greeting }];
    if (config.getStarted || config.menu.length > 0) out.get_started = { payload: CHAT_SETUP_PAYLOAD.start };
  }
  if (config.iceBreakers.length > 0) {
    out.ice_breakers = [
      {
        locale: "default",
        call_to_actions: config.iceBreakers.map((q, i) => ({ question: q, payload: CHAT_SETUP_PAYLOAD.ice(i + 1) })),
      },
    ];
  }
  if (config.menu.length > 0) {
    const call_to_actions = config.menu.map((m, i) => {
      if (m.type === "postback") {
        return { type: "postback", title: m.title, payload: CHAT_SETUP_PAYLOAD.menu(i + 1) };
      }
      return kind === "messenger"
        ? { type: "web_url", title: m.title, url: m.url ?? "", webview_height_ratio: "full" }
        : { type: "web_url", title: m.title, url: m.url ?? "" };
    });
    out.persistent_menu =
      kind === "messenger"
        ? [{ locale: "default", composer_input_disabled: false, call_to_actions }]
        : [{ locale: "default", call_to_actions }];
  }
  return out;
}

/** Is this property set at Meta (present and not empty)? */
function isPresent(live: LiveProfile, field: ProfileField): boolean {
  const v = live[field];
  if (v === undefined || v === null) return false;
  return Array.isArray(v) ? v.length > 0 : true;
}

/** What a default-locale entry says, reduced to the parts we compare. */
function comparable(live: LiveProfile, kind: ProfileKind) {
  const g = defaultEntry(live.greeting);
  const ice = defaultEntry(live.ice_breakers);
  const menu = defaultEntry(live.persistent_menu);
  return {
    greeting: kind === "messenger" ? (g?.text ?? null) : null,
    getStarted: kind === "messenger" ? (live.get_started ? (live.get_started.payload ?? "") : null) : null,
    ice: (ice?.call_to_actions ?? []).map((q) => [q.question, q.payload]),
    menu: (menu?.call_to_actions ?? []).map((m) => [m.type, m.title, m.payload ?? null, m.type === "web_url" ? (m.url ?? null) : null]),
    composerDisabled: kind === "messenger" && menu?.composer_input_disabled === true,
  };
}

/** True when Meta's live state is what `config` asks for (default locale only). Pure. */
export function liveMatches(config: ChatSetupConfig, live: LiveProfile, kind: ProfileKind): boolean {
  const want = comparable(configToProfile(config, kind), kind);
  const have = comparable(live, kind);
  return JSON.stringify({ ...want, composerDisabled: false }) === JSON.stringify({ ...have, composerDisabled: have.composerDisabled });
}

export interface PlanStep {
  op: "delete" | "set";
  fields: string[];
  body: Record<string, unknown>;
}

/** The ordered calls a publish must make, given what is live. Pure. */
export function planPublish(config: ChatSetupConfig, live: LiveProfile, kind: ProfileKind): PlanStep[] {
  if (liveMatches(config, live, kind) && profileToConfig(live, kind).otherLocales.length === 0) return [];

  const desired = configToProfile(config, kind);
  const fields = profileFieldsFor(kind);
  const plan: PlanStep[] = [];

  // Delete first: every property that is live and no longer wanted.
  const toDelete = fields.filter((f) => isPresent(live, f) && !isPresent(desired, f));
  if (toDelete.includes("get_started") && isPresent(live, "persistent_menu") && !toDelete.includes("persistent_menu")) {
    // Meta refuses to drop Get started while a menu exists (G10, G13): the menu always goes with it.
    toDelete.push("persistent_menu");
  }
  if (toDelete.includes("get_started") && isPresent(desired, "persistent_menu")) {
    throw new Error("A menu needs the Get started button: cannot delete get_started and set a menu");
  }
  if (toDelete.length > 0) {
    plan.push({ op: "delete", fields: PROFILE_FIELDS.filter((f) => toDelete.includes(f)), body: { fields: PROFILE_FIELDS.filter((f) => toDelete.includes(f)) } });
  }

  // Set A: everything except a menu that Meta might refuse because Get started is not set yet.
  const menuWithA = isPresent(desired, "persistent_menu") && (kind === "instagram" || isPresent(live, "get_started"));
  const a: Record<string, unknown> = {};
  for (const f of ["greeting", "get_started", "ice_breakers"] as const) {
    if (fields.includes(f) && isPresent(desired, f)) a[f] = desired[f];
  }
  if (menuWithA) a.persistent_menu = desired.persistent_menu;
  if (Object.keys(a).length > 0) plan.push({ op: "set", fields: Object.keys(a), body: a });

  // Set B: the menu on its own, after Get started exists (G10, G12).
  if (kind === "messenger" && isPresent(desired, "persistent_menu") && !menuWithA) {
    plan.push({ op: "set", fields: ["persistent_menu"], body: { persistent_menu: desired.persistent_menu } });
  }
  return plan;
}


// ── The Graph calls (Page token; Instagram adds platform=instagram) ──────────

function pageIdOf(account: ChannelAccount): string {
  if (!account.pageId) throw new MetaApiError("This account has no Page to act for", 403, "no_page_token", false);
  return account.pageId;
}

const PATH = "me/messenger_profile";

/** GET me/messenger_profile for the properties this feature owns. An empty data array means nothing is set. */
export async function readMessengerProfile(cfg: MetaConfig, account: ChannelAccount): Promise<LiveProfile> {
  const kind = account.kind as ProfileKind;
  const fields = profileFieldsFor(kind).join(",");
  const q = kind === "instagram" ? `?fields=${fields}&platform=instagram` : `?fields=${fields}`;
  const res = await withPageTokenRetry(cfg, pageIdOf(account), (token) =>
    graph<{ data?: Record<string, unknown>[] } | null>(cfg, "GET", `${PATH}${q}`, undefined, { token }),
  );
  const first = res?.data?.[0] ?? {};
  const out: Record<string, unknown> = {};
  for (const f of profileFieldsFor(kind)) if (first[f] !== undefined) out[f] = first[f];
  return out as LiveProfile;
}

/** POST me/messenger_profile: only the properties in `props` are overwritten. */
export async function setMessengerProfile(cfg: MetaConfig, account: ChannelAccount, props: Record<string, unknown>): Promise<void> {
  const instagram = account.kind === "instagram";
  const body = instagram ? { ...props, platform: "instagram" } : props;
  await withPageTokenRetry(cfg, pageIdOf(account), (token) =>
    graph(cfg, "POST", instagram ? `${PATH}?platform=instagram` : PATH, body, { token }),
  );
}

/** DELETE me/messenger_profile: only the properties named in `fields` are removed. */
export async function deleteMessengerProfile(cfg: MetaConfig, account: ChannelAccount, fields: string[]): Promise<void> {
  const instagram = account.kind === "instagram";
  const body = instagram ? { fields, platform: "instagram" } : { fields };
  await withPageTokenRetry(cfg, pageIdOf(account), (token) =>
    graph(cfg, "DELETE", instagram ? `${PATH}?platform=instagram` : PATH, body, { token }),
  );
}

// ── Errors in plain English (spec 04, 5.4) ───────────────────────────────────

export interface ChatSetupMetaError {
  cls: "config" | "temporary" | "rate_limit" | "unknown" | "refusal";
  /** "code" or "code/subcode"; null when Meta sent none. */
  code: string | null;
  text: string;
}

export function describeChatSetupMetaError(err: MetaApiError, label = ""): ChatSetupMetaError {
  const code = err.code ? (err.subcode ? `${err.code}/${err.subcode}` : err.code) : null;
  if (err.delivery === "unknown" && !err.code && err.status < 500) {
    return { cls: "unknown", code, text: "No answer from Meta, so we can't tell what is live. Press Check now in a minute." };
  }
  if (err.code === "613" || err.status === 429) {
    return { cls: "rate_limit", code, text: "Meta allows only a few set-up changes every 10 minutes. Try again shortly." };
  }
  const { cls } = classifyMessagingError(err, "Meta", label);
  if (cls === "config") {
    return { cls: "config", code, text: "The suite has lost its permission for this account. Ask the owner to check Channels." };
  }
  if (cls === "temporary") {
    return { cls: "temporary", code, text: "Meta is busy. Nothing was changed. Try again in a few minutes." };
  }
  return { cls: "refusal", code, text: `Meta refused this: ${err.message} (code ${code ?? "none"}).` };
}

// ── Publishing ───────────────────────────────────────────────────────────────

export type ChatSetupErrorCode = "not_found" | "not_publishable" | "invalid" | "too_soon" | "busy";

export class ChatSetupError extends Error {
  constructor(
    public readonly code: ChatSetupErrorCode,
    message: string,
    /** too_soon: when the rate guard next allows a publish. */
    public readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "ChatSetupError";
  }
}

export type ChatSetupRow = typeof channelChatSetup.$inferSelect;

export interface PublishStep {
  op: "delete" | "set" | "read";
  fields: string[];
  ok: boolean;
  code: string | null;
  message: string | null;
  at: string;
}

const WINDOW_MS = 10 * 60_000;
/** Meta allows 10 calls per 10 minutes per Page; a publish uses up to 5 (M5). */
export const MAX_PUBLISHES_PER_WINDOW = 2;
export const REPAIR_AFTER_MS = 2 * 60_000;
export const INTERRUPTED_TEXT = "The publish was interrupted. Check what is live, then publish again.";
export const NOT_SHOWING_TEXT = "Meta accepted the change but is not showing it yet";

/**
 * The rate guard (M5, R8): when two publishes for this Page (Messenger and
 * Instagram together) sit in the last 10 minutes, the time the next one is allowed; else null.
 */
export async function nextPublishAllowedAt(db: DbClient, pageId: string, now = new Date()): Promise<Date | null> {
  const since = new Date(now.getTime() - WINDOW_MS);
  // pushed_at is the latest try, so a version with any try in the window has pushed_at in it too.
  const rows = await db
    .select({ pushedAt: channelChatSetup.pushedAt, pushTries: channelChatSetup.pushTries })
    .from(channelChatSetup)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, channelChatSetup.accountId))
    .where(and(eq(inboxPhoneNumber.pageExternalId, pageId), gt(channelChatSetup.pushedAt, since)));
  // Every try counts, a "Try again" of the same version included (M6).
  const tries = rows
    .flatMap((r) => (r.pushTries && r.pushTries.length > 0 ? r.pushTries : [r.pushedAt!]))
    .map((t) => new Date(t))
    .filter((t) => t.getTime() > since.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  if (tries.length < MAX_PUBLISHES_PER_WINDOW) return null;
  const leaves = tries[tries.length - MAX_PUBLISHES_PER_WINDOW]!;
  return new Date(leaves.getTime() + WINDOW_MS);
}

async function loadAccount(db: DbClient, accountId: string): Promise<ChannelAccount | null> {
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
    .where(eq(inboxPhoneNumber.id, accountId));
  if (!r || (r.kind !== "messenger" && r.kind !== "instagram")) return null;
  return { ...r, kind: r.kind };
}

/** One owner alert per account per 24 hours for a configuration problem (D10). */
async function alertConfig(db: DbClient, account: ChannelAccount, code: string | null, message: string): Promise<void> {
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.eventType, "channels.chat_setup_config"),
        gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)),
        sql`${outboxEvent.payload}->>'account_id' = ${account.id}`,
      ),
    )
    .limit(1);
  if (recent) return;
  await db.insert(outboxEvent).values({
    eventType: "channels.chat_setup_config",
    payload: { account_id: account.id, label: account.label, code: code ?? "unknown", message },
  });
}

/**
 * Publish a draft, or retry a failed or unknown version, to Meta (spec 04, 5.3).
 * Only ever called for a person's confirmed click. Reads what is live, makes the
 * fewest calls that get there, reads back, and records the truth.
 */
export async function publishChatSetup(
  db: DbClient,
  cfg: MetaConfig,
  input: { accountId: string; version: number; userId: string },
): Promise<ChatSetupRow> {
  const account = await loadAccount(db, input.accountId);
  if (!account) throw new ChatSetupError("not_found", "This account has no chat set-up.");
  const kind = account.kind as ProfileKind;

  // 1. The row, its status and its content.
  const [row] = await db
    .select()
    .from(channelChatSetup)
    .where(and(eq(channelChatSetup.accountId, input.accountId), eq(channelChatSetup.version, input.version)));
  if (!row) throw new ChatSetupError("not_found", "That version does not exist.");
  if (!["draft", "failed", "unknown"].includes(row.status)) {
    throw new ChatSetupError("not_publishable", "This version cannot be published.");
  }
  const config = normaliseChatSetup(row.config as ChatSetupConfig, kind);
  const problems = validateChatSetup(config, kind);
  if (problems.length > 0) throw new ChatSetupError("invalid", problems[0]!.message);

  // 2. The rate guard, before anything reaches Meta.
  if (account.pageId) {
    const at = await nextPublishAllowedAt(db, account.pageId);
    if (at) throw new ChatSetupError("too_soon", "Meta allows only a few set-up changes every 10 minutes.", at);
  }

  // 3. Claim the row. No row back means someone else is publishing it.
  const [claimed] = await db
    .update(channelChatSetup)
    .set({
      status: "pushing",
      pushedByUserId: input.userId,
      pushedAt: new Date(),
      pushTries: sql`array_append(coalesce(${channelChatSetup.pushTries}, '{}'::timestamptz[]), now())`,
      steps: [],
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(and(eq(channelChatSetup.id, row.id), inArray(channelChatSetup.status, ["draft", "failed", "unknown"])))
    .returning({ id: channelChatSetup.id });
  if (!claimed) throw new ChatSetupError("busy", "Someone else is publishing this right now.");

  const steps: PublishStep[] = [];
  const step = (op: PublishStep["op"], fields: string[], err?: MetaApiError): void => {
    steps.push({
      op,
      fields,
      ok: !err,
      code: err ? (err.code ? (err.subcode ? `${err.code}/${err.subcode}` : err.code) : null) : null,
      message: err ? err.message : null,
      at: new Date().toISOString(),
    });
  };
  const save = async (patch: Partial<typeof channelChatSetup.$inferInsert>): Promise<ChatSetupRow> => {
    const [r] = await db
      .update(channelChatSetup)
      .set({ ...patch, steps, updatedAt: new Date() })
      .where(eq(channelChatSetup.id, row.id))
      .returning();
    return r!;
  };

  try {
    // 4. What is live now.
    let live: LiveProfile;
    try {
      live = await readMessengerProfile(cfg, account);
      step("read", [...profileFieldsFor(kind)]);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      step("read", [...profileFieldsFor(kind)], err);
      // Nothing was changed: a refusal or silence on the first read is a failed publish, not an unknown one.
      const d = describeChatSetupMetaError(err, account.label);
      if (d.cls === "config") await alertConfig(db, account, d.code, d.text);
      return await save({ status: "failed", errorCode: d.code, errorMessage: d.text });
    }

    // 5. The plan, then 6. the calls, stopping at the first failure.
    const plan = planPublish(config, live, kind);
    let failure: ChatSetupMetaError | null = null;
    for (const s of plan) {
      try {
        if (s.op === "delete") await deleteMessengerProfile(cfg, account, s.fields);
        else await setMessengerProfile(cfg, account, s.body);
        step(s.op, s.fields);
      } catch (err) {
        if (!(err instanceof MetaApiError)) throw err;
        step(s.op, s.fields, err);
        failure = describeChatSetupMetaError(err, account.label);
        break;
      }
    }

    // 7. Read back, whatever happened above (R10: show the true state).
    let after: LiveProfile | null = null;
    try {
      after = await readMessengerProfile(cfg, account);
      step("read", [...profileFieldsFor(kind)]);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      step("read", [...profileFieldsFor(kind)], err);
    }

    const matches = after !== null && liveMatches(config, after, kind);
    let status: "live" | "failed" | "unknown";
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (failure === null) {
      if (after === null) {
        // Every step said yes but we cannot see the result.
        status = "unknown";
        errorMessage = "No answer from Meta, so we can't tell what is live. Press Check now in a minute.";
      } else if (matches) {
        status = "live";
      } else {
        status = "failed";
        errorMessage = NOT_SHOWING_TEXT;
      }
    } else if (failure.cls === "unknown") {
      if (after === null) {
        status = "unknown";
        errorCode = failure.code;
        errorMessage = failure.text;
      } else if (matches) {
        status = "live";
      } else {
        status = "failed";
        errorCode = failure.code;
        errorMessage = failure.text;
      }
    } else {
      status = "failed";
      errorCode = failure.code;
      errorMessage = failure.text;
      if (failure.cls === "config") await alertConfig(db, account, failure.code, failure.text);
    }

    if (status === "live") {
      return await db.transaction(async (tx) => {
        await tx
          .update(channelChatSetup)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(
            and(
              eq(channelChatSetup.accountId, input.accountId),
              eq(channelChatSetup.status, "live"),
              ne(channelChatSetup.id, row.id),
            ),
          );
        const [r] = await tx
          .update(channelChatSetup)
          .set({
            status: "live",
            config,
            liveBefore: live,
            liveAfter: after,
            steps,
            errorCode: null,
            errorMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(channelChatSetup.id, row.id))
          .returning();
        return r!;
      });
    }
    return await save({ status, liveBefore: live, liveAfter: after, errorCode, errorMessage });
  } catch (err) {
    // Something on our side broke mid-way: never leave the row stuck in "pushing".
    await db
      .update(channelChatSetup)
      .set({ status: "unknown", steps, errorMessage: INTERRUPTED_TEXT, updatedAt: new Date() })
      .where(and(eq(channelChatSetup.id, row.id), eq(channelChatSetup.status, "pushing")));
    throw err;
  }
}

/**
 * A row stuck in "pushing" for more than 2 minutes means the process died
 * mid-publish. Called on every GET for the account (spec 04, section 6).
 */
export async function repairStuckPublish(db: DbClient, accountId: string, now = new Date()): Promise<void> {
  await db
    .update(channelChatSetup)
    .set({ status: "unknown", errorMessage: INTERRUPTED_TEXT, updatedAt: now })
    .where(
      and(
        eq(channelChatSetup.accountId, accountId),
        eq(channelChatSetup.status, "pushing"),
        lt(channelChatSetup.pushedAt, new Date(now.getTime() - REPAIR_AFTER_MS)),
      ),
    );
}
