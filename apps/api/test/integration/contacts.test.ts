import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  auditLog,
  branch,
  contactAlias,
  contactConsent,
  contactImport,
  contactImportRow,
  contactLabelMember,
  contactListMember,
  contactOrigin,
  customer,
  inboxConversation,
  inboxIdentity,
  inboxPhoneNumber,
  inboxTeam,
  inboxTeamMember,
  inboxUserNumberAccess,
  outboxEvent,
  saleOrder,
} from "@ms/db";
import { applyImportBatch, rebuildAllSummaries, recordConsent, refreshContactSummary } from "@ms/domain";
import type { ContactDetail, ContactFilter, ContactListView, ContactRow, ContactSort, ImportRowView } from "@ms/shared";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * The Contacts routes (suite spec 14, Phase A) against a real Postgres.
 * Nothing here reaches Meta. "Now" is fixed through contactDeps, so the
 * day-based filters never depend on the wall clock. Phone numbers are in the
 * made-up range 0700 555 xxxx; names and emails are invented.
 */

const NOW = new Date("2026-11-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("contacts routes", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let branchId: string;
  let lineId: string;
  let ownerId: string;
  let adminId: string;
  let owner: string;
  let admin: string;
  let manager: string;
  let staff: string;
  let viewOnly: string;
  let agent: string;
  let orderSeq = 0;

  async function call(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/contacts${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function data<T>(res: Response): Promise<T> {
    return ((await res.json()) as { data: T }).data;
  }
  async function message(res: Response): Promise<string> {
    return ((await res.json()) as { error: { message: string } }).error.message;
  }
  function listPath(o: { filter?: ContactFilter; sort?: ContactSort; limit?: number; cursor?: string | null } = {}): string {
    const p = new URLSearchParams();
    if (o.filter) p.set("filter", JSON.stringify(o.filter));
    if (o.sort) p.set("sort", o.sort);
    if (o.limit) p.set("limit", String(o.limit));
    if (o.cursor) p.set("cursor", o.cursor);
    const qs = p.toString();
    return qs ? `?${qs}` : "";
  }
  type Page = { contacts: ContactRow[]; next_cursor: string | null; total: number | null };

  async function newCustomer(v: Partial<typeof customer.$inferInsert> = {}): Promise<string> {
    const [row] = await db.insert(customer).values({ source: "online", ...v }).returning({ id: customer.id });
    await refreshContactSummary(db, [row!.id]);
    return row!.id;
  }
  async function order(customerId: string, totalNgn: number, at: Date, status: (typeof saleOrder.$inferInsert)["status"] = "paid"): Promise<void> {
    await db.insert(saleOrder).values({
      orderNumber: `T-CON-${++orderSeq}`,
      branchId,
      channel: "online",
      customerId,
      status,
      subtotalNgn: totalNgn,
      totalNgn,
      paymentMethod: "transfer",
      createdAtLocal: at,
      idempotencyKey: crypto.randomUUID(),
    });
    await refreshContactSummary(db, [customerId]);
  }
  async function auditRows(action: string, entityId?: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), ...(entityId ? [eq(auditLog.entityId, entityId)] : [])))
      .orderBy(auditLog.occurredAt);
  }
  async function newLabel(name: string): Promise<string> {
    const res = await call(admin, "POST", "/labels", { name });
    expect(res.status).toBe(201);
    return (await data<{ id: string }>(res)).id;
  }
  /** Save a confirmed import the way the worker does, batch by batch. */
  async function runImport(id: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const { done } = await applyImportBatch(db, id, 200);
      if (done) break;
    }
    await db.update(contactImport).set({ status: "applied", appliedAt: NOW }).where(eq(contactImport.id, id));
  }
  async function upload(cookie: string, csv: string, filename = "list.csv"): Promise<Response> {
    return call(cookie, "POST", "/imports", { filename, csv_text: csv });
  }
  const OPTIONS = {
    source_label: "event sign-up sheet",
    customer_source: "walkup_anonymous",
    consent_declared: "none",
    fill_blanks: false,
  } as const;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    ownerId = (await seedOwner(db)).id;
    adminId = (await seedUser(db, { email: "admin@example.com", role: "admin" })).id;
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    await seedUser(db, { email: "staff@example.com", role: "branch_staff" });
    await seedUser(db, { email: "viewonly@example.com", role: "branch_staff", granted: ["contacts.view"] });
    const agentUser = await seedUser(db, { email: "agent@example.com", role: "branch_staff", granted: ["contacts.view", "inbox.view"] });

    const [b] = await db.insert(branch).values({ name: "Test branch", code: "TCON" }).returning();
    branchId = b!.id;
    const [team] = await db.insert(inboxTeam).values({ name: "Customer care" }).returning();
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2347005559000", label: "Main line", channels: "both", wabaId: "WABA-T", waPhoneNumberId: "555009000", defaultTeamId: team!.id })
      .returning();
    lineId = line!.id;
    const [other] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2347005559001", label: "Second line", channels: "both", wabaId: "WABA-T", waPhoneNumberId: "555009001", defaultTeamId: team!.id })
      .returning();
    // The agent is in the team but may only use the second line.
    await db.insert(inboxTeamMember).values({ teamId: team!.id, userId: agentUser.id });
    await db.insert(inboxUserNumberAccess).values({ userId: agentUser.id, phoneNumberId: other!.id });

    const { contactDeps } = await import("../../src/routes/contacts.js");
    contactDeps.now = () => NOW;
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;

    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    admin = await loginAs(baseUrl, "admin@example.com", "userpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
    staff = await loginAs(baseUrl, "staff@example.com", "userpassword123");
    viewOnly = await loginAs(baseUrl, "viewonly@example.com", "userpassword123");
    agent = await loginAs(baseUrl, "agent@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  // ── The list ───────────────────────────────────────────────────────────────

  it("GET /v1/contacts needs contacts.view; a manager sees the list, branch staff get 403", async () => {
    await newCustomer({ name: "First Contact", phone: "+2347005551000" });
    expect((await fetch(`${baseUrl}/v1/contacts`)).status).toBe(401);
    expect((await call(staff, "GET", "")).status).toBe(403);
    const res = await call(manager, "GET", "");
    expect(res.status).toBe(200);
    const page = await data<Page>(res);
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.contacts.some((c) => c.name === "First Contact")).toBe(true);
    expect((await call(viewOnly, "GET", "")).status).toBe(200);
  });

  it("GET /v1/contacts pages by key in every sort order with no row repeated or missed across 3 pages", async () => {
    const label = await newLabel("Paging set");
    // Seven contacts, with ties on every sort key: two share a name, two have no name,
    // four never ordered (same spend, same last order), and none has a conversation.
    const specs: { name: string | null; spent?: number; orderedDaysAgo?: number }[] = [
      { name: "Paging Ada", spent: 30_000, orderedDaysAgo: 5 },
      { name: "Paging Ada", spent: 30_000, orderedDaysAgo: 5 },
      { name: "paging bola", spent: 90_000, orderedDaysAgo: 40 },
      { name: null },
      { name: null },
      { name: "Paging Chidi" },
      { name: "Paging Dayo" },
    ];
    const ids: string[] = [];
    for (const [i, s] of specs.entries()) {
      const id = await newCustomer({ name: s.name, phone: `+234700555101${i}`, createdAt: daysAgo(i < 4 ? 3 : 2) });
      if (s.spent) await order(id, s.spent, daysAgo(s.orderedDaysAgo!));
      ids.push(id);
    }
    expect((await call(admin, "POST", "/bulk/labels", { customer_ids: ids, add: [label] })).status).toBe(200);
    const filter: ContactFilter = { label_ids: [label] };

    for (const sort of ["name", "last_order", "spent", "last_contact", "added"] as const) {
      const seen: ContactRow[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await call(admin, "GET", listPath({ filter, sort, limit: 3, cursor }));
        expect(res.status, sort).toBe(200);
        const page = await data<Page>(res);
        // The total is given only with the first page.
        expect(page.total, sort).toBe(pages === 0 ? 7 : null);
        seen.push(...page.contacts);
        cursor = page.next_cursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages, sort).toBe(3);
      expect(seen.map((c) => c.id).sort(), sort).toEqual([...ids].sort());
      expect(new Set(seen.map((c) => c.id)).size, sort).toBe(7);
      if (sort === "spent") {
        expect(seen.map((c) => c.spent_ngn)).toEqual([90_000, 30_000, 30_000, 0, 0, 0, 0]);
      }
      if (sort === "name") {
        // No name sorts last; case does not matter.
        expect(seen.map((c) => c.name?.toLowerCase() ?? null)).toEqual([
          "paging ada",
          "paging ada",
          "paging bola",
          "paging chidi",
          "paging dayo",
          null,
          null,
        ]);
      }
      if (sort === "last_order") {
        expect(seen.slice(0, 3).map((c) => c.orders_count)).toEqual([1, 1, 1]);
        expect(seen[2]!.name).toBe("paging bola");
      }
    }
    // The page size is capped, and a bad one is refused.
    expect((await call(admin, "GET", "?limit=0")).status).toBe(400);
    expect((await call(admin, "GET", "?sort=shoe_size")).status).toBe(400);
    expect((await data<Page>(await call(admin, "GET", "?limit=100000"))).contacts.length).toBeLessThanOrEqual(200);
  });

  it("GET /v1/contacts with a cursor from another sort is refused", async () => {
    const first = await data<Page>(await call(admin, "GET", listPath({ sort: "name", limit: 1 })));
    expect(first.next_cursor).toBeTruthy();
    const res = await call(admin, "GET", listPath({ sort: "spent", limit: 1, cursor: first.next_cursor }));
    expect(res.status).toBe(400);
    expect(await message(res)).toBe("Start the list again.");
    const junk = await call(admin, "GET", listPath({ sort: "name", cursor: "not-a-cursor" }));
    expect(junk.status).toBe(400);
    expect(await message(junk)).toBe("Start the list again.");
  });

  it("search finds a contact by 0803…, by 803…, by +234 803…, by part of an email and by @username", async () => {
    const id = await newCustomer({ name: "Searchable Person", phone: "0700 555 1100", email: "findme@search.test" });
    await db.insert(inboxIdentity).values({ customerId: id, channel: "instagram", accountExternalId: "178000000009", externalId: "IGSID-S", username: "search_juice" });
    await refreshContactSummary(db, [id]);
    for (const q of ["07005551100", "7005551100", "+234 700 555 1100", "findme@sea", "@search_juice", "SEARCHABLE per"]) {
      const page = await data<Page>(await call(admin, "GET", listPath({ filter: { q } })));
      expect(page.contacts.map((c) => c.id), q).toEqual([id]);
      expect(page.total, q).toBe(1);
    }
    const found = (await data<Page>(await call(admin, "GET", listPath({ filter: { q: "findme" } })))).contacts[0]!;
    expect(found).toMatchObject({ phone: "0700 555 1100", email: "findme@search.test", channels: ["instagram"], handles: ["@search_juice"], consent: "not_asked" });
    // One character is not a search.
    const short = await call(admin, "GET", listPath({ filter: { q: "a" } }));
    expect(short.status).toBe(422);
  });

  it("filters: channel, has phone, has email, has address, ordered in the last N days, never ordered, spent at least, label, source, consent, list", async () => {
    const label = await newLabel("Filter set");
    const rich = await newCustomer({ name: "Filter Rich", phone: "+2347005551200", email: "rich@filters.test", defaultAddress: "1 Filter Road", source: "online" });
    await order(rich, 60_000, daysAgo(10));
    const lapsed = await newCustomer({ name: "Filter Lapsed", phone: "+2347005551201", source: "whatsapp" });
    await order(lapsed, 5_000, daysAgo(300));
    const never = await newCustomer({ name: "Filter Never", email: "never@filters.test", source: "walkup_anonymous" });
    await db.insert(inboxIdentity).values({ customerId: never, channel: "messenger", accountExternalId: "100200300409", externalId: "PSID-F" });
    await refreshContactSummary(db, [never]);
    const all = [rich, lapsed, never];
    await call(admin, "POST", "/bulk/labels", { customer_ids: all, add: [label] });
    await db.transaction((tx) => recordConsent(tx, rich, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff" }));
    await db.transaction((tx) => recordConsent(tx, lapsed, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));
    const list = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Filter list", kind: "static", customer_ids: [lapsed, never] }));

    const within = async (f: ContactFilter) => {
      const res = await call(admin, "GET", listPath({ filter: { ...f, label_ids: [label] }, limit: 50 }));
      expect(res.status).toBe(200);
      return (await data<Page>(res)).contacts.map((c) => c.id).sort();
    };
    const ids = (...x: string[]) => [...x].sort();
    expect(await within({})).toEqual(ids(...all));
    expect(await within({ channels: ["messenger"] })).toEqual(ids(never));
    expect(await within({ has_phone: true })).toEqual(ids(rich, lapsed));
    expect(await within({ has_email: true })).toEqual(ids(rich, never));
    expect(await within({ has_address: true })).toEqual(ids(rich));
    expect(await within({ ordered_within_days: 60 })).toEqual(ids(rich));
    expect(await within({ never_ordered: true })).toEqual(ids(never));
    expect(await within({ min_spent_ngn: 50_000 })).toEqual(ids(rich));
    expect(await within({ sources: ["whatsapp"] })).toEqual(ids(lapsed));
    expect(await within({ consent: "agreed" })).toEqual(ids(rich));
    expect(await within({ consent: "stopped" })).toEqual(ids(lapsed));
    expect(await within({ consent: "not_asked" })).toEqual(ids(never));
    expect(await within({ list_id: list.id })).toEqual(ids(lapsed, never));

    // Filters that cannot be used together, an unknown key, bad JSON, and a smart list's id.
    const clash = await call(admin, "GET", listPath({ filter: { never_ordered: true, min_spent_ngn: 1000 } }));
    expect(clash.status).toBe(422);
    expect(await message(clash)).toBe("Those filters can't be used together.");
    expect((await call(admin, "GET", `?filter=${encodeURIComponent('{"shoe_size":9}')}`)).status).toBe(422);
    expect((await call(admin, "GET", `?filter=${encodeURIComponent("{not json")}`)).status).toBe(422);
    const smart = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Filter smart", kind: "smart", filter: { never_ordered: true } }));
    expect((await call(admin, "GET", listPath({ filter: { list_id: smart.id } }))).status).toBe(422);
  });

  // ── One contact ────────────────────────────────────────────────────────────

  it("GET /v1/contacts/:id returns orders summary, lists, labels and consent; conversations only within the viewer's scope; none without inbox.view", async () => {
    const id = await newCustomer({ name: "Detail Person", phone: "+2347005551300", email: "detail@example.test", notes: "likes zobo" });
    await order(id, 9_000, daysAgo(50));
    await order(id, 11_000, daysAgo(4));
    await order(id, 99_000, daysAgo(2), "cancelled");
    await db.insert(inboxIdentity).values({ customerId: id, channel: "whatsapp", accountExternalId: "global", externalId: "2347005551300", displayName: "Detail" });
    await db.insert(inboxConversation).values({ customerId: id, phoneNumberId: lineId, status: "open", labels: ["lead"], lastActivityAt: daysAgo(1) });
    await refreshContactSummary(db, [id]);
    const label = await newLabel("Detail label");
    expect((await call(admin, "PUT", `/${id}/labels`, { label_ids: [label] })).status).toBe(200);
    const fixed = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Detail fixed list", kind: "static", customer_ids: [id] }));
    const smart = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Detail smart list", kind: "smart", filter: { min_orders: 2 } }));
    await db.transaction((tx) => recordConsent(tx, id, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff", wording: "Yes to offers", recordedBy: adminId }));

    const res = await call(owner, "GET", `/${id}`);
    expect(res.status).toBe(200);
    const d = await data<ContactDetail>(res);
    expect(d).toMatchObject({
      id,
      name: "Detail Person",
      phone: "+2347005551300",
      notes: "likes zobo",
      channels: ["whatsapp"],
      consent: "agreed",
      orders_count: 2,
      spent_ngn: 20_000,
      can_see_conversations: true,
      conversation_labels: ["lead"],
      origin: null,
    });
    expect(d.orders).toMatchObject({ count: 2, spent_ngn: 20_000, first_at: daysAgo(50).toISOString(), last_at: daysAgo(4).toISOString() });
    // The latest five show every status, so nothing is hidden.
    expect(d.orders.recent.map((o) => o.status)).toEqual(["cancelled", "paid", "paid"]);
    expect(d.labels.map((l) => l.name)).toEqual(["Detail label"]);
    expect(d.lists.map((l) => `${l.name}:${l.kind}`).sort()).toEqual(["Detail fixed list:static", "Detail smart list:smart"]);
    expect(d.consent_now).toEqual([expect.objectContaining({ channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff", recorded_by_name: "admin@example.com" })]);
    expect(d.conversations).toHaveLength(1);
    expect(d.conversations[0]).toMatchObject({ channel: "whatsapp", number_label: "Main line", status: "open" });
    expect(d.identities.map((i) => i.channel)).toEqual(["whatsapp"]);
    // The address of the shop admin comes from the server's own setting.
    expect(d.shop_profile_url).toBe(`${process.env.PUBLIC_ADMIN_URL!.replace(/\/+$/, "")}/owner/customers/${id}`);
    expect(fixed.count).toBe(1);
    expect(smart.kind).toBe("smart");

    // Without inbox.view: the contact, and no conversation content at all.
    const blind = await data<ContactDetail>(await call(viewOnly, "GET", `/${id}`));
    expect(blind.name).toBe("Detail Person");
    expect(blind.conversations).toEqual([]);
    expect(blind.conversation_labels).toEqual([]);
    expect(blind.can_see_conversations).toBe(false);
    // With inbox.view but no access to that line: none either (the inbox's one visibility rule).
    const scoped = await data<ContactDetail>(await call(agent, "GET", `/${id}`));
    expect(scoped.can_see_conversations).toBe(true);
    expect(scoped.conversations).toEqual([]);

    expect((await call(staff, "GET", `/${id}`)).status).toBe(403);
    expect((await call(owner, "GET", `/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call(owner, "GET", "/not-an-id")).status).toBe(404);
    const deleted = await newCustomer({ name: "Deleted Person", deletedAt: NOW });
    expect((await call(owner, "GET", `/${deleted}`)).status).toBe(404);

    // History: the consent record with its wording.
    const history = await data<{ consent: { wording: string | null; is_current: boolean }[]; edits: unknown[] }>(await call(manager, "GET", `/${id}/history`));
    expect(history.consent).toEqual([expect.objectContaining({ wording: "Yes to offers", is_current: true })]);
  });

  it("PATCH /v1/contacts/:id changes name, email, address and notes, audits before and after, and refuses phone", async () => {
    const id = await newCustomer({ name: "Before Name", phone: "+2347005551400", email: "before@example.test", defaultAddress: "1 Before Road", notes: "before" });
    const res = await call(admin, "PATCH", `/${id}`, { name: "  After Name ", email: " After@Example.TEST ", address: "2 After Road", notes: "after" });
    expect(res.status).toBe(200);
    const d = await data<ContactDetail>(res);
    expect(d).toMatchObject({ name: "After Name", email: "after@example.test", address: "2 After Road", address_source: "saved", notes: "after", phone: "+2347005551400" });
    const [row] = await db.select().from(customer).where(eq(customer.id, id));
    expect(row).toMatchObject({ name: "After Name", email: "after@example.test", defaultAddress: "2 After Road", notes: "after", phone: "+2347005551400" });

    const audits = await auditRows("contacts.update", id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.beforeJson).toEqual({ name: "Before Name", email: "before@example.test", address: "1 Before Road", notes: "before" });
    expect(audits[0]!.afterJson).toEqual({ name: "After Name", email: "after@example.test", address: "2 After Road", notes: "after" });
    expect(audits[0]!.actorUserId).toBe(adminId);

    // Only what changed is audited; a body that changes nothing writes no audit row.
    expect((await call(admin, "PATCH", `/${id}`, { name: "After Name", notes: "after again" })).status).toBe(200);
    const second = await auditRows("contacts.update", id);
    expect(second).toHaveLength(2);
    expect(second[1]!.beforeJson).toEqual({ notes: "after" });
    expect(second[1]!.afterJson).toEqual({ notes: "after again" });
    expect((await call(admin, "PATCH", `/${id}`, { name: "After Name" })).status).toBe(200);
    expect(await auditRows("contacts.update", id)).toHaveLength(2);

    // A blank address clears the saved one; a blank email clears it.
    const cleared = await data<ContactDetail>(await call(admin, "PATCH", `/${id}`, { address: "  ", email: null }));
    expect(cleared).toMatchObject({ address: null, address_source: null, email: null, saved_address: null });

    // The phone number cannot be changed here, in any spelling.
    for (const body of [{ phone: "+2347005551499" }, { name: "X", phone: "07005551499" }, { source: "online" }, { id: crypto.randomUUID() }]) {
      expect((await call(admin, "PATCH", `/${id}`, body)).status).toBe(400);
    }
    expect((await db.select().from(customer).where(eq(customer.id, id)))[0]!.phone).toBe("+2347005551400");

    const noName = await call(admin, "PATCH", `/${id}`, { name: "   " });
    expect(noName.status).toBe(422);
    expect(await message(noName)).toBe("Enter a name.");
    const badEmail = await call(admin, "PATCH", `/${id}`, { email: "not an email" });
    expect(badEmail.status).toBe(422);
    expect(await message(badEmail)).toBe("That email doesn't look right.");

    // The Changes card: who changed what.
    const history = await data<{ edits: { by_name: string; action: string; changed: string[] }[] }>(await call(manager, "GET", `/${id}/history`));
    expect(history.edits.at(-1)).toMatchObject({ by_name: "admin@example.com", action: "contacts.update", changed: ["name", "email", "address", "notes"] });

    // A merged-away record and a deleted customer cannot be edited.
    const kept = await newCustomer({ name: "Kept" });
    const alias = await newCustomer({ name: "Alias" });
    await db.insert(contactAlias).values({ customerId: alias, intoCustomerId: kept });
    expect((await call(admin, "PATCH", `/${alias}`, { name: "Nope" })).status).toBe(404);
    expect(await data<{ merged_into: string }>(await call(admin, "GET", `/${alias}`))).toEqual({ merged_into: kept });
    const deleted = await newCustomer({ name: "Deleted", deletedAt: NOW });
    expect((await call(admin, "PATCH", `/${deleted}`, { name: "Nope" })).status).toBe(404);
    expect((await db.select().from(customer).where(eq(customer.id, alias)))[0]!.name).toBe("Alias");
  });

  it("PATCH needs contacts.manage", async () => {
    const id = await newCustomer({ name: "Not Yours" });
    for (const cookie of [manager, viewOnly, staff]) {
      expect((await call(cookie, "PATCH", `/${id}`, { name: "Changed" })).status).toBe(403);
    }
    expect((await db.select().from(customer).where(eq(customer.id, id)))[0]!.name).toBe("Not Yours");
    // The same goes for every other write.
    for (const [method, path, body] of [
      ["POST", "", { name: "X", phone: "07005551490", customer_source: "phone" }],
      ["POST", "/labels", { name: "X" }],
      ["POST", "/lists", { name: "X", kind: "static" }],
      ["POST", "/imports", { filename: "x.csv", csv_text: "Phone\n07005551491" }],
      ["PUT", "/settings", { stop_confirmation: false, stop_text: "x", start_text: "y" }],
      ["POST", `/${id}/consent`, { channel: "whatsapp", purpose: "marketing", state: "withdrawn" }],
      ["PUT", `/${id}/labels`, { label_ids: [] }],
    ] as const) {
      expect((await call(manager, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
  });

  it("POST /v1/contacts creates a contact with an origin row; the same number again returns the existing contact unchanged", async () => {
    const res = await call(admin, "POST", "", {
      name: "Hand Added",
      phone: "0700 555 1500",
      email: "Hand@Example.test",
      address: "5 Hand Road",
      notes: "met at the fair",
      customer_source: "walkup_anonymous",
      source_label: "order book",
      consent: { wording: "Yes, send me offers on WhatsApp", collected_on: "2026-11-10", method_note: "said at the counter" },
    });
    expect(res.status).toBe(201);
    const made = await data<{ id: string; created: boolean; consent_recorded: boolean }>(res);
    expect(made).toMatchObject({ created: true, consent_recorded: true });
    const [row] = await db.select().from(customer).where(eq(customer.id, made.id));
    expect(row).toMatchObject({ name: "Hand Added", phone: "+2347005551500", email: "hand@example.test", defaultAddress: "5 Hand Road", notes: "met at the fair", source: "walkup_anonymous" });
    const [origin] = await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, made.id));
    expect(origin).toMatchObject({ origin: "manual", sourceLabel: "order book", createdBy: adminId });
    // We do not know the number is on WhatsApp: no identity is written.
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, made.id))).toHaveLength(0);
    const [consent] = await db.select().from(contactConsent).where(eq(contactConsent.customerId, made.id));
    expect(consent).toMatchObject({ state: "granted", method: "staff", wording: "Yes, send me offers on WhatsApp", collectedOn: "2026-11-10", recordedBy: adminId, confirmState: "none" });
    const d = await data<ContactDetail>(await call(admin, "GET", `/${made.id}`));
    expect(d).toMatchObject({ source: "manual", consent: "agreed", origin: { origin: "manual", source_label: "order book", created_by_name: "admin@example.com" } });
    expect(await auditRows("contacts.create", made.id)).toHaveLength(1);

    // The same number typed another way: the existing contact, and nothing on it changes.
    const again = await call(admin, "POST", "", { name: "Someone Else", phone: "+234 700 555 1500", address: "9 Other Road", customer_source: "phone" });
    expect(again.status).toBe(200);
    expect(await data<Record<string, unknown>>(again)).toMatchObject({ id: made.id, created: false, matched_by: "phone", name: "Hand Added" });
    const [after] = await db.select().from(customer).where(eq(customer.id, made.id));
    expect(after).toEqual(row);
    // Nothing changed, so nothing new is written to the audit log for them.
    expect(await auditRows("contacts.create", made.id)).toHaveLength(1);

    // A yes typed into this form never lifts a stop.
    await db.transaction((tx) => recordConsent(tx, made.id, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));
    const yes = await call(admin, "POST", "", { phone: "07005551500", customer_source: "phone", consent: { wording: "They said yes" } });
    expect(await data<Record<string, unknown>>(yes)).toMatchObject({ created: false, consent_recorded: false, stopped: true });
    expect((await data<ContactDetail>(await call(admin, "GET", `/${made.id}`))).consent).toBe("stopped");
  });

  it("POST /v1/contacts with an unusable phone is refused in plain words", async () => {
    const before = (await db.select({ id: customer.id }).from(customer)).length;
    const bad = await call(admin, "POST", "", { name: "Bad Phone", phone: "12345", customer_source: "phone" });
    expect(bad.status).toBe(422);
    expect(await message(bad)).toBe("That phone number doesn't look right. Use a number like 0803 123 4567.");
    const none = await call(admin, "POST", "", { name: "Nothing To Reach", customer_source: "phone" });
    expect(none.status).toBe(422);
    expect(await message(none)).toBe("Add a phone number or an email.");
    const email = await call(admin, "POST", "", { email: "nope", customer_source: "phone" });
    expect(email.status).toBe(422);
    expect(await message(email)).toBe("That email doesn't look right.");
    // customer_source gains no value: "manual" and "import" are not shop sources.
    expect((await call(admin, "POST", "", { phone: "07005551590", customer_source: "manual" })).status).toBe(400);
    expect((await db.select({ id: customer.id }).from(customer)).length).toBe(before);
  });

  // ── Labels and lists ───────────────────────────────────────────────────────

  it("labels: create, rename, delete, set on a contact, bulk add and remove", async () => {
    const a = await newCustomer({ name: "Label A" });
    const b = await newCustomer({ name: "Label B" });
    const created = await call(admin, "POST", "/labels", { name: " Bulk buyer ", colour: "amber" });
    expect(created.status).toBe(201);
    const label = await data<{ id: string; name: string; colour: string }>(created);
    expect(label).toMatchObject({ name: "Bulk buyer", colour: "amber" });
    const dupe = await call(admin, "POST", "/labels", { name: "BULK BUYER" });
    expect(dupe.status).toBe(409);
    expect(await message(dupe)).toBe("A label with that name already exists.");
    expect((await call(admin, "POST", "/labels", { name: "Bad colour", colour: "pink" })).status).toBe(400);

    expect((await call(admin, "PATCH", `/labels/${label.id}`, { name: "Events", colour: "blue" })).status).toBe(200);
    const second = await newLabel("Staff family");
    expect((await call(admin, "PATCH", `/labels/${second}`, { name: "events" })).status).toBe(409);

    // Set on one contact (replaces the set), then bulk.
    const set = await call(admin, "PUT", `/${a}/labels`, { label_ids: [label.id, second] });
    expect((await data<{ name: string }[]>(set)).map((l) => l.name)).toEqual(["Events", "Staff family"]);
    expect((await data<{ name: string }[]>(await call(admin, "PUT", `/${a}/labels`, { label_ids: [second] }))).map((l) => l.name)).toEqual(["Staff family"]);
    expect((await call(admin, "PUT", `/${a}/labels`, { label_ids: [crypto.randomUUID()] })).status).toBe(422);

    const bulk = await data<{ changed: number }>(await call(admin, "POST", "/bulk/labels", { customer_ids: [a, b], add: [label.id], remove: [second] }));
    expect(bulk.changed).toBe(3); // two added, one removed
    expect((await db.select().from(contactLabelMember).where(eq(contactLabelMember.labelId, label.id))).map((m) => m.customerId).sort()).toEqual([a, b].sort());
    const listed = await data<{ id: string; name: string; contacts: number }[]>(await call(manager, "GET", "/labels"));
    expect(listed.find((l) => l.id === label.id)).toMatchObject({ name: "Events", contacts: 2 });

    const noConfirm = await call(admin, "DELETE", `/labels/${label.id}`, {});
    expect(noConfirm.status).toBe(400);
    const gone = await call(admin, "DELETE", `/labels/${label.id}`, { confirm: true });
    expect(await data<{ removed_from: number }>(gone)).toEqual({ removed_from: 2 });
    expect(await db.select().from(contactLabelMember).where(eq(contactLabelMember.labelId, label.id))).toHaveLength(0);
    // The contacts themselves are untouched.
    expect(await db.select().from(customer).where(eq(customer.id, a))).toHaveLength(1);
    for (const action of ["contacts.label_create", "contacts.label_update", "contacts.label_delete", "contacts.bulk_labels", "contacts.labels"]) {
      expect((await auditRows(action)).length, action).toBeGreaterThan(0);
    }
  });

  it("lists: a static list adds and removes members and counts them; a smart list follows its filter as orders arrive", async () => {
    const a = await newCustomer({ name: "List A", phone: "+2347005551600" });
    const b = await newCustomer({ name: "List B", phone: "+2347005551601" });
    const c2 = await newCustomer({ name: "List C" });
    const made = await call(admin, "POST", "/lists", { name: "Test list", kind: "static", description: "for a test", customer_ids: [a] });
    expect(made.status).toBe(201);
    const list = await data<ContactListView>(made);
    expect(list).toMatchObject({ name: "Test list", kind: "static", count: 1, created_by_name: "admin@example.com" });
    expect((await call(admin, "POST", "/lists", { name: " test LIST ", kind: "static" })).status).toBe(409);

    const added = await data<{ added: number; already: number }>(await call(admin, "POST", `/lists/${list.id}/members`, { customer_ids: [a, b, crypto.randomUUID()] }));
    expect(added).toEqual({ added: 1, already: 1 });
    // "Select all that match" sends the filter, not ids.
    const byFilter = await data<{ added: number; already: number }>(await call(admin, "POST", `/lists/${list.id}/members`, { filter: { q: "List C" } }));
    expect(byFilter).toEqual({ added: 1, already: 0 });
    expect((await data<ContactListView>(await call(manager, "GET", `/lists/${list.id}`))).count).toBe(3);
    const removed = await data<{ removed: number }>(await call(admin, "DELETE", `/lists/${list.id}/members`, { customer_ids: [b] }));
    expect(removed).toEqual({ removed: 1 });
    expect((await db.select().from(contactListMember).where(eq(contactListMember.listId, list.id))).map((m) => m.customerId).sort()).toEqual([a, c2].sort());
    // A member whose customer is deleted in the shop no longer counts, and nothing was deleted here.
    await db.update(customer).set({ deletedAt: NOW }).where(eq(customer.id, c2));
    await refreshContactSummary(db, [c2]);
    expect((await data<ContactListView>(await call(manager, "GET", `/lists/${list.id}`))).count).toBe(1);

    // A smart list: nobody is stored; the count follows the filter.
    const label = await newLabel("Smart list set");
    await call(admin, "POST", "/bulk/labels", { customer_ids: [a, b], add: [label] });
    const smartRes = await call(admin, "POST", "/lists", { name: "Never ordered (test)", kind: "smart", filter: { never_ordered: true, label_ids: [label] } });
    expect(smartRes.status).toBe(201);
    const smart = await data<ContactListView>(smartRes);
    expect(smart).toMatchObject({ kind: "smart", count: 2 });
    expect(smart.filter_lines).toEqual(["Never ordered", "Label: Smart list set"]);
    expect(await db.select().from(contactListMember).where(eq(contactListMember.listId, smart.id))).toHaveLength(0);
    await order(a, 3_000, daysAgo(1));
    expect((await data<ContactListView>(await call(manager, "GET", `/lists/${smart.id}`))).count).toBe(1);
    const lists = await data<ContactListView[]>(await call(manager, "GET", "/lists"));
    expect(lists.find((l) => l.id === smart.id)).toMatchObject({ count: 1, kind: "smart" });

    // Rules are checked: a search term or another list cannot be saved in a smart list.
    const withSearch = await call(admin, "POST", "/lists", { name: "Bad smart", kind: "smart", filter: { q: "ada" } });
    expect(withSearch.status).toBe(422);
    expect(await message(withSearch)).toBe("Clear the search box first. A list that keeps itself up to date can only use filters.");
    expect((await call(admin, "POST", "/lists", { name: "Bad smart 2", kind: "smart" })).status).toBe(422);
    expect((await call(admin, "PATCH", `/lists/${smart.id}`, { filter: { has_phone: true } })).status).toBe(200);
    expect((await call(admin, "PATCH", `/lists/${list.id}`, { filter: { has_phone: true } })).status).toBe(422);

    // Archiving hides a list from pickers; nothing is deleted, and the name is free again.
    expect((await call(admin, "PATCH", `/lists/${list.id}`, { archived: true })).status).toBe(200);
    expect((await data<ContactListView[]>(await call(manager, "GET", "/lists"))).some((l) => l.id === list.id)).toBe(false);
    expect((await data<ContactListView[]>(await call(manager, "GET", "/lists?include_archived=true"))).some((l) => l.id === list.id)).toBe(true);
    expect(await db.select().from(contactListMember).where(eq(contactListMember.listId, list.id))).toHaveLength(2);
    expect((await call(admin, "POST", "/lists", { name: "Test list", kind: "static" })).status).toBe(201);
  });

  it("adding members to a smart list is refused", async () => {
    const id = await newCustomer({ name: "Smart Refused" });
    const smart = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Smart refuses members", kind: "smart", filter: { has_email: true } }));
    const add = await call(admin, "POST", `/lists/${smart.id}/members`, { customer_ids: [id] });
    expect(add.status).toBe(409);
    expect(await message(add)).toBe("This list fills itself from its rules. Change the rules instead.");
    expect((await call(admin, "DELETE", `/lists/${smart.id}/members`, { customer_ids: [id] })).status).toBe(409);
    expect((await call(admin, "POST", "/lists", { name: "Smart with people", kind: "smart", filter: { has_email: true }, customer_ids: [id] })).status).toBe(422);
  });

  it("export.csv needs inbox.export, audits the row count, escapes formula cells, and alerts the owner above 500 rows", async () => {
    const label = await newLabel("Export set");
    const formula = await newCustomer({ name: "=HYPERLINK(\"http://example.test\")", phone: "+2347005551700", email: "+plus@example.test", defaultAddress: "-1 Minus Road", source: "online" });
    const plain = await newCustomer({ name: "Plain, Person", phone: "+2347005551701", notes: "@not exported" });
    await order(plain, 4_500, new Date("2026-11-18T23:30:00Z")); // 00:30 on the 19th in Lagos
    await call(admin, "POST", "/bulk/labels", { customer_ids: [formula, plain], add: [label] });

    // A manager may look at contacts but may not download them.
    expect((await call(manager, "GET", `/export.csv?filter=${encodeURIComponent(JSON.stringify({ label_ids: [label] }))}`)).status).toBe(403);
    expect((await call(staff, "GET", "/export.csv")).status).toBe(403);

    const alertsBefore = (await db.select().from(outboxEvent).where(sql`${outboxEvent.payload}->>'action' = 'contacts.export'`)).length;
    const res = await call(admin, "GET", `/export.csv?filter=${encodeURIComponent(JSON.stringify({ label_ids: [label] }))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("Name,Phone,Email,Address,Reaches us by,Came from,Orders,Total spent (NGN),Last order,Last contact,Labels,Promotions on WhatsApp");
    expect(lines).toHaveLength(3);
    // A spreadsheet must never run a cell as a formula: = + - and @ get a leading apostrophe.
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://example.test"")",'+2347005551700,'+plus@example.test,'-1 Minus Road,,Website,0,0,,,Export set,Not asked yet`);
    expect(lines[2]).toBe(`"Plain, Person",'+2347005551701,,,,Website,1,4500,2026-11-19,,Export set,Not asked yet`);
    const audits = await auditRows("contacts.export");
    expect(audits.at(-1)!.afterJson).toMatchObject({ rows: 2, filter: { label_ids: [label] } });
    expect(audits.at(-1)!.actorUserId).toBe(adminId);
    // A small download does not ping the owner.
    expect((await db.select().from(outboxEvent).where(sql`${outboxEvent.payload}->>'action' = 'contacts.export'`)).length).toBe(alertsBefore);

    // By list.
    const list = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Export list", kind: "static", customer_ids: [plain] }));
    const byList = await call(owner, "GET", `/export.csv?list_id=${list.id}`);
    expect((await byList.text()).trim().split("\r\n")).toHaveLength(2);
    expect((await auditRows("contacts.export")).at(-1)!.afterJson).toMatchObject({ rows: 1, list: "Export list" });

    // More than 500 rows: still allowed, and the owner is told.
    await db.execute(sql`
      INSERT INTO customer (name, phone, source)
      SELECT 'Bulk Export ' || g, '+23470055' || lpad((20000 + g)::text, 5, '0'), 'online' FROM generate_series(1, 501) g
    `);
    await rebuildAllSummaries(db);
    const big = await call(admin, "GET", `/export.csv?filter=${encodeURIComponent(JSON.stringify({ q: "Bulk Export" }))}`);
    expect(big.status).toBe(200);
    expect((await big.text()).trim().split("\r\n")).toHaveLength(502);
    expect((await auditRows("contacts.export")).at(-1)!.afterJson).toMatchObject({ rows: 501 });
    const alerts = await db.select().from(outboxEvent).where(sql`${outboxEvent.payload}->>'action' = 'contacts.export'`);
    expect(alerts.length).toBe(alertsBefore + 1);
    expect(alerts.at(-1)!.eventType).toBe("audit.logged");
  });

  // ── Import ─────────────────────────────────────────────────────────────────

  it("import: upload refuses more than 5,000 rows and duplicate column names", async () => {
    const tooMany = `Name,Phone\n${Array.from({ length: 5001 }, (_, i) => `Row ${i},0700555${String(i).padStart(4, "0")}`).join("\n")}`;
    const big = await upload(admin, tooMany);
    expect(big.status).toBe(422);
    expect(await message(big)).toBe("This file has more than 5,000 rows. Split it into smaller files.");
    const dupe = await upload(admin, "Name,Phone,phone\nAda,07005551800,07005551801");
    expect(dupe.status).toBe(422);
    expect(await message(dupe)).toBe("Two columns are both called “phone”. Rename one.");
    const empty = await upload(admin, "");
    expect(empty.status).toBe(422);
    expect(await message(empty)).toBe("This file is empty.");
    expect((await upload(admin, "Name,Phone\n ,\n")).status).toBe(422);
    const wide = await upload(admin, `${Array.from({ length: 41 }, (_, i) => `Col${i}`).join(",")}\n${"x,".repeat(40)}x`);
    expect(wide.status).toBe(422);
    expect(await db.select().from(contactImport)).toHaveLength(0);

    // A good file: rows whose cells are all blank are dropped and not counted.
    const ok = await upload(admin, "﻿Full Name,Phone Number,E-mail\r\nAda Test,0700 555 1810,ada@upload.test\r\n,,\r\nBola Test,07005551811,\r\n");
    expect(ok.status).toBe(201);
    const up = await data<{ id: string; headers: string[]; total_rows: number; sample: string[][]; suggested_mapping: Record<string, string> }>(ok);
    expect(up).toMatchObject({
      headers: ["Full Name", "Phone Number", "E-mail"],
      total_rows: 2,
      suggested_mapping: { name: "Full Name", phone: "Phone Number", email: "E-mail" },
    });
    expect(up.sample[0]).toEqual(["Ada Test", "0700 555 1810", "ada@upload.test"]);
    expect(await db.select().from(contactImportRow).where(eq(contactImportRow.importId, up.id))).toHaveLength(2);

    // Only the person who uploaded it, or the owner, may look at it or act on it.
    await seedUser(db, { email: "admin2@example.com", role: "admin" });
    const admin2 = await loginAs(baseUrl, "admin2@example.com", "userpassword123");
    expect((await call(admin2, "GET", `/imports/${up.id}`)).status).toBe(403);
    expect((await call(admin2, "POST", `/imports/${up.id}/cancel`)).status).toBe(403);
    expect((await call(owner, "GET", `/imports/${up.id}`)).status).toBe(200);
    expect(await data<{ cancelled: boolean }>(await call(admin, "POST", `/imports/${up.id}/cancel`))).toEqual({ cancelled: true });
    expect((await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: up.suggested_mapping })).status).toBe(409);
  });

  it("import preview: new, matched and rejected rows with reasons; nothing is written to customer", async () => {
    const existing = await newCustomer({ name: "Existing Name", phone: "0700 555 1900", email: "existing@import.test" });
    const emailOnly = await newCustomer({ name: "Email Only", email: "emailonly@import.test" });
    const stopped = await newCustomer({ name: "Stopped Person", phone: "+2347005551901" });
    await db.transaction((tx) => recordConsent(tx, stopped, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));
    const snapshot = async () =>
      (await db.execute(sql`SELECT count(*)::int AS n, coalesce(max(updated_at)::text, '') AS last FROM customer`)) as unknown as { n: number; last: string }[];
    const before = await snapshot();

    const csv = [
      "Name,Phone,Email,Address",
      "New One,0700 555 1910,new1@import.test,1 Import Road", // new
      "Different Name In File,+234 700 555 1900,,", // matched by phone
      ",,emailonly@import.test,", // matched by email (no phone)
      "No Contact,,,", // rejected: no phone or email
      "Bad Phone,12345,,", // rejected: bad phone
      "Bad Email,,not-an-email,", // rejected: bad email
      "Bad Email Kept,07005551911,not-an-email,", // new, email dropped with a warning
      "Same Email New Phone,07005551912,existing@import.test,", // new, with a duplicate warning
      "Stopped Again,07005551901,,", // matched, flagged as stopped
    ].join("\n");
    const up = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv, "preview.csv"));
    const res = await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: up.suggested_mapping });
    expect(res.status).toBe(200);
    const p = await data<{ new: number; matched: number; rejected: number; rows: ImportRowView[]; reasons: { reason: string; count: number }[] }>(res);
    expect(p).toMatchObject({ new: 3, matched: 3, rejected: 3 });
    // Rejected rows come first.
    expect(p.rows.slice(0, 3).map((r) => r.outcome)).toEqual(["rejected", "rejected", "rejected"]);
    const row = (n: number) => p.rows.find((r) => r.row_no === n)!;
    expect(row(1)).toMatchObject({ outcome: "new", name: "New One", phone: "+2347005551910", email: "new1@import.test", reason: null });
    expect(row(2)).toMatchObject({ outcome: "matched", reason: "Already a contact", matched_name: "Existing Name" });
    expect(row(3)).toMatchObject({ outcome: "matched", matched_name: "Email Only", phone: null });
    expect(row(4)).toMatchObject({ outcome: "rejected", reason: "No phone number or email", reason_code: "no_contact" });
    expect(row(5)).toMatchObject({ outcome: "rejected", reason: "The phone number doesn't look right: “12345”" });
    expect(row(6)).toMatchObject({ outcome: "rejected", reason: "The email doesn't look right: “not-an-email”" });
    expect(row(7)).toMatchObject({ outcome: "new", email: null, reason: "The email doesn't look right and was left out: “not-an-email”" });
    expect(row(8)).toMatchObject({ outcome: "new", reason: "Same email as Existing Name, different phone number: check for a duplicate" });
    expect(row(9)).toMatchObject({ outcome: "matched", reason: "Already a contact. Asked us to stop promotions: consent will not be recorded" });
    expect(p.reasons.map((r) => `${r.reason}:${r.count}`).sort()).toEqual(["bad_email:1", "bad_phone:1", "no_contact:1"]);

    // A dry run: no customer was created or changed, and no origin or consent was written.
    expect(await snapshot()).toEqual(before);
    expect((await db.select().from(customer).where(eq(customer.id, existing)))[0]!.name).toBe("Existing Name");
    expect(emailOnly).toBeTruthy();
    const got = await data<{ status: string; new: number; rows: ImportRowView[] }>(await call(admin, "GET", `/imports/${up.id}?outcome=new&limit=2`));
    expect(got).toMatchObject({ status: "previewed", new: 3 });
    expect(got.rows.map((r) => r.row_no)).toEqual([1, 7]);

    // The column choice is checked.
    const noKey = await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: { name: "Name" } });
    expect(noKey.status).toBe(422);
    expect(await message(noKey)).toBe("Choose the column that holds the phone number or the email.");
    expect((await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: { phone: "No Such Column" } })).status).toBe(422);
    const noWording = await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, consent_declared: "marketing_whatsapp", mapping: up.suggested_mapping });
    expect(noWording.status).toBe(422);
    // customer_source gains no value.
    expect((await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, customer_source: "import", mapping: up.suggested_mapping })).status).toBe(400);
  });

  it("import preview: two rows with the same number, the second is rejected as a duplicate", async () => {
    const csv = ["Name,Phone,Email", "First,0700 555 2000,", "Second,+2347005552000,", "Third,,twin@import.test", "Fourth,,TWIN@import.test", "Fifth,7005552000,"].join("\n");
    const up = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv));
    const p = await data<{ new: number; rejected: number; rows: ImportRowView[] }>(
      await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: up.suggested_mapping }),
    );
    expect(p).toMatchObject({ new: 2, rejected: 3 });
    const row = (n: number) => p.rows.find((r) => r.row_no === n)!;
    expect(row(1).outcome).toBe("new"); // the first such row is kept
    expect(row(2)).toMatchObject({ outcome: "rejected", reason: "Same phone number as row 1", reason_code: "duplicate_phone" });
    expect(row(3).outcome).toBe("new");
    expect(row(4)).toMatchObject({ outcome: "rejected", reason: "Same email as row 3" });
    expect(row(5)).toMatchObject({ outcome: "rejected", reason: "Same phone number as row 1" });
  });

  it("import apply: creates new contacts, leaves matched contacts unchanged, records origin and declared consent", async () => {
    const existing = await newCustomer({ name: "Keep My Name", phone: "+2347005552100", email: null, defaultAddress: null, notes: "shop note" });
    const [existingBefore] = await db.select().from(customer).where(eq(customer.id, existing));
    const label = await newLabel("Imported at the fair");
    const list = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Fair list", kind: "static" }));
    const csv = [
      "First,Last,Phone,Email,Address,Notes",
      "Import,New,0700 555 2110,inew@import.test,7 Fair Road,came to the fair",
      "A Different,Name,07005552100,file@import.test,File Address,file note",
      "Email,Only,,ionly@import.test,,",
    ].join("\n");
    const up = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv, "fair.csv"));
    expect(up.suggested_mapping).toMatchObject({ first_name: "First", last_name: "Last", phone: "Phone" });
    const options = {
      ...OPTIONS,
      mapping: up.suggested_mapping,
      consent_declared: "marketing_whatsapp",
      consent_method: "Ticked a box on the sign-up sheet",
      consent_wording: "Send me offers from Mrs. Samuel on WhatsApp",
      consent_collected_on: "2026-11-01",
      label_id: label,
      list_id: list.id,
    };
    const p = await data<{ new: number; matched: number; rejected: number }>(await call(admin, "POST", `/imports/${up.id}/preview`, options));
    expect(p).toEqual(expect.objectContaining({ new: 2, matched: 1, rejected: 0 }));

    // Confirming needs the tick and the numbers the person saw.
    expect((await call(admin, "POST", `/imports/${up.id}/apply`, { expect_new: 2, expect_matched: 1 })).status).toBe(400);
    const apply = await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 2, expect_matched: 1 });
    expect(apply.status).toBe(202);
    expect(await data<{ queued: boolean }>(apply)).toEqual({ queued: true });
    expect((await db.select().from(contactImport).where(eq(contactImport.id, up.id)))[0]!.status).toBe("applying");
    // The owner is told, and it cannot be started or cancelled a second time.
    const audits = await auditRows("contacts.import_apply", up.id);
    expect(audits[0]!.afterJson).toMatchObject({ new: 2, matched: 1, consent_declared: "marketing_whatsapp", filename: "fair.csv" });
    expect(await db.select().from(outboxEvent).where(sql`${outboxEvent.payload}->>'action' = 'contacts.import_apply' and ${outboxEvent.payload}->>'entity_id' = ${up.id}`)).toHaveLength(1);
    expect((await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 2, expect_matched: 1 })).status).toBe(409);
    expect((await call(admin, "POST", `/imports/${up.id}/cancel`)).status).toBe(409);

    await runImport(up.id); // what the worker does

    const [made] = await db.select().from(customer).where(eq(customer.phone, "+2347005552110"));
    expect(made).toMatchObject({ name: "Import New", email: "inew@import.test", defaultAddress: "7 Fair Road", notes: "came to the fair", source: "walkup_anonymous" });
    const [origin] = await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, made!.id));
    expect(origin).toMatchObject({ origin: "import", importId: up.id, sourceLabel: "event sign-up sheet", createdBy: adminId });
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, made!.id))).toHaveLength(0);
    const [consent] = await db.select().from(contactConsent).where(eq(contactConsent.customerId, made!.id));
    expect(consent).toMatchObject({
      state: "granted",
      method: "import",
      wording: "Send me offers from Mrs. Samuel on WhatsApp",
      note: "How they agreed: Ticked a box on the sign-up sheet",
      collectedOn: "2026-11-01",
      recordedBy: adminId,
      importId: up.id,
      isCurrent: true,
    });

    // The matched contact: not one field changed, although the file disagrees on name, email, address and notes.
    const [existingAfter] = await db.select().from(customer).where(eq(customer.id, existing));
    expect(existingAfter).toEqual(existingBefore);
    expect(await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, existing))).toHaveLength(0);
    // They were on the list of people who agreed, so the declared consent is recorded for them too.
    expect((await db.select().from(contactConsent).where(eq(contactConsent.customerId, existing)))[0]).toMatchObject({ state: "granted", method: "import" });

    // No phone: a contact, but no WhatsApp consent.
    const [emailOnly] = await db.select().from(customer).where(eq(customer.email, "ionly@import.test"));
    expect(emailOnly).toMatchObject({ name: "Email Only", phone: null });
    expect(await db.select().from(contactConsent).where(eq(contactConsent.customerId, emailOnly!.id))).toHaveLength(0);

    // Everyone is on the list and has the label, and shows on Contacts at once.
    const members = (await db.select().from(contactListMember).where(eq(contactListMember.listId, list.id))).map((m) => m.customerId).sort();
    expect(members).toEqual([made!.id, existing, emailOnly!.id].sort());
    expect(await db.select().from(contactLabelMember).where(eq(contactLabelMember.labelId, label))).toHaveLength(3);
    const page = await data<Page>(await call(admin, "GET", listPath({ filter: { sources: ["import"], label_ids: [label] } })));
    expect(page.contacts.map((c) => c.id).sort()).toEqual([made!.id, emailOnly!.id].sort());
    expect(page.contacts.find((c) => c.id === made!.id)).toMatchObject({ source: "import", consent: "agreed" });
    const got = await data<{ status: string; applied_rows: number }>(await call(admin, "GET", `/imports/${up.id}`));
    expect(got).toMatchObject({ status: "applied", applied_rows: 3 });
  });

  it("import apply with fill_blanks fills only empty fields and records what it filled", async () => {
    const partly = await newCustomer({ name: "Has A Name", phone: "+2347005552200", email: null, defaultAddress: "  ", notes: "keep this note" });
    const full = await newCustomer({ name: "Full Record", phone: "+2347005552201", email: "full@import.test", defaultAddress: "1 Full Road" });
    const [fullBefore] = await db.select().from(customer).where(eq(customer.id, full));
    const csv = [
      "Name,Phone,Email,Address,Notes",
      "File Name,07005552200,filled@import.test,2 Filled Road,file note",
      "Other Name,07005552201,other@import.test,9 Other Road,other note",
    ].join("\n");
    const up = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv));
    await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, fill_blanks: true, mapping: up.suggested_mapping });
    expect((await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 0, expect_matched: 2 })).status).toBe(202);
    await runImport(up.id);

    const [after] = await db.select().from(customer).where(eq(customer.id, partly));
    // Empty email and address are filled; the name, the phone, the notes and the source are never touched.
    expect(after).toMatchObject({ name: "Has A Name", phone: "+2347005552200", email: "filled@import.test", defaultAddress: "2 Filled Road", notes: "keep this note", source: "online" });
    const [fullAfter] = await db.select().from(customer).where(eq(customer.id, full));
    expect(fullAfter).toEqual(fullBefore);
    const rows = await db.select().from(contactImportRow).where(eq(contactImportRow.importId, up.id)).orderBy(contactImportRow.rowNo);
    expect(rows[0]!.filled).toEqual({ email: "filled@import.test", address: "2 Filled Road" });
    expect(rows[1]!.filled).toBeNull();
    // The change is audited with before and after, in the importer's name.
    const audits = await auditRows("contacts.import_fill", partly);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: adminId, beforeJson: { email: null, address: null } });
    expect(audits[0]!.afterJson).toMatchObject({ email: "filled@import.test", address: "2 Filled Road" });
    expect(await auditRows("contacts.import_fill", full)).toHaveLength(0);
  });

  it("import apply never records consent for a contact who asked us to stop", async () => {
    const stopped = await newCustomer({ name: "Said Stop", phone: "+2347005552300" });
    await db.transaction((tx) => recordConsent(tx, stopped, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));
    // A stop made under an earlier, now deleted, record of a number that the file brings back.
    const gone = await newCustomer({ name: "Deleted Record", phone: "0700 555 2301", deletedAt: daysAgo(3) });
    await db.transaction((tx) => recordConsent(tx, gone, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));

    const csv = ["Name,Phone", "Said Stop,07005552300", "Back Again,07005552301", "Fresh Person,07005552302"].join("\n");
    const up = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv));
    const p = await data<{ new: number; matched: number; rows: ImportRowView[] }>(
      await call(admin, "POST", `/imports/${up.id}/preview`, {
        ...OPTIONS,
        mapping: up.suggested_mapping,
        consent_declared: "marketing_whatsapp",
        consent_method: "Paper form",
        consent_wording: "Offers on WhatsApp",
        consent_collected_on: "2026-11-02",
      }),
    );
    expect(p).toMatchObject({ new: 2, matched: 1 });
    expect(p.rows.find((r) => r.row_no === 1)!.reason).toContain("Asked us to stop promotions: consent will not be recorded");
    expect(p.rows.find((r) => r.row_no === 2)!.reason).toBe("Asked us to stop promotions: consent will not be recorded");
    await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 2, expect_matched: 1 });
    await runImport(up.id);

    const state = async (id: string) =>
      (await db.select().from(contactConsent).where(and(eq(contactConsent.customerId, id), eq(contactConsent.isCurrent, true)))).map((r) => `${r.state}:${r.method}`);
    expect(await state(stopped)).toEqual(["withdrawn:keyword"]);
    const [back] = await db.select().from(customer).where(eq(customer.phone, "+2347005552301"));
    expect(back!.id).not.toBe(gone);
    expect(await state(back!.id)).toEqual(["withdrawn:carried_over"]);
    const [fresh] = await db.select().from(customer).where(eq(customer.phone, "+2347005552302"));
    expect(await state(fresh!.id)).toEqual(["granted:import"]);
    // Nobody who stopped has any "granted" row from this import.
    expect(await db.select().from(contactConsent).where(and(eq(contactConsent.importId, up.id), eq(contactConsent.state, "granted")))).toHaveLength(1);
  });

  it("import apply twice (worker re-run) creates nothing twice", async () => {
    const csv = ["Name,Phone", "Twice One,07005552400", "Twice Two,07005552401", "Twice Three,07005552402"].join("\n");
    const up = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv));
    const list = await data<ContactListView>(await call(admin, "POST", "/lists", { name: "Twice list", kind: "static" }));
    await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: up.suggested_mapping, list_id: list.id });
    await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 3, expect_matched: 0 });

    // A first batch of two, a "crash", then two workers at once, then once more for luck.
    expect(await applyImportBatch(db, up.id, 2)).toEqual({ done: false, applied: 2 });
    const both = await Promise.all([applyImportBatch(db, up.id, 200), applyImportBatch(db, up.id, 200)]);
    expect(both.reduce((n, r) => n + r.applied, 0)).toBe(1);
    expect(await applyImportBatch(db, up.id, 200)).toEqual({ done: true, applied: 0 });

    for (const phone of ["+2347005552400", "+2347005552401", "+2347005552402"]) {
      expect(await db.select().from(customer).where(eq(customer.phone, phone)), phone).toHaveLength(1);
    }
    expect(await db.select().from(contactListMember).where(eq(contactListMember.listId, list.id))).toHaveLength(3);
    expect((await db.select().from(contactImport).where(eq(contactImport.id, up.id)))[0]!.appliedRows).toBe(3);

    // The same file uploaded and applied again: every row now matches, and nothing new is made.
    const again = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv));
    const p = await data<{ new: number; matched: number }>(await call(admin, "POST", `/imports/${again.id}/preview`, { ...OPTIONS, mapping: again.suggested_mapping }));
    expect(p).toMatchObject({ new: 0, matched: 3 });
    await call(admin, "POST", `/imports/${again.id}/apply`, { confirm: true, expect_new: 0, expect_matched: 3 });
    await runImport(again.id);
    expect(await db.select().from(customer).where(eq(customer.phone, "+2347005552400"))).toHaveLength(1);
  });

  it("import apply is refused when the counts no longer match the preview", async () => {
    const csv = ["Name,Phone", "Count One,07005552500", "Count Two,07005552501"].join("\n");
    const up = await data<{ id: string; suggested_mapping: Record<string, string> }>(await upload(admin, csv));
    // Not previewed yet.
    expect((await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 2, expect_matched: 0 })).status).toBe(409);
    await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: up.suggested_mapping });
    // Meanwhile one of them becomes a contact, and the file is checked again in another tab.
    await newCustomer({ name: "Already Here", phone: "+2347005552500" });
    await call(admin, "POST", `/imports/${up.id}/preview`, { ...OPTIONS, mapping: up.suggested_mapping });
    const stale = await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 2, expect_matched: 0 });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { message: string; details: { reason: string; new: number; matched: number } } };
    expect(body.error.message).toBe("The preview is out of date. Check it again.");
    expect(body.error.details).toMatchObject({ reason: "changed", new: 1, matched: 1 });
    expect((await db.select().from(contactImport).where(eq(contactImport.id, up.id)))[0]!.status).toBe("previewed");
    expect(await db.select().from(customer).where(eq(customer.phone, "+2347005552501"))).toHaveLength(0);
    expect((await call(admin, "POST", `/imports/${up.id}/apply`, { confirm: true, expect_new: 1, expect_matched: 1 })).status).toBe(202);
  });

  // ── Consent and settings ───────────────────────────────────────────────────

  it("POST /:id/consent: granted needs wording; lifting a stop is recorded with the staff member's name", async () => {
    const id = await newCustomer({ name: "Consent Person", phone: "+2347005552600" });
    const noWording = await call(admin, "POST", `/${id}/consent`, { channel: "whatsapp", purpose: "marketing", state: "granted" });
    expect(noWording.status).toBe(422);
    expect(await message(noWording)).toBe("Say what the customer agreed to.");
    expect((await call(admin, "POST", `/${id}/consent`, { channel: "carrier pigeon", purpose: "marketing", state: "granted", wording: "x" })).status).toBe(400);

    const yes = await call(admin, "POST", `/${id}/consent`, {
      channel: "whatsapp",
      purpose: "marketing",
      state: "granted",
      wording: "Yes, send me offers on WhatsApp",
      collected_on: "2026-11-12",
      note: "said at the counter",
    });
    expect(yes.status).toBe(200);
    expect((await data<{ changed: boolean; consent_now: { state: string; recorded_by_name: string }[] }>(yes)).consent_now).toEqual([
      expect.objectContaining({ state: "granted", method: "staff", recorded_by_name: "admin@example.com" }),
    ]);

    // The customer asks us to stop: staff record it (no wording needed).
    expect((await call(admin, "POST", `/${id}/consent`, { channel: "whatsapp", purpose: "marketing", state: "withdrawn" })).status).toBe(200);
    // Turning that back into "agreed" needs the person to say the customer asked for it.
    const blocked = await call(owner, "POST", `/${id}/consent`, { channel: "whatsapp", purpose: "marketing", state: "granted", wording: "They changed their mind" });
    expect(blocked.status).toBe(409);
    expect(await message(blocked)).toContain("This customer asked us to stop.");
    expect((await data<ContactDetail>(await call(admin, "GET", `/${id}`))).consent).toBe("stopped");
    const lifted = await call(owner, "POST", `/${id}/consent`, {
      channel: "whatsapp",
      purpose: "marketing",
      state: "granted",
      wording: "They asked for offers again",
      asked_again: true,
    });
    expect(lifted.status).toBe(200);

    const rows = await db.select().from(contactConsent).where(eq(contactConsent.customerId, id)).orderBy(contactConsent.recordedAt);
    expect(rows.map((r) => `${r.state}:${r.method}:${r.isCurrent}`)).toEqual(["granted:staff:false", "withdrawn:staff:false", "granted:staff:true"]);
    expect(rows[0]).toMatchObject({ recordedBy: adminId, collectedOn: "2026-11-12", note: "said at the counter" });
    expect(rows[2]).toMatchObject({ recordedBy: ownerId, wording: "They asked for offers again", collectedOn: "2026-11-19" });
    const history = await data<{ consent: { state: string; recorded_by_name: string; is_current: boolean }[] }>(await call(manager, "GET", `/${id}/history`));
    expect(history.consent[0]).toMatchObject({ state: "granted", recorded_by_name: "owner@example.com", is_current: true });
    const audits = await auditRows("contacts.consent", id);
    expect(audits).toHaveLength(3);
    expect(audits[2]!.afterJson).toMatchObject({ state: "granted", lifted_a_stop: true });
    expect(audits[2]!.beforeJson).toMatchObject({ state: "withdrawn" });
    // Other channels are recorded separately and are not disturbed.
    expect((await call(admin, "POST", `/${id}/consent`, { channel: "sms", purpose: "service", state: "granted", wording: "Order updates by SMS" })).status).toBe(200);
    expect((await data<ContactDetail>(await call(admin, "GET", `/${id}`))).consent_now).toHaveLength(2);
  });

  it("settings: anyone with contacts.view reads them; saving needs contacts.manage and is audited", async () => {
    const first = await data<{ stop_confirmation: boolean; stop_text: string; start_text: string }>(await call(manager, "GET", "/settings"));
    expect(first.stop_confirmation).toBe(true);
    expect(first.stop_text).toContain("Reply START if you change your mind.");
    const saved = await call(admin, "PUT", "/settings", { stop_confirmation: false, stop_text: "  You are off our promotions list.  ", start_text: "Welcome back." });
    expect(saved.status).toBe(200);
    expect(await data<Record<string, unknown>>(saved)).toEqual({ stop_confirmation: false, stop_text: "You are off our promotions list.", start_text: "Welcome back." });
    expect((await call(admin, "PUT", "/settings", { stop_confirmation: true, stop_text: "", start_text: "x" })).status).toBe(400);
    expect((await call(admin, "PUT", "/settings", { stop_confirmation: true, stop_text: "x".repeat(601), start_text: "x" })).status).toBe(400);
    const audits = await auditRows("contacts.settings");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.beforeJson).toMatchObject({ stop_confirmation: true });
    expect(await data<Record<string, unknown>>(await call(manager, "GET", "/settings"))).toMatchObject({ stop_confirmation: false });
  });
});
