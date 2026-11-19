/**
 * Channel accounts (suite spec 01, foundation D1 and D13).
 *
 * A row of inbox_phone_number is a "channel account": a phone line, a Facebook
 * Page (kind 'messenger') or an Instagram account (kind 'instagram'). This file
 * reads those rows, lists the Pages our system user can reach at Meta, and
 * hands out Page access tokens.
 *
 * Page tokens are fetched at run time with the system-user token and kept in
 * process memory for one hour. They are never stored, logged or returned.
 */
import { asc, and, eq } from "drizzle-orm";
import { inboxPhoneNumber, type DbExecutor } from "@ms/db";
import type { ChannelKind } from "@ms/shared";
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";

export type { ChannelKind, IdentityChannel } from "@ms/shared";

/** A row of inbox_phone_number seen as a channel account. */
export interface ChannelAccount {
  /** inbox_phone_number.id */
  id: string;
  kind: ChannelKind;
  label: string;
  /** Page ID or Instagram account ID; null for phones. */
  externalId: string | null;
  /** The Page that owns it (same as externalId for messenger); null for phones. */
  pageId: string | null;
  isActive: boolean;
}

const accountColumns = {
  id: inboxPhoneNumber.id,
  kind: inboxPhoneNumber.kind,
  label: inboxPhoneNumber.label,
  externalId: inboxPhoneNumber.externalId,
  pageId: inboxPhoneNumber.pageExternalId,
  isActive: inboxPhoneNumber.isActive,
};

function toAccount(r: { id: string; kind: string; label: string; externalId: string | null; pageId: string | null; isActive: boolean }): ChannelAccount {
  return { ...r, kind: r.kind as ChannelKind };
}

/** Every channel account (active and switched off; callers filter), by label. */
export async function listChannelAccounts(db: DbExecutor, kind?: ChannelKind): Promise<ChannelAccount[]> {
  const rows = await db
    .select(accountColumns)
    .from(inboxPhoneNumber)
    .where(kind ? eq(inboxPhoneNumber.kind, kind) : undefined)
    .orderBy(asc(inboxPhoneNumber.label));
  return rows.map(toAccount);
}

/**
 * One account by (kind, external_id), active or not, or null. A webhook needs
 * to tell "known but switched off" from "unknown".
 */
export async function channelAccountByExternalId(
  db: DbExecutor,
  kind: ChannelKind,
  externalId: string,
): Promise<ChannelAccount | null> {
  const [row] = await db
    .select(accountColumns)
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.kind, kind), eq(inboxPhoneNumber.externalId, externalId)))
    .limit(1);
  return row ? toAccount(row) : null;
}

// ── Page access tokens ───────────────────────────────────────────────────────

const PAGE_TOKEN_TTL_MS = 60 * 60 * 1000;
const pageTokens = new Map<string, { token: string; expiresAt: number }>();
const pageTokensInFlight = new Map<string, Promise<string>>();

/**
 * Page access token for a Page, fetched with the system-user token and cached
 * in memory for 1 hour. Concurrent callers share one request. A failed fetch is
 * not cached. Never stored, never logged.
 */
export async function pageAccessToken(cfg: MetaConfig, pageId: string): Promise<string> {
  const hit = pageTokens.get(pageId);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const inFlight = pageTokensInFlight.get(pageId);
  if (inFlight) return inFlight;

  const fetchToken = (async () => {
    try {
      const res = await graph<{ access_token?: string }>(
        cfg,
        "GET",
        `${encodeURIComponent(pageId)}?fields=access_token`,
      );
      if (!res?.access_token) {
        throw new MetaApiError("Meta did not give us a token for this Page", 403, "no_page_token", false);
      }
      pageTokens.set(pageId, { token: res.access_token, expiresAt: Date.now() + PAGE_TOKEN_TTL_MS });
      return res.access_token;
    } finally {
      pageTokensInFlight.delete(pageId);
    }
  })();
  pageTokensInFlight.set(pageId, fetchToken);
  return fetchToken;
}

/**
 * Forget a cached Page token (one Page, or all with no argument). Callers that
 * get Meta code 190 on a Page-token call clear it for that Page and retry once.
 */
export function clearPageTokenCache(pageId?: string): void {
  if (pageId === undefined) pageTokens.clear();
  else pageTokens.delete(pageId);
}

/** The same config with the Page's token as the bearer. */
export async function withPageToken(cfg: MetaConfig, pageId: string): Promise<MetaConfig> {
  return { ...cfg, token: await pageAccessToken(cfg, pageId) };
}

// ── Pages we can connect ─────────────────────────────────────────────────────

export interface ConnectablePage {
  pageId: string;
  name: string;
  tasks: string[];
  /** tasks includes "MESSAGING". */
  canMessage: boolean;
  instagram: { id: string; username: string | null } | null;
}

interface GraphPage {
  id: string;
  name?: string;
  tasks?: string[];
  instagram_business_account?: { id?: string; username?: string };
}

function instagramOf(p: GraphPage): ConnectablePage["instagram"] {
  const ig = p.instagram_business_account;
  return ig?.id ? { id: ig.id, username: ig.username ?? null } : null;
}

const MAX_ACCOUNT_PAGES = 10;

/** The Pages the system user can reach, each with its linked Instagram account. */
export async function listConnectablePages(cfg: MetaConfig): Promise<ConnectablePage[]> {
  const out: ConnectablePage[] = [];
  let next: string | null = "me/accounts?fields=name,tasks,instagram_business_account{id,username}&limit=100";
  for (let page = 0; next && page < MAX_ACCOUNT_PAGES; page++) {
    const res: { data?: GraphPage[]; paging?: { next?: string } } = await graph(cfg, "GET", next);
    for (const p of res?.data ?? []) {
      if (!p.id) continue;
      const tasks = p.tasks ?? [];
      out.push({ pageId: p.id, name: p.name ?? "", tasks, canMessage: tasks.includes("MESSAGING"), instagram: instagramOf(p) });
    }
    next = res?.paging?.next ?? null;
  }
  return out;
}

/**
 * One Page by ID. `tasks` is unknown here, so it is [] and canMessage is
 * assumed true. Used when the list is empty and by "Check connection".
 */
export async function describePage(cfg: MetaConfig, pageId: string): Promise<ConnectablePage> {
  const p = await graph<GraphPage>(
    cfg,
    "GET",
    `${encodeURIComponent(pageId)}?fields=name,instagram_business_account{id,username}`,
  );
  return { pageId: p.id ?? pageId, name: p.name ?? "", tasks: [], canMessage: true, instagram: instagramOf(p) };
}
