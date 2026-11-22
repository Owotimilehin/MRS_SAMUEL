/**
 * The top-bar search asks the three list endpoints the pages already use, in
 * parallel, each for a handful of rows. Each keeps its own permission and scope
 * rules on the server (staff only ever get chats they may see).
 *   Chats:    GET /v1/inbox/conversations?q=&status=all&limit=
 *   Contacts: GET /v1/contacts?filter={"q":…}&sort=last_contact&limit=
 *   Posts:    GET /v1/social/posts?q=&status=all&limit=
 */
import { api } from "@admin/lib/api.js";
import {
  PER_GROUP,
  inboxQuery,
  postMatches,
  type ChatHit,
  type ContactHit,
  type PostHit,
  type RawResults,
  type SearchKind,
} from "./search-logic.js";

export const searchKeys = {
  all: ["suite-search"] as const,
  run: (text: string, kinds: readonly SearchKind[]) => ["suite-search", text, kinds.join(",")] as const,
};

const qs = (o: Record<string, string>): string => new URLSearchParams(o).toString();
const silent = { silentError: true };
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

async function chats(text: string, signal?: AbortSignal): Promise<ChatHit[]> {
  const res = await api<{ data: ChatHit[] }>(
    `/inbox/conversations?${qs({ q: inboxQuery(text), status: "all", view: "all", limit: String(PER_GROUP) })}`,
    { signal: signal ?? null },
    silent,
  );
  return res.data;
}

async function contacts(text: string, signal?: AbortSignal): Promise<ContactHit[]> {
  const res = await api<{ data: { contacts: ContactHit[] } }>(
    `/contacts?${qs({ filter: JSON.stringify({ q: text }), sort: "last_contact", limit: String(PER_GROUP) })}`,
    { signal: signal ?? null },
    silent,
  );
  return res.data.contacts;
}

async function posts(text: string, signal?: AbortSignal): Promise<PostHit[]> {
  const res = await api<{ data: PostHit[] }>(`/social/posts?${qs({ q: text, status: "all", limit: String(PER_GROUP) })}`, { signal: signal ?? null }, silent);
  return res.data.filter((p) => postMatches(p, text));
}

const RUNNERS: Record<SearchKind, (text: string, signal?: AbortSignal) => Promise<unknown[]>> = { chats, contacts, posts };

/** Every allowed group at once. A group that fails comes back as an Error; the others still show. */
export async function searchAll(text: string, kinds: readonly SearchKind[], signal?: AbortSignal): Promise<RawResults> {
  const settled = await Promise.allSettled(kinds.map((k) => RUNNERS[k](text, signal)));
  const out: Record<string, unknown> = {};
  kinds.forEach((k, i) => {
    const s = settled[i]!;
    out[k] = s.status === "fulfilled" ? s.value : asError(s.reason);
  });
  return out as RawResults;
}
