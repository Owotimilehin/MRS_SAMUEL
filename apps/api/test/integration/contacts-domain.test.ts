import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  branch,
  contactAlias,
  contactConsent,
  contactLabel,
  contactLabelMember,
  contactList,
  contactListMember,
  contactOrigin,
  contactSummary,
  customer,
  inboxCall,
  inboxConversation,
  inboxIdentity,
  inboxPhoneNumber,
  saleOrder,
} from "@ms/db";
import {
  contactFilterSql,
  currentConsent,
  findOrCreateContact,
  findOrCreateCustomer,
  findOrCreateCustomerByIdentity,
  isStoppedOnWhatsApp,
  listMembersSql,
  matchCustomerForPhone,
  rebuildAllSummaries,
  recordConsent,
  refreshChangedSummaries,
  refreshContactSummary,
} from "@ms/domain";
import { toE164, type ContactFilter } from "@ms/shared";
import { setupTestDb } from "./helpers.js";

/**
 * The contacts domain functions against a real Postgres (suite spec 14, section 9:
 * the list written for packages/domain/src/contacts/contacts.test.ts lives here,
 * because the domain package has no database test set-up of its own).
 *
 * Every date is fixed; nothing depends on the wall clock. Phone numbers are in
 * the made-up range 0700 555 0xxx.
 */

const NOW = new Date("2026-11-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("contacts domain", () => {
  let container: StartedPostgreSqlContainer;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let branchId: string;
  let lineId: string;
  let orderSeq = 0;

  async function newCustomer(v: Partial<typeof customer.$inferInsert> = {}): Promise<string> {
    const [row] = await db.insert(customer).values({ source: "online", ...v }).returning({ id: customer.id });
    return row!.id;
  }

  async function order(
    customerId: string,
    totalNgn: number,
    at: Date,
    o: { status?: (typeof saleOrder.$inferInsert)["status"]; address?: string | null } = {},
  ): Promise<void> {
    await db.insert(saleOrder).values({
      orderNumber: `T-DOM-${++orderSeq}`,
      branchId,
      channel: "online",
      customerId,
      status: o.status ?? "paid",
      subtotalNgn: totalNgn,
      totalNgn,
      paymentMethod: "transfer",
      createdAtLocal: at,
      idempotencyKey: crypto.randomUUID(),
      deliveryAddressFormatted: o.address ?? null,
    });
  }

  async function summary(id: string) {
    const [row] = await db.select().from(contactSummary).where(eq(contactSummary.customerId, id));
    return row ?? null;
  }

  async function matching(f: ContactFilter): Promise<string[]> {
    const rows = (await db.execute(
      sql`SELECT s.customer_id FROM contact_summary s JOIN customer c ON c.id = s.customer_id WHERE ${contactFilterSql(f, NOW)}`,
    )) as unknown as { customer_id: string }[];
    return rows.map((r) => r.customer_id);
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    const [b] = await db.insert(branch).values({ name: "Test branch", code: "TDOM" }).returning();
    branchId = b!.id;
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2347005550999", label: "Main line", channels: "both", wabaId: "WABA-T", waPhoneNumberId: "555000999" })
      .returning();
    lineId = line!.id;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  // ── Matching ───────────────────────────────────────────────────────────────

  it("matchCustomerForPhone and findOrCreateCustomer pick the same customer for 0803…, 803… and +234803…", async () => {
    // The shop typed the number its own way; an older and a newer record share it.
    const older = await newCustomer({ name: "Older", phone: "0700 555 0101", createdAt: daysAgo(30) });
    await newCustomer({ name: "Newer", phone: "+2347005550101", createdAt: daysAgo(2) });

    for (const typed of ["07005550101", "7005550101", "+234 700 555 0101", "2347005550101"]) {
      const e164 = toE164(typed)!;
      expect(e164).toBe("+2347005550101");
      const matched = await db.transaction((tx) => matchCustomerForPhone(tx, e164));
      const inbox = await db.transaction((tx) => findOrCreateCustomer(tx, typed, { source: "phone" }));
      const contact = await db.transaction((tx) =>
        findOrCreateContact(tx, { phone: typed, customerSource: "phone", origin: "manual", createdBy: null }),
      );
      // The canonical form is tried first, so all three agree on the record that holds it.
      expect(inbox.created).toBe(false);
      expect(matched?.id).toBe(inbox.id);
      expect(contact).toMatchObject({ customerId: inbox.id, created: false, matchedBy: "phone" });
    }
    // With only the hand-typed record present, all three agree on that one too.
    const lone = await newCustomer({ name: "Lone", phone: "0700 555 0102" });
    const e164 = "+2347005550102";
    const matched = await db.transaction((tx) => matchCustomerForPhone(tx, e164));
    const inbox = await db.transaction((tx) => findOrCreateCustomer(tx, "7005550102", { source: "phone" }));
    expect(matched?.id).toBe(lone);
    expect(inbox.id).toBe(lone);
    expect(older).not.toBe(lone);
  });

  it("matchCustomerForPhone follows a WhatsApp identity first, as the inbox does after a merge", async () => {
    const byPhone = await newCustomer({ name: "Holds the phone", phone: "+2347005550103" });
    const kept = await newCustomer({ name: "Kept after a merge", phone: null });
    await db.insert(inboxIdentity).values({ customerId: kept, channel: "whatsapp", accountExternalId: "global", externalId: "2347005550103" });
    const matched = await db.transaction((tx) => matchCustomerForPhone(tx, "+2347005550103"));
    const inbox = await db.transaction((tx) => findOrCreateCustomer(tx, "07005550103", { source: "whatsapp" }));
    expect(matched?.id).toBe(kept);
    expect(inbox.id).toBe(kept);
    expect(byPhone).not.toBe(kept);
  });

  it("matchCustomerForPhone never writes: no customer and no identity for an unknown number", async () => {
    const customersBefore = (await db.select({ id: customer.id }).from(customer)).length;
    const identitiesBefore = (await db.select({ id: inboxIdentity.id }).from(inboxIdentity)).length;
    expect(await db.transaction((tx) => matchCustomerForPhone(tx, "+2347005550199"))).toBeNull();
    expect((await db.select({ id: customer.id }).from(customer)).length).toBe(customersBefore);
    expect((await db.select({ id: inboxIdentity.id }).from(inboxIdentity)).length).toBe(identitiesBefore);
  });

  it("findOrCreateContact returns an existing customer untouched and creates no identity", async () => {
    const id = await newCustomer({ name: "Shop Customer", phone: "+2347005550110", email: "shop@example.test", defaultAddress: "1 Test Road", notes: "likes mango" });
    const [before] = await db.select().from(customer).where(eq(customer.id, id));
    const found = await db.transaction((tx) =>
      findOrCreateContact(tx, {
        name: "A Different Name",
        phone: "0700 555 0110",
        email: "other@example.test",
        address: "9 Other Street",
        notes: "other notes",
        customerSource: "whatsapp",
        origin: "manual",
        createdBy: null,
      }),
    );
    expect(found).toMatchObject({ customerId: id, created: false, matchedBy: "phone", carriedStop: false });
    const [after] = await db.select().from(customer).where(eq(customer.id, id));
    expect(after).toEqual(before);
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, id))).toHaveLength(0);
    expect(await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, id))).toHaveLength(0);

    // A new person: a customer and an origin row, still no identity.
    const made = await db.transaction((tx) =>
      findOrCreateContact(tx, {
        name: "  New Person  ",
        phone: "7005550111",
        email: " New@Example.TEST ",
        address: "2 Test Close",
        customerSource: "walkup_anonymous",
        origin: "manual",
        sourceLabel: "order book",
        createdBy: null,
      }),
    );
    expect(made).toMatchObject({ created: true, matchedBy: null });
    const [row] = await db.select().from(customer).where(eq(customer.id, made.customerId));
    expect(row).toMatchObject({ name: "New Person", phone: "+2347005550111", email: "new@example.test", defaultAddress: "2 Test Close", source: "walkup_anonymous" });
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, made.customerId))).toHaveLength(0);
    const [origin] = await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, made.customerId));
    expect(origin).toMatchObject({ origin: "manual", sourceLabel: "order book" });
  });

  it("findOrCreateContact refuses an unusable phone, a bad email and a contact with neither", async () => {
    const attempt = (input: { phone?: string; email?: string }) =>
      db.transaction((tx) => findOrCreateContact(tx, { ...input, customerSource: "phone", origin: "manual", createdBy: null }));
    await expect(attempt({ phone: "12345" })).rejects.toMatchObject({ name: "ContactInputError", code: "bad_phone" });
    await expect(attempt({ email: "not-an-email" })).rejects.toMatchObject({ code: "bad_email" });
    await expect(attempt({})).rejects.toMatchObject({ code: "no_contact" });
  });

  it("findOrCreateContact matches by email only when there is no phone", async () => {
    const older = await newCustomer({ name: "Email Older", email: "Pair@Example.test", phone: "+2347005550120", createdAt: daysAgo(10) });
    await newCustomer({ name: "Email Newer", email: "pair@example.test", createdAt: daysAgo(1) });

    const byEmail = await db.transaction((tx) =>
      findOrCreateContact(tx, { email: " PAIR@example.test ", customerSource: "online", origin: "import", createdBy: null }),
    );
    expect(byEmail).toMatchObject({ customerId: older, created: false, matchedBy: "email" });

    // With a phone the email is not used to match: a new number makes a new contact.
    const withPhone = await db.transaction((tx) =>
      findOrCreateContact(tx, { phone: "07005550121", email: "pair@example.test", customerSource: "online", origin: "import", createdBy: null }),
    );
    expect(withPhone.created).toBe(true);
    expect(withPhone.customerId).not.toBe(older);
  });

  it("findOrCreateContact carries a stop over from a deleted customer with the same number", async () => {
    const gone = await newCustomer({ name: "Gone", phone: "0700 555 0130", deletedAt: daysAgo(5) });
    await db.transaction((tx) => recordConsent(tx, gone, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));

    const made = await db.transaction((tx) =>
      findOrCreateContact(tx, { name: "Back Again", phone: "+2347005550130", customerSource: "phone", origin: "import", createdBy: null }),
    );
    expect(made).toMatchObject({ created: true, carriedStop: true });
    expect(made.customerId).not.toBe(gone);
    const now = await currentConsent(db, made.customerId);
    expect(now).toEqual([expect.objectContaining({ channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "carried_over" })]);
    expect(await isStoppedOnWhatsApp(db, made.customerId)).toBe(true);
    // A bulk yes cannot lift it.
    const lifted = await db.transaction((tx) =>
      recordConsent(tx, made.customerId, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "import" }),
    );
    expect(lifted).toBe(false);
    expect(await isStoppedOnWhatsApp(db, made.customerId)).toBe(true);
  });

  // ── Consent ────────────────────────────────────────────────────────────────

  it("recordConsent keeps one current row per channel and purpose and keeps the history", async () => {
    const id = await newCustomer({ name: "Consent History", phone: "+2347005550140" });
    const change = (state: "granted" | "withdrawn", method: "staff" | "keyword", channel: "whatsapp" | "email" = "whatsapp") =>
      db.transaction((tx) => recordConsent(tx, id, { channel, purpose: "marketing", state, method, wording: `${state} by ${method}` }));

    expect(await change("granted", "staff")).toBe(true);
    expect(await change("granted", "staff")).toBe(false); // unchanged: writes nothing
    expect(await change("withdrawn", "keyword")).toBe(true);
    expect(await change("granted", "staff")).toBe(true);
    expect(await change("granted", "staff", "email")).toBe(true);

    const rows = await db.select().from(contactConsent).where(eq(contactConsent.customerId, id));
    expect(rows).toHaveLength(4);
    const current = rows.filter((r) => r.isCurrent);
    expect(current.map((r) => `${r.channel}:${r.state}`).sort()).toEqual(["email:granted", "whatsapp:granted"]);
    expect(rows.filter((r) => r.channel === "whatsapp").map((r) => r.state).sort()).toEqual(["granted", "granted", "withdrawn"]);
    expect(await currentConsent(db, id)).toHaveLength(2);
  });

  it("recordConsent refuses a granted from an import when the current row is withdrawn", async () => {
    const id = await newCustomer({ name: "Stopped", phone: "+2347005550141" });
    await db.transaction((tx) => recordConsent(tx, id, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));
    for (const method of ["import", "carried_over", "merge", "meta_refusal", "erase_request"] as const) {
      const ok = await db.transaction((tx) => recordConsent(tx, id, { channel: "whatsapp", purpose: "marketing", state: "granted", method }));
      expect(ok, method).toBe(false);
    }
    expect(await db.select().from(contactConsent).where(eq(contactConsent.customerId, id))).toHaveLength(1);
    expect(await isStoppedOnWhatsApp(db, id)).toBe(true);
    // A person, the customer's own START, or their own WhatsApp setting may lift it.
    const staff = await db.transaction((tx) => recordConsent(tx, id, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff" }));
    expect(staff).toBe(true);
    expect(await isStoppedOnWhatsApp(db, id)).toBe(false);
  });

  it("two consent changes at the same moment leave exactly one current row", async () => {
    const id = await newCustomer({ name: "Raced", phone: "+2347005550142" });
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        db.transaction((tx) =>
          recordConsent(tx, id, { channel: "whatsapp", purpose: "marketing", state: i % 2 === 0 ? "withdrawn" : "granted", method: "staff" }),
        ),
      ),
    );
    const rows = await db.select().from(contactConsent).where(eq(contactConsent.customerId, id));
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
  });

  // ── The summary ────────────────────────────────────────────────────────────

  it("refreshContactSummary: counts orders that are not cancelled or failed, and sums total_ngn", async () => {
    const id = await newCustomer({ name: "  Orders Person ", phone: "0700 555 0150", email: "Orders@Example.test" });
    await order(id, 12_000, daysAgo(40));
    await order(id, 8_000, daysAgo(10), { status: "delivered" });
    await order(id, 50_000, daysAgo(5), { status: "cancelled" });
    await order(id, 70_000, daysAgo(3), { status: "failed" });
    await refreshContactSummary(db, [id]);
    const s = await summary(id);
    expect(s).toMatchObject({
      nameSort: "orders person",
      phoneDigits: "7005550150",
      hasPhone: true,
      hasEmail: true,
      hasAddress: false,
      ordersCount: 2,
      spentNgn: 20_000,
    });
    expect(s!.searchText).toContain("orders person");
    expect(s!.searchText).toContain("orders@example.test");
    expect(s!.firstOrderAt?.toISOString()).toBe(daysAgo(40).toISOString());
    expect(s!.lastOrderAt?.toISOString()).toBe(daysAgo(10).toISOString());

    // Nobody ordered: zero, and the key that is never null.
    const none = await newCustomer({ name: null, phone: null });
    await refreshContactSummary(db, [none]);
    expect(await summary(none)).toMatchObject({ nameSort: "~", phoneDigits: null, hasPhone: false, ordersCount: 0, spentNgn: 0, lastOrderAt: null, lastOrderKey: "-infinity" });
    // Refreshing nothing is a no-op.
    await refreshContactSummary(db, []);
  });

  it("refreshContactSummary: address is default_address, else the newest delivery_address_formatted, with the right tag", async () => {
    const saved = await newCustomer({ name: "Saved Address", defaultAddress: "3 Saved Street" });
    await order(saved, 1_000, daysAgo(2), { address: "9 Delivery Lane" });
    const delivered = await newCustomer({ name: "Delivery Only", defaultAddress: "   " });
    await order(delivered, 1_000, daysAgo(20), { address: "Old Delivery Road" });
    await order(delivered, 1_000, daysAgo(4), { address: "New Delivery Road" });
    await order(delivered, 1_000, daysAgo(1), { address: "Cancelled Order Road", status: "cancelled" });
    await order(delivered, 1_000, daysAgo(2), { address: "  " });
    const nothing = await newCustomer({ name: "No Address" });
    await refreshContactSummary(db, [saved, delivered, nothing]);
    expect(await summary(saved)).toMatchObject({ address: "3 Saved Street", addressSource: "saved", hasAddress: true });
    expect(await summary(delivered)).toMatchObject({ address: "New Delivery Road", addressSource: "last_delivery", hasAddress: true });
    expect(await summary(nothing)).toMatchObject({ address: null, addressSource: null, hasAddress: false });
  });

  it("refreshContactSummary: an alias has no row and its orders count under the kept contact", async () => {
    const kept = await newCustomer({ name: "Kept", phone: "+2347005550160" });
    const merged = await newCustomer({ name: "Merged Away", phone: "+2347005550161" });
    await order(kept, 5_000, daysAgo(9));
    await order(merged, 7_000, daysAgo(3), { address: "Merged Record Road" });
    await refreshContactSummary(db, [kept, merged]);
    expect(await summary(merged)).not.toBeNull();

    await db.insert(contactAlias).values({ customerId: merged, intoCustomerId: kept });
    await refreshContactSummary(db, [kept, merged]);
    expect(await summary(merged)).toBeNull();
    expect(await summary(kept)).toMatchObject({ ordersCount: 2, spentNgn: 12_000, address: "Merged Record Road", addressSource: "last_delivery" });
    // The shop's own rows are untouched.
    expect(await db.select().from(customer).where(eq(customer.id, merged))).toHaveLength(1);
  });

  it("refreshContactSummary: channels come from identities and calls; a deleted customer loses its row", async () => {
    const wa = await db.transaction((tx) => findOrCreateCustomer(tx, "07005550170", { name: "Wa Person", source: "whatsapp" }));
    const ig = await db.transaction((tx) =>
      findOrCreateCustomerByIdentity(tx, { channel: "instagram", accountExternalId: "178000000001", externalId: "IGSID-1", displayName: "Insta Person", username: "insta_juice" }),
    );
    await db.insert(inboxIdentity).values({ customerId: ig.customerId, channel: "messenger", accountExternalId: "100200300401", externalId: "PSID-1" });
    const caller = await newCustomer({ name: "Caller", phone: "+2347005550171" });
    const [conv] = await db
      .insert(inboxConversation)
      .values({ customerId: caller, phoneNumberId: lineId, status: "closed", lastActivityAt: daysAgo(6), closedAt: daysAgo(6) })
      .returning();
    await db.insert(inboxCall).values({
      conversationId: conv!.id,
      customerId: caller,
      phoneNumberId: lineId,
      twilioCallSid: "CA-test-domain-1",
      direction: "in",
      fromE164: "+2347005550171",
      toE164: "+2347005550999",
    });
    await refreshContactSummary(db, [wa.id, ig.customerId, caller]);
    expect((await summary(wa.id))!.channels).toEqual(["whatsapp"]);
    expect((await summary(ig.customerId))!.channels).toEqual(["messenger", "instagram"]);
    expect((await summary(ig.customerId))!.searchText).toContain("insta_juice");
    const callerRow = await summary(caller);
    expect(callerRow!.channels).toEqual(["phone"]);
    expect(callerRow!.lastContactAt?.toISOString()).toBe(daysAgo(6).toISOString());

    await db.update(customer).set({ deletedAt: NOW }).where(eq(customer.id, caller));
    await refreshContactSummary(db, [caller]);
    expect(await summary(caller)).toBeNull();
    expect(await db.select().from(customer).where(eq(customer.id, caller))).toHaveLength(1);
  });

  it("refreshChangedSummaries picks up a new order, and rebuildAllSummaries covers everyone", async () => {
    const id = await newCustomer({ name: "Changed Later", phone: "+2347005550175" });
    await refreshContactSummary(db, [id]);
    expect((await summary(id))!.ordersCount).toBe(0);
    await order(id, 4_000, daysAgo(1));
    // sale_order.updated_at is set by the database, so a watermark far in the past always sees it.
    const n = await refreshChangedSummaries(db, new Date("2000-01-01T00:00:00Z"), NOW);
    expect(n).toBeGreaterThan(0);
    expect((await summary(id))!.ordersCount).toBe(1);

    const unseen = await newCustomer({ name: "Never Summarised" });
    const total = await rebuildAllSummaries(db);
    const live = (await db.execute(sql`SELECT count(*)::int AS n FROM customer WHERE deleted_at IS NULL`)) as unknown as { n: number }[];
    expect(total).toBe(Number(live[0]!.n));
    expect(await summary(unseen)).not.toBeNull();
    const stray = (await db.execute(sql`
      SELECT count(*)::int AS n FROM contact_summary s JOIN customer c ON c.id = s.customer_id
      WHERE c.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM contact_alias a WHERE a.customer_id = c.id)
    `)) as unknown as { n: number }[];
    expect(Number(stray[0]!.n)).toBe(0);
  });

  // ── Filters ────────────────────────────────────────────────────────────────

  it("contactFilterSql: each filter alone, and two together", async () => {
    const rich = await newCustomer({ name: "Filter Rich", phone: "+2347005550180", email: "rich@filter.test", defaultAddress: "1 Filter Road", source: "online" });
    await order(rich, 60_000, daysAgo(10));
    await order(rich, 15_000, daysAgo(200));
    const lapsed = await newCustomer({ name: "Filter Lapsed", phone: "+2347005550181", source: "whatsapp" });
    await order(lapsed, 5_000, daysAgo(300));
    const never = await newCustomer({ name: "Filter Never", email: "never@filter.test", source: "walkup_anonymous" });
    const chatter = await db.transaction((tx) =>
      findOrCreateCustomerByIdentity(tx, { channel: "instagram", accountExternalId: "178000000001", externalId: "IGSID-F", username: "filter_fan" }),
    );
    await db
      .insert(inboxConversation)
      .values({ customerId: chatter.customerId, phoneNumberId: lineId, status: "closed", channel: "instagram", lastActivityAt: daysAgo(3), closedAt: daysAgo(3) });
    const imported = await db.transaction((tx) =>
      findOrCreateContact(tx, { name: "Filter Imported", phone: "07005550182", customerSource: "phone", origin: "import", createdBy: null }),
    );
    const all = [rich, lapsed, never, chatter.customerId, imported.customerId];
    await refreshContactSummary(db, all);

    const [label] = await db.insert(contactLabel).values({ name: "Filter Label", nameKey: "filter label" }).returning();
    await db.insert(contactLabelMember).values({ customerId: rich, labelId: label!.id });
    const [list] = await db.insert(contactList).values({ name: "Filter List", nameKey: "filter list", kind: "static" }).returning();
    await db.insert(contactListMember).values([{ listId: list!.id, customerId: lapsed }, { listId: list!.id, customerId: never }]);
    await db.transaction((tx) => recordConsent(tx, rich, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff" }));
    await db.transaction((tx) => recordConsent(tx, lapsed, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword" }));

    const only = async (f: ContactFilter) => (await matching(f)).filter((id) => all.includes(id)).sort();
    const ids = (...list: string[]) => [...list].sort();

    expect(await only({})).toEqual(ids(...all));
    expect(await only({ q: "filter ri" })).toEqual(ids(rich));
    expect(await only({ q: "0700 555 0181" })).toEqual(ids(lapsed));
    expect(await only({ q: "+234 700 555 0181" })).toEqual(ids(lapsed));
    expect(await only({ q: "7005550181" })).toEqual(ids(lapsed));
    expect(await only({ q: "never@filter" })).toEqual(ids(never));
    expect(await only({ q: "@filter_fan" })).toEqual(ids(chatter.customerId));
    expect(await only({ q: "100%" })).toEqual([]); // a wildcard typed by a person is just text
    expect(await only({ channels: ["instagram"] })).toEqual(ids(chatter.customerId));
    expect(await only({ channels: ["whatsapp", "messenger"] })).toEqual([]);
    expect(await only({ has_phone: true })).toEqual(ids(rich, lapsed, imported.customerId));
    expect(await only({ has_phone: false })).toEqual(ids(never, chatter.customerId));
    expect(await only({ has_email: true })).toEqual(ids(rich, never));
    expect(await only({ has_address: true })).toEqual(ids(rich));
    expect(await only({ ordered_within_days: 60 })).toEqual(ids(rich));
    expect(await only({ ordered_within_days: 365 })).toEqual(ids(rich, lapsed));
    expect(await only({ never_ordered: true })).toEqual(ids(never, chatter.customerId, imported.customerId));
    expect(await only({ min_spent_ngn: 50_000 })).toEqual(ids(rich));
    expect(await only({ min_orders: 2 })).toEqual(ids(rich));
    expect(await only({ last_contact_within_days: 7 })).toEqual(ids(chatter.customerId));
    expect(await only({ label_ids: [label!.id] })).toEqual(ids(rich));
    expect(await only({ sources: ["walkup_anonymous"] })).toEqual(ids(never));
    expect(await only({ sources: ["import"] })).toEqual(ids(imported.customerId));
    expect(await only({ sources: ["whatsapp", "import"] })).toEqual(ids(lapsed, imported.customerId));
    expect(await only({ sources: ["manual"] })).toEqual([]);
    expect(await only({ consent: "agreed" })).toEqual(ids(rich));
    expect(await only({ consent: "stopped" })).toEqual(ids(lapsed));
    expect(await only({ consent: "not_asked" })).toEqual(ids(never, chatter.customerId, imported.customerId));
    expect(await only({ list_id: list!.id })).toEqual(ids(lapsed, never));

    // Two together are joined with AND.
    expect(await only({ has_phone: true, ordered_within_days: 365 })).toEqual(ids(rich, lapsed));
    expect(await only({ has_phone: true, consent: "not_asked" })).toEqual(ids(imported.customerId));
    expect(await only({ list_id: list!.id, never_ordered: true })).toEqual(ids(never));

    // A list's members: a static list by its rows, a smart list by its filter at this moment.
    const members = async (l: Parameters<typeof listMembersSql>[0]) =>
      ((await db.execute(listMembersSql(l, NOW))) as unknown as { customer_id: string }[]).map((r) => r.customer_id).filter((id) => all.includes(id)).sort();
    expect(await members({ id: list!.id, kind: "static", filter: null })).toEqual(ids(lapsed, never));
    expect(await members({ id: list!.id, kind: "smart", filter: { min_spent_ngn: 50_000 } })).toEqual(ids(rich));
  });
});
