/**
 * Contacts (suite spec 14, Phase A, section 5.7). Mounted at /v1/contacts.
 *
 * A contact is a row of the shop's `customer` table. These routes list every
 * customer, let a person with contacts.manage correct a name, email, address
 * and notes (each change audited with before and after), add contacts by hand
 * or from a spreadsheet, group them with labels and lists, and record consent.
 *
 * What these routes never do: delete a customer, change a phone number,
 * overwrite a value during an import, or lift a customer's "stop" without a
 * person saying the customer asked for that. Nothing here calls Meta.
 *
 * They use requireAuth and requireCapability, not the inbox's withViewer,
 * because a person may hold contacts.view without inbox.view (rule R33).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  adminUser,
  appSetting,
  auditLog,
  contactAlias,
  contactConsent,
  contactImport,
  contactImportRow,
  contactLabel,
  contactLabelMember,
  contactList,
  contactListMember,
  customer,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  ContactInputError,
  findOrCreateContact,
  listMembersSql,
  loadContactSettings,
  previewImport,
  recordConsent,
  refreshContactSummary,
  uuidArray,
  whatsappMarketingConsent,
} from "@ms/domain";
import {
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
  CONSENT_STATES,
  CONSENT_VIEW_LABEL,
  CONTACT_CHANNEL_LABEL,
  CONTACT_LABEL_COLOURS,
  CONTACT_LIMITS,
  CONTACT_SETTINGS_KEY,
  CONTACT_SORTS,
  CONTACT_SOURCE_LABEL,
  CUSTOMER_SOURCES,
  IMPORT_FIELDS,
  csvSafeCell,
  describeContactFilter,
  importReasonCode,
  importReasonHeading,
  importReasonText,
  normaliseContactEmail,
  parseContactFilter,
  parseCsv,
  suggestMapping,
  type ConsentRow,
  type ContactFilter,
  type ContactListView,
  type ContactRow,
  type ContactSettings,
  type ContactSort,
  type ImportMapping,
  type ImportRowView,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError, pgErrorCode } from "../lib/errors.js";
import { toCsv } from "../lib/csv.js";
import {
  consentNow,
  contactCount,
  contactDetail,
  contactPage,
  decodeCursor,
  filterWhere,
  type ContactCursor,
} from "../lib/contacts-read.js";

const Uuid = z.string().uuid();

/** Seam for tests: "now" drives the day-based filters, so tests pass a fixed moment. */
export const contactDeps = {
  now: (): Date => new Date(),
};

function refuse(status: 400 | 403 | 404 | 409 | 422, message: string, details?: Record<string, unknown>): never {
  const code = status === 404 ? "not_found" : status === 403 ? "forbidden" : status === 409 ? "conflict" : "validation_failed";
  throw new BusinessError(code, message, status, details);
}

function notFound(): never {
  return refuse(404, "We couldn't find that.");
}

function uuidParam(c: Context, name: string): string {
  const v = c.req.param(name) ?? "";
  if (!Uuid.safeParse(v).success) notFound();
  return v;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** YYYY-MM-DD in Lagos (UTC+1 all year), worked out here so it never depends on the machine's locale or zone. */
function lagosDay(isoText: string | null): string {
  if (!isoText) return "";
  const t = Date.parse(isoText);
  if (Number.isNaN(t)) return "";
  return new Date(t + 60 * 60_000).toISOString().slice(0, 10);
}

function lagosToday(now: Date): string {
  return new Date(now.getTime() + 60 * 60_000).toISOString().slice(0, 10);
}

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "bad date");

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A live customer that is a contact (not deleted, not merged into another). Locks the row when asked. */
async function liveContact(db: DbExecutor, id: string, lock = false) {
  const q = db.select().from(customer).where(eq(customer.id, id));
  const [cust] = lock ? await q.for("update") : await q;
  if (!cust || cust.deletedAt) return null;
  const [alias] = await db.select({ id: contactAlias.customerId }).from(contactAlias).where(eq(contactAlias.customerId, id));
  return alias ? null : cust;
}

function parseFilterQuery(text: string | undefined): unknown {
  if (text === undefined || text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return refuse(422, "That filter can't be read.");
  }
}

interface ListRow {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  filter: Record<string, unknown> | null;
  createdBy: string | null;
  updatedAt: Date;
  archivedAt: Date | null;
}

function listFilter(l: { kind: string; filter: unknown }): ContactFilter | null {
  if (l.kind !== "smart") return null;
  const parsed = parseContactFilter(l.filter, { forSmartList: true });
  return parsed.ok ? parsed.filter : {};
}

/** The live count of a list (rule R23): never stored. */
async function listCount(db: DbExecutor, l: { id: string; kind: string; filter: unknown }, now: Date): Promise<number> {
  const members = listMembersSql({ id: l.id, kind: l.kind as "static" | "smart", filter: listFilter(l) }, now);
  const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM (${members}) m`)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

async function labelNames(db: DbExecutor, ids: string[] | undefined): Promise<Record<string, string>> {
  if (!ids?.length) return {};
  const rows = await db.select({ id: contactLabel.id, name: contactLabel.name }).from(contactLabel).where(inArray(contactLabel.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

async function listView(db: DbExecutor, l: ListRow, now: Date, withRules = false): Promise<ContactListView> {
  const [by] = l.createdBy
    ? await db.select({ name: adminUser.name, email: adminUser.email }).from(adminUser).where(eq(adminUser.id, l.createdBy))
    : [];
  const filter = listFilter(l);
  return {
    id: l.id,
    name: l.name,
    kind: l.kind as "static" | "smart",
    description: l.description,
    count: await listCount(db, l, now),
    created_by_name: by?.name ?? by?.email ?? null,
    updated_at: l.updatedAt.toISOString(),
    archived_at: l.archivedAt ? l.archivedAt.toISOString() : null,
    ...(withRules && filter ? { filter, filter_lines: describeContactFilter(filter, await labelNames(db, filter.label_ids)) } : {}),
  };
}

/** A filter's `list_id` must name a list that holds member rows (a smart list's ID is refused; rule R4). */
async function checkFilterList(db: DbExecutor, f: ContactFilter): Promise<void> {
  if (!f.list_id) return;
  const [l] = await db.select({ kind: contactList.kind }).from(contactList).where(eq(contactList.id, f.list_id));
  if (!l) refuse(422, "That list no longer exists.");
  if (l.kind === "smart") refuse(422, "That list fills itself from its rules. Open the list to see who is on it.");
}

const EXPORT_HEADER = [
  "Name",
  "Phone",
  "Email",
  "Address",
  "Reaches us by",
  "Came from",
  "Orders",
  "Total spent (NGN)",
  "Last order",
  "Last contact",
  "Labels",
  "Promotions on WhatsApp",
] as const;

function exportCells(r: ContactRow): string[] {
  return [
    r.name ?? "",
    r.phone ?? "",
    r.email ?? "",
    r.address ?? "",
    r.channels.map((c) => CONTACT_CHANNEL_LABEL[c] ?? c).join("; "),
    CONTACT_SOURCE_LABEL[r.source] ?? r.source,
    String(r.orders_count),
    String(r.spent_ngn),
    lagosDay(r.last_order_at),
    lagosDay(r.last_contact_at),
    r.labels.map((l) => l.name).join("; "),
    CONSENT_VIEW_LABEL[r.consent],
    // Every cell is guarded: a value starting with = + - or @ is written as text (rule R7).
  ].map(csvSafeCell);
}

const NameField = z.string().max(400);
const CustomerSource = z.enum(CUSTOMER_SOURCES);

const CreateBody = z
  .object({
    name: NameField.nullish(),
    phone: z.string().max(60).nullish(),
    email: z.string().max(320).nullish(),
    address: z.string().max(2000).nullish(),
    notes: z.string().max(20_000).nullish(),
    customer_source: CustomerSource,
    source_label: z.string().max(80).nullish(),
    consent: z
      .object({ wording: z.string().max(1000), collected_on: DateOnly.nullish(), method_note: z.string().max(500).nullish() })
      .strict()
      .nullish(),
  })
  .strict();

const PatchBody = z
  .object({
    name: z.string().max(400).optional(),
    email: z.string().max(320).nullable().optional(),
    address: z.string().max(2000).nullable().optional(),
    notes: z.string().max(20_000).nullable().optional(),
  })
  .strict();

const ConsentBody = z
  .object({
    channel: z.enum(CONSENT_CHANNELS),
    purpose: z.enum(CONSENT_PURPOSES),
    state: z.enum(CONSENT_STATES),
    wording: z.string().max(1000).nullish(),
    collected_on: DateOnly.nullish(),
    note: z.string().max(500).nullish(),
    /** Must be true to turn a "stopped" back into "agreed": the customer asked for promotions again. */
    asked_again: z.boolean().optional(),
  })
  .strict();

const IdList = (max: number) => z.array(Uuid).max(max);

const ImportOptions = z
  .object({
    mapping: z.record(z.enum(IMPORT_FIELDS as unknown as [string, ...string[]]), z.string().max(300)),
    source_label: z.string().trim().min(1).max(80),
    customer_source: CustomerSource,
    consent_declared: z.enum(["none", "marketing_whatsapp"]),
    consent_method: z.string().max(300).nullish(),
    consent_wording: z.string().max(1000).nullish(),
    consent_collected_on: DateOnly.nullish(),
    fill_blanks: z.boolean(),
    label_id: Uuid.nullish(),
    list_id: Uuid.nullish(),
  })
  .strict();

const SettingsBody = z
  .object({
    stop_confirmation: z.boolean(),
    stop_text: z.string().trim().min(1).max(CONTACT_LIMITS.settingsText),
    start_text: z.string().trim().min(1).max(CONTACT_LIMITS.settingsText),
  })
  .strict();

export function contactRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  const V = requireCapability("contacts.view");
  const M = requireCapability("contacts.manage");

  const audit = (c: Context, action: string, entityType: string, entityId: string, after?: unknown, before?: unknown, notify = false) =>
    writeAudit(db, c, { action, entityType, entityId, after, before, notify });

  const detailOr404 = async (c: Context, id: string) => {
    const auth = c.get("auth");
    const found = await contactDetail(db, { userId: auth.userId, capabilities: auth.capabilities }, id, contactDeps.now());
    if (found.kind === "missing") notFound();
    return found;
  };

  // ── The list ───────────────────────────────────────────────────────────────

  r.get("/", V, async (c) => {
    const now = contactDeps.now();
    const fw = filterWhere(parseFilterQuery(c.req.query("filter")), now);
    if (!fw.ok) refuse(422, fw.error);
    await checkFilterList(db, fw.filter);
    const sortText = c.req.query("sort") ?? "name";
    if (!(CONTACT_SORTS as readonly string[]).includes(sortText)) refuse(400, "That sort order isn't one we know.");
    const sort = sortText as ContactSort;
    const limitText = c.req.query("limit");
    const limitNum = limitText === undefined ? CONTACT_LIMITS.pageDefault : Number(limitText);
    if (!Number.isInteger(limitNum) || limitNum < 1) refuse(400, "That page size isn't right.");
    const limit = Math.min(limitNum, CONTACT_LIMITS.pageMax);
    const cursorText = c.req.query("cursor");
    let cursor: ContactCursor | null = null;
    if (cursorText) {
      cursor = decodeCursor(cursorText);
      if (!cursor || cursor.s !== sort) refuse(400, "Start the list again.");
    }
    const page = await contactPage(db, fw.where, sort, limit, cursor);
    const total = cursor ? null : await contactCount(db, fw.where);
    return c.json({ data: { ...page, total } });
  });

  // ── Labels ─────────────────────────────────────────────────────────────────

  r.get("/labels", V, async (c) => {
    const rows = (await db.execute(sql`
      SELECT l.id, l.name, l.colour,
        (SELECT count(*)::int FROM contact_label_member m JOIN contact_summary s ON s.customer_id = m.customer_id WHERE m.label_id = l.id) AS contacts
      FROM contact_label l ORDER BY l.name_key
    `)) as unknown as { id: string; name: string; colour: string; contacts: number }[];
    return c.json({ data: rows.map((x) => ({ ...x, contacts: Number(x.contacts) })) });
  });

  r.post("/labels", M, async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(CONTACT_LIMITS.labelName), colour: z.enum(CONTACT_LABEL_COLOURS).optional() })
      .strict()
      .parse(await jsonBody(c));
    try {
      const [row] = await db
        .insert(contactLabel)
        .values({ name: body.name, nameKey: nameKey(body.name), colour: body.colour ?? "green", createdBy: c.get("auth").userId })
        .returning();
      await audit(c, "contacts.label_create", "contact_label", row!.id, { name: row!.name, colour: row!.colour });
      return c.json({ data: { id: row!.id, name: row!.name, colour: row!.colour, contacts: 0 } }, 201);
    } catch (err) {
      if (pgErrorCode(err) === "23505") refuse(409, "A label with that name already exists.");
      throw err;
    }
  });

  r.patch("/labels/:id", M, async (c) => {
    const id = uuidParam(c, "id");
    const body = z
      .object({ name: z.string().trim().min(1).max(CONTACT_LIMITS.labelName).optional(), colour: z.enum(CONTACT_LABEL_COLOURS).optional() })
      .strict()
      .parse(await jsonBody(c));
    const [before] = await db.select().from(contactLabel).where(eq(contactLabel.id, id));
    if (!before) notFound();
    try {
      const [row] = await db
        .update(contactLabel)
        .set({
          ...(body.name !== undefined ? { name: body.name, nameKey: nameKey(body.name) } : {}),
          ...(body.colour !== undefined ? { colour: body.colour } : {}),
        })
        .where(eq(contactLabel.id, id))
        .returning();
      await audit(c, "contacts.label_update", "contact_label", id, { name: row!.name, colour: row!.colour }, { name: before.name, colour: before.colour });
      return c.json({ data: { id: row!.id, name: row!.name, colour: row!.colour } });
    } catch (err) {
      if (pgErrorCode(err) === "23505") refuse(409, "A label with that name already exists.");
      throw err;
    }
  });

  r.delete("/labels/:id", M, async (c) => {
    const id = uuidParam(c, "id");
    z.object({ confirm: z.literal(true) }).strict().parse(await jsonBody(c));
    const [before] = await db.select().from(contactLabel).where(eq(contactLabel.id, id));
    if (!before) notFound();
    const removed = await db.transaction(async (tx) => {
      const members = await tx.delete(contactLabelMember).where(eq(contactLabelMember.labelId, id)).returning({ id: contactLabelMember.customerId });
      await tx.delete(contactLabel).where(eq(contactLabel.id, id));
      return members.length;
    });
    await audit(c, "contacts.label_delete", "contact_label", id, { removed_from: removed }, { name: before.name, colour: before.colour });
    return c.json({ data: { removed_from: removed } });
  });

  r.post("/bulk/labels", M, async (c) => {
    const body = z
      .object({ customer_ids: IdList(CONTACT_LIMITS.bulkIds).min(1), add: IdList(50).optional(), remove: IdList(50).optional() })
      .strict()
      .parse(await jsonBody(c));
    const add = body.add ?? [];
    const remove = body.remove ?? [];
    if (add.length === 0 && remove.length === 0) refuse(422, "Choose a label to add or remove.");
    const userId = c.get("auth").userId;
    const result = await db.transaction(async (tx) => {
      let added = 0;
      let removed = 0;
      if (add.length) {
        // Only labels that exist, only people who are contacts.
        const rows = (await tx.execute(sql`
          INSERT INTO contact_label_member (customer_id, label_id, added_by)
          SELECT s.customer_id, l.id, ${userId}::uuid
          FROM contact_summary s CROSS JOIN contact_label l
          WHERE s.customer_id = ANY(${uuidArray(body.customer_ids)}) AND l.id = ANY(${uuidArray(add)})
          ON CONFLICT DO NOTHING RETURNING customer_id
        `)) as unknown as unknown[];
        added = rows.length;
      }
      if (remove.length) {
        const rows = await tx
          .delete(contactLabelMember)
          .where(and(inArray(contactLabelMember.customerId, body.customer_ids), inArray(contactLabelMember.labelId, remove)))
          .returning({ id: contactLabelMember.customerId });
        removed = rows.length;
      }
      return { added, removed };
    });
    await audit(c, "contacts.bulk_labels", "contact_label", "bulk", {
      contacts: body.customer_ids.length,
      add,
      remove,
      added: result.added,
      removed: result.removed,
    });
    return c.json({ data: { changed: result.added + result.removed, ...result } });
  });

  // ── Lists ──────────────────────────────────────────────────────────────────

  r.get("/lists", V, async (c) => {
    const now = contactDeps.now();
    const includeArchived = c.req.query("include_archived") === "true" || c.req.query("include_archived") === "1";
    const rows = await db
      .select()
      .from(contactList)
      .where(includeArchived ? undefined : isNull(contactList.archivedAt))
      .orderBy(asc(contactList.nameKey), desc(contactList.createdAt));
    const out: ContactListView[] = [];
    for (const l of rows) out.push(await listView(db, l, now));
    return c.json({ data: out });
  });

  r.post("/lists", M, async (c) => {
    const now = contactDeps.now();
    const body = z
      .object({
        name: z.string().trim().min(1).max(CONTACT_LIMITS.listName),
        kind: z.enum(["static", "smart"]),
        description: z.string().trim().max(500).nullish(),
        filter: z.unknown().optional(),
        customer_ids: IdList(CONTACT_LIMITS.bulkIds).optional(),
      })
      .strict()
      .parse(await jsonBody(c));
    let filter: ContactFilter | null = null;
    if (body.kind === "smart") {
      if (body.customer_ids?.length) refuse(422, "A list that fills itself can't also hold people picked by hand.");
      const parsed = parseContactFilter(body.filter, { forSmartList: true });
      if (!parsed.ok) refuse(422, parsed.error);
      filter = parsed.filter;
    } else if (body.filter !== undefined && body.filter !== null) {
      refuse(422, "Only a list that keeps itself up to date has rules.");
    }
    const userId = c.get("auth").userId;
    try {
      const row = await db.transaction(async (tx) => {
        const [l] = await tx
          .insert(contactList)
          .values({
            name: body.name,
            nameKey: nameKey(body.name),
            kind: body.kind,
            description: body.description || null,
            filter: filter as Record<string, unknown> | null,
            createdBy: userId,
          })
          .returning();
        if (body.kind === "static" && body.customer_ids?.length) {
          await tx.execute(sql`
            INSERT INTO contact_list_member (list_id, customer_id, added_by)
            SELECT ${l!.id}::uuid, s.customer_id, ${userId}::uuid FROM contact_summary s
            WHERE s.customer_id = ANY(${uuidArray(body.customer_ids)}) ON CONFLICT DO NOTHING
          `);
        }
        return l!;
      });
      const view = await listView(db, row, now, true);
      await audit(c, "contacts.list_create", "contact_list", row.id, { name: row.name, kind: row.kind, filter, members: view.count });
      return c.json({ data: view }, 201);
    } catch (err) {
      if (pgErrorCode(err) === "23505") refuse(409, "A list with that name already exists.");
      throw err;
    }
  });

  r.get("/lists/:id", V, async (c) => {
    const id = uuidParam(c, "id");
    const [l] = await db.select().from(contactList).where(eq(contactList.id, id));
    if (!l) notFound();
    return c.json({ data: await listView(db, l, contactDeps.now(), true) });
  });

  r.patch("/lists/:id", M, async (c) => {
    const id = uuidParam(c, "id");
    const body = z
      .object({
        name: z.string().trim().min(1).max(CONTACT_LIMITS.listName).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        filter: z.unknown().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .parse(await jsonBody(c));
    const [before] = await db.select().from(contactList).where(eq(contactList.id, id));
    if (!before) notFound();
    let filter: ContactFilter | undefined;
    if (body.filter !== undefined) {
      if (before.kind !== "smart") refuse(422, "Only a list that keeps itself up to date has rules.");
      const parsed = parseContactFilter(body.filter, { forSmartList: true });
      if (!parsed.ok) refuse(422, parsed.error);
      filter = parsed.filter;
    }
    try {
      const [row] = await db
        .update(contactList)
        .set({
          ...(body.name !== undefined ? { name: body.name, nameKey: nameKey(body.name) } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
          ...(filter !== undefined ? { filter: filter as Record<string, unknown> } : {}),
          ...(body.archived !== undefined ? { archivedAt: body.archived ? new Date() : null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(contactList.id, id))
        .returning();
      await audit(
        c,
        "contacts.list_update",
        "contact_list",
        id,
        { name: row!.name, description: row!.description, filter: row!.filter, archived: row!.archivedAt !== null },
        { name: before.name, description: before.description, filter: before.filter, archived: before.archivedAt !== null },
      );
      return c.json({ data: await listView(db, row!, contactDeps.now(), true) });
    } catch (err) {
      if (pgErrorCode(err) === "23505") refuse(409, "A list with that name already exists.");
      throw err;
    }
  });

  r.post("/lists/:id/members", M, async (c) => {
    const id = uuidParam(c, "id");
    const now = contactDeps.now();
    const body = z
      .object({ customer_ids: IdList(CONTACT_LIMITS.bulkIds).optional(), filter: z.unknown().optional() })
      .strict()
      .parse(await jsonBody(c));
    const [l] = await db.select().from(contactList).where(eq(contactList.id, id));
    if (!l) notFound();
    if (l.kind === "smart") refuse(409, "This list fills itself from its rules. Change the rules instead.", { reason: "kind_smart" });
    if (l.archivedAt) refuse(409, "This list is archived. Bring it back before adding people.");
    const byFilter = body.filter !== undefined && body.filter !== null;
    if (byFilter === !!body.customer_ids?.length) refuse(422, "Send either the people or a filter.");
    const userId = c.get("auth").userId;

    let asked: number;
    let who: SQL;
    if (byFilter) {
      const fw = filterWhere(body.filter, now);
      if (!fw.ok) refuse(422, fw.error);
      await checkFilterList(db, fw.filter);
      asked = await contactCount(db, fw.where);
      if (asked > CONTACT_LIMITS.listAddMax) refuse(422, "That is more than 20,000 contacts. Narrow the filter first.");
      who = sql`SELECT s.customer_id FROM contact_summary s JOIN customer c ON c.id = s.customer_id WHERE (${fw.where})`;
    } else {
      who = sql`SELECT s.customer_id FROM contact_summary s WHERE s.customer_id = ANY(${uuidArray(body.customer_ids!)})`;
      const [n] = (await db.execute(sql`SELECT count(*)::int AS n FROM (${who}) w`)) as unknown as { n: number }[];
      asked = Number(n?.n ?? 0);
    }
    const inserted = (await db.execute(sql`
      INSERT INTO contact_list_member (list_id, customer_id, added_by)
      SELECT ${id}::uuid, w.customer_id, ${userId}::uuid FROM (${who}) w
      ON CONFLICT DO NOTHING RETURNING customer_id
    `)) as unknown as unknown[];
    await db.update(contactList).set({ updatedAt: new Date() }).where(eq(contactList.id, id));
    const added = inserted.length;
    const already = Math.max(0, asked - added);
    await audit(c, "contacts.list_add", "contact_list", id, { name: l.name, added, already, by: byFilter ? "filter" : "ids" });
    return c.json({ data: { added, already } });
  });

  r.delete("/lists/:id/members", M, async (c) => {
    const id = uuidParam(c, "id");
    const body = z.object({ customer_ids: IdList(CONTACT_LIMITS.bulkIds).min(1) }).strict().parse(await jsonBody(c));
    const [l] = await db.select().from(contactList).where(eq(contactList.id, id));
    if (!l) notFound();
    if (l.kind === "smart") refuse(409, "This list fills itself from its rules. Change the rules instead.", { reason: "kind_smart" });
    const rows = await db
      .delete(contactListMember)
      .where(and(eq(contactListMember.listId, id), inArray(contactListMember.customerId, body.customer_ids)))
      .returning({ id: contactListMember.customerId });
    await db.update(contactList).set({ updatedAt: new Date() }).where(eq(contactList.id, id));
    await audit(c, "contacts.list_remove", "contact_list", id, { name: l.name, removed: rows.length });
    return c.json({ data: { removed: rows.length } });
  });

  // ── Download ───────────────────────────────────────────────────────────────

  r.get("/export.csv", V, requireCapability("inbox.export"), async (c) => {
    const now = contactDeps.now();
    const listId = c.req.query("list_id");
    let where: SQL;
    let what: Record<string, unknown>;
    let label: string;
    if (listId) {
      if (!Uuid.safeParse(listId).success) notFound();
      const [l] = await db.select().from(contactList).where(eq(contactList.id, listId));
      if (!l) notFound();
      where = sql`s.customer_id IN (${listMembersSql({ id: l.id, kind: l.kind as "static" | "smart", filter: listFilter(l) }, now)})`;
      what = { list_id: l.id, list: l.name };
      label = `list “${l.name}”`;
    } else {
      const fw = filterWhere(parseFilterQuery(c.req.query("filter")), now);
      if (!fw.ok) refuse(422, fw.error);
      await checkFilterList(db, fw.filter);
      where = fw.where;
      what = { filter: fw.filter };
      const lines = describeContactFilter(fw.filter, await labelNames(db, fw.filter.label_ids));
      label = lines.length ? lines.join(" · ") : "all contacts";
    }
    const total = await contactCount(db, where);
    if (total > CONTACT_LIMITS.exportMaxRows) refuse(422, "That is more than 20,000 contacts. Narrow the filter first.");

    const lines: string[][] = [];
    let cursor: ContactCursor | null = null;
    for (;;) {
      const page = await contactPage(db, where, "name", 500, cursor);
      for (const row of page.contacts) lines.push(exportCells(row));
      if (!page.next_cursor || lines.length > CONTACT_LIMITS.exportMaxRows) break;
      cursor = decodeCursor(page.next_cursor);
      if (!cursor) break;
    }
    // Audited every time with the row count; the owner is told about a big one (rule R7).
    await audit(
      c,
      "contacts.export",
      "contacts",
      "export",
      { rows: lines.length, ...what, name: `${lines.length} contacts downloaded (${label})`.slice(0, 200) },
      undefined,
      lines.length > CONTACT_LIMITS.exportAlertRows,
    );
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="contacts.csv"');
    c.header("cache-control", "no-store");
    return c.body(toCsv(EXPORT_HEADER, lines));
  });

  // ── Import ─────────────────────────────────────────────────────────────────

  /** Only the person who uploaded an import, or the owner, may look at it or act on it (rule R16). */
  const ownImport = async (c: Context, id: string) => {
    const [imp] = await db.select().from(contactImport).where(eq(contactImport.id, id));
    if (!imp) notFound();
    const auth = c.get("auth");
    if (imp.createdBy !== auth.userId && auth.role !== "owner") refuse(403, "Only the person who uploaded this file, or the owner, can do that.");
    return imp;
  };

  const importRows = async (importId: string, opts: { outcome?: string | undefined; afterRow?: number; limit: number; rejectedFirst?: boolean }) => {
    const rows = await db
      .select({
        row_no: contactImportRow.rowNo,
        name: contactImportRow.name,
        phone: contactImportRow.phoneE164,
        email: contactImportRow.email,
        address: contactImportRow.address,
        outcome: contactImportRow.outcome,
        reason: contactImportRow.reason,
        matched_name: customer.name,
      })
      .from(contactImportRow)
      .leftJoin(customer, eq(customer.id, contactImportRow.customerId))
      .where(
        and(
          eq(contactImportRow.importId, importId),
          ...(opts.outcome ? [eq(contactImportRow.outcome, opts.outcome)] : []),
          ...(opts.afterRow !== undefined ? [gt(contactImportRow.rowNo, opts.afterRow)] : []),
        ),
      )
      .orderBy(...(opts.rejectedFirst ? [sql`(${contactImportRow.outcome} = 'rejected') desc`] : []), asc(contactImportRow.rowNo))
      .limit(opts.limit);
    return rows.map(
      (x): ImportRowView => ({
        ...x,
        outcome: x.outcome as ImportRowView["outcome"],
        matched_name: x.outcome === "matched" ? x.matched_name : null,
        reason: x.reason ? importReasonText(x.reason) : null,
        reason_code: x.reason ? importReasonCode(x.reason) : null,
      }),
    );
  };

  const importView = (imp: typeof contactImport.$inferSelect) => ({
    id: imp.id,
    filename: imp.filename,
    status: imp.status,
    headers: imp.headers,
    mapping: imp.mapping,
    source_label: imp.sourceLabel,
    customer_source: imp.customerSource,
    consent_declared: imp.consentDeclared,
    fill_blanks: imp.fillBlanks,
    label_id: imp.labelId,
    list_id: imp.listId,
    total_rows: imp.totalRows,
    new: imp.newCount,
    matched: imp.matchedCount,
    rejected: imp.rejectedCount,
    applied_rows: imp.appliedRows,
    error: imp.error,
    created_at: imp.createdAt.toISOString(),
    applied_at: imp.appliedAt ? imp.appliedAt.toISOString() : null,
  });

  r.post("/imports", M, async (c) => {
    const body = z
      .object({ filename: z.string().trim().min(1).max(200), csv_text: z.string().max(CONTACT_LIMITS.importMaxChars) })
      .strict()
      .parse(await jsonBody(c));
    const { headers, rows } = parseCsv(body.csv_text);
    if (headers.length === 0 || headers.every((h) => h === "")) refuse(422, "This file is empty.");
    if (headers.length > CONTACT_LIMITS.importMaxColumns) refuse(422, "This file has more than 40 columns. Remove the ones you don't need.");
    const seen = new Set<string>();
    for (const h of headers) {
      if (h === "") continue;
      const key = h.toLowerCase();
      if (seen.has(key)) refuse(422, `Two columns are both called “${h}”. Rename one.`);
      seen.add(key);
    }
    // Rows whose cells are all blank are dropped and not counted.
    const data = rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
    if (data.length === 0) refuse(422, "This file has column names but no rows.");
    if (data.length > CONTACT_LIMITS.importMaxRows) refuse(422, "This file has more than 5,000 rows. Split it into smaller files.");

    const named = headers.map((h, i) => ({ h, i })).filter((x) => x.h !== "");
    const userId = c.get("auth").userId;
    const imp = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(contactImport)
        .values({ filename: body.filename, headers: named.map((x) => x.h), totalRows: data.length, createdBy: userId })
        .returning();
      for (let i = 0; i < data.length; i += 500) {
        await tx.insert(contactImportRow).values(
          data.slice(i, i + 500).map((cells, j) => ({
            importId: row!.id,
            rowNo: i + j + 1,
            raw: Object.fromEntries(named.map((x) => [x.h, (cells[x.i] ?? "").slice(0, 5000)])),
          })),
        );
      }
      return row!;
    });
    await audit(c, "contacts.import_upload", "contact_import", imp.id, { filename: imp.filename, rows: data.length });
    const headerNames = named.map((x) => x.h);
    return c.json(
      {
        data: {
          id: imp.id,
          headers: headerNames,
          total_rows: data.length,
          sample: data.slice(0, 5).map((cells) => named.map((x) => cells[x.i] ?? "")),
          suggested_mapping: suggestMapping(headerNames),
        },
      },
      201,
    );
  });

  r.post("/imports/:id/preview", M, async (c) => {
    const id = uuidParam(c, "id");
    const imp = await ownImport(c, id);
    if (imp.status !== "uploaded" && imp.status !== "previewed") refuse(409, "This import can no longer be changed.");
    const body = ImportOptions.parse(await jsonBody(c));
    const mapping = body.mapping as ImportMapping;
    const usedHeaders = new Set<string>();
    for (const header of Object.values(mapping)) {
      if (!header) continue;
      if (!imp.headers.includes(header)) refuse(422, `This file has no column called “${header}”.`);
      if (usedHeaders.has(header)) refuse(422, `The column “${header}” is chosen twice. Use each column once.`);
      usedHeaders.add(header);
    }
    if (!mapping.phone && !mapping.email) refuse(422, "Choose the column that holds the phone number or the email.");
    const declared = body.consent_declared === "marketing_whatsapp";
    if (declared) {
      if (!body.consent_method?.trim()) refuse(422, "Say how these people agreed.");
      if (!body.consent_wording?.trim()) refuse(422, "Say what these people were told.");
      if (!body.consent_collected_on) refuse(422, "Say when these people agreed.");
      if (!mapping.phone) refuse(422, "Promotions on WhatsApp need a phone number column.");
    }
    if (body.label_id) {
      const [l] = await db.select({ id: contactLabel.id }).from(contactLabel).where(eq(contactLabel.id, body.label_id));
      if (!l) refuse(422, "That label no longer exists.");
    }
    if (body.list_id) {
      const [l] = await db.select().from(contactList).where(eq(contactList.id, body.list_id));
      if (!l || l.archivedAt) refuse(422, "That list no longer exists.");
      if (l.kind === "smart") refuse(422, "That list fills itself from its rules. Choose a list picked by hand.");
    }
    await db
      .update(contactImport)
      .set({
        mapping: mapping as Record<string, string>,
        sourceLabel: body.source_label,
        customerSource: body.customer_source,
        consentDeclared: body.consent_declared,
        consentMethod: declared ? body.consent_method!.trim() : null,
        consentWording: declared ? body.consent_wording!.trim() : null,
        consentCollectedOn: declared ? body.consent_collected_on! : null,
        fillBlanks: body.fill_blanks,
        labelId: body.label_id ?? null,
        listId: body.list_id ?? null,
      })
      .where(eq(contactImport.id, id));
    const counts = await previewImport(db, id);
    const reasonRows = await db
      .select({ reason: contactImportRow.reason })
      .from(contactImportRow)
      .where(and(eq(contactImportRow.importId, id), eq(contactImportRow.outcome, "rejected")));
    const tally = new Map<string, number>();
    for (const x of reasonRows) {
      const code = importReasonCode(x.reason);
      tally.set(code, (tally.get(code) ?? 0) + 1);
    }
    return c.json({
      data: {
        ...counts,
        rows: await importRows(id, { limit: 200, rejectedFirst: true }),
        reasons: [...tally.entries()].map(([reason, count]) => ({ reason, text: importReasonHeading(reason), count })),
      },
    });
  });

  r.get("/imports/:id", M, async (c) => {
    const id = uuidParam(c, "id");
    const imp = await ownImport(c, id);
    const outcome = c.req.query("outcome");
    if (outcome && !["new", "matched", "rejected", "pending"].includes(outcome)) refuse(400, "That tab isn't one we know.");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const afterText = c.req.query("after_row");
    const afterRow = afterText !== undefined && /^\d{1,9}$/.test(afterText) ? Number(afterText) : undefined;
    const rows = await importRows(id, { outcome, limit, ...(afterRow !== undefined ? { afterRow } : {}) });
    return c.json({ data: { ...importView(imp), rows } });
  });

  r.post("/imports/:id/apply", M, async (c) => {
    const id = uuidParam(c, "id");
    const imp = await ownImport(c, id);
    const body = z
      .object({ confirm: z.literal(true), expect_new: z.number().int().min(0), expect_matched: z.number().int().min(0) })
      .strict()
      .parse(await jsonBody(c));
    if (imp.status === "applying" || imp.status === "applied") refuse(409, "This import is already being saved.");
    if (imp.status !== "previewed") refuse(409, "Check the import first.");
    if (imp.newCount !== body.expect_new || imp.matchedCount !== body.expect_matched) {
      refuse(409, "The preview is out of date. Check it again.", { reason: "changed", new: imp.newCount, matched: imp.matchedCount });
    }
    if (imp.newCount + imp.matchedCount === 0) refuse(409, "There is nothing to import in this file.");
    const [queued] = await db
      .update(contactImport)
      .set({ status: "applying" })
      .where(and(eq(contactImport.id, id), eq(contactImport.status, "previewed")))
      .returning({ id: contactImport.id });
    if (!queued) refuse(409, "This import is already being saved.");
    await audit(
      c,
      "contacts.import_apply",
      "contacts",
      id,
      {
        name: `“${imp.filename}”: ${imp.newCount} new, ${imp.matchedCount} already contacts`.slice(0, 200),
        filename: imp.filename,
        source_label: imp.sourceLabel,
        new: imp.newCount,
        matched: imp.matchedCount,
        rejected: imp.rejectedCount,
        consent_declared: imp.consentDeclared,
        fill_blanks: imp.fillBlanks,
      },
      undefined,
      true,
    );
    return c.json({ data: { queued: true } }, 202);
  });

  r.post("/imports/:id/cancel", M, async (c) => {
    const id = uuidParam(c, "id");
    await ownImport(c, id);
    const [row] = await db
      .update(contactImport)
      .set({ status: "cancelled" })
      .where(and(eq(contactImport.id, id), inArray(contactImport.status, ["uploaded", "previewed"])))
      .returning({ id: contactImport.id });
    if (!row) refuse(409, "This import is already being saved and can't be cancelled.");
    await audit(c, "contacts.import_cancel", "contact_import", id);
    return c.json({ data: { cancelled: true } });
  });

  // ── Settings: the STOP and START replies ───────────────────────────────────

  r.get("/settings", V, async (c) => c.json({ data: await loadContactSettings(db) }));

  r.put("/settings", M, async (c) => {
    const body: ContactSettings = SettingsBody.parse(await jsonBody(c));
    const before = await loadContactSettings(db);
    const userId = c.get("auth").userId;
    await db
      .insert(appSetting)
      .values({ key: CONTACT_SETTINGS_KEY, value: body, updatedBy: userId })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: body, updatedBy: userId, updatedAt: new Date() } });
    await audit(c, "contacts.settings", "app_settings", CONTACT_SETTINGS_KEY, body, before);
    return c.json({ data: await loadContactSettings(db) });
  });

  // ── One contact (declared after every fixed path) ──────────────────────────

  r.post("/", M, async (c) => {
    const body = CreateBody.parse(await jsonBody(c));
    const name = (body.name ?? "").trim();
    if (name.length > CONTACT_LIMITS.name) refuse(422, "That name is too long.");
    if ((body.address ?? "").trim().length > CONTACT_LIMITS.address) refuse(422, "That address is too long.");
    if ((body.notes ?? "").length > CONTACT_LIMITS.notes) refuse(422, "Those notes are too long.");
    const wantsConsent = !!body.consent;
    if (wantsConsent && !body.consent!.wording.trim()) refuse(422, "Say what the customer agreed to.");
    if (wantsConsent && !(body.phone ?? "").trim()) refuse(422, "Add a phone number to record promotions on WhatsApp.");
    const userId = c.get("auth").userId;

    let result: { customerId: string; created: boolean; matchedBy: "phone" | "email" | null; consentRecorded: boolean; stopped: boolean };
    try {
      result = await db.transaction(async (tx) => {
        const found = await findOrCreateContact(tx, {
          name,
          phone: body.phone ?? null,
          email: body.email ?? null,
          address: body.address ?? null,
          notes: body.notes ?? null,
          customerSource: body.customer_source,
          origin: "manual",
          sourceLabel: body.source_label ?? null,
          createdBy: userId,
        });
        // A "stop" always wins: a yes typed into this form never lifts one (use Record consent for that).
        const stopped = found.carriedStop || (await whatsappMarketingConsent(tx, found.customerId))?.state === "withdrawn";
        let consentRecorded = false;
        if (wantsConsent && !stopped) {
          consentRecorded = await recordConsent(tx, found.customerId, {
            channel: "whatsapp",
            purpose: "marketing",
            state: "granted",
            method: "staff",
            wording: body.consent!.wording.trim(),
            note: body.consent!.method_note?.trim() || null,
            collectedOn: body.consent!.collected_on ?? lagosToday(contactDeps.now()),
            recordedBy: userId,
          });
        }
        await refreshContactSummary(tx, [found.customerId]);
        return { customerId: found.customerId, created: found.created, matchedBy: found.matchedBy, consentRecorded, stopped };
      });
    } catch (err) {
      if (err instanceof ContactInputError) refuse(422, err.message, { reason: err.code });
      throw err;
    }
    const [now] = await db.select().from(customer).where(eq(customer.id, result.customerId));
    // An existing person is returned untouched, so there is nothing to audit for them
    // unless their consent was recorded.
    if (result.created) {
      await audit(c, "contacts.create", "customer", result.customerId, {
        created: true,
        consent_recorded: result.consentRecorded,
        name: now?.name,
        phone: now?.phone,
        email: now?.email,
        address: now?.defaultAddress,
        source: now?.source,
        source_label: body.source_label ?? null,
      });
    } else if (result.consentRecorded) {
      await audit(
        c,
        "contacts.consent",
        "customer",
        result.customerId,
        { channel: "whatsapp", purpose: "marketing", state: "granted", from: "add_contact" },
        { state: "not_asked" },
      );
    }
    const data = {
      id: result.customerId,
      created: result.created,
      ...(result.created ? {} : { matched_by: result.matchedBy }),
      name: now?.name ?? null,
      consent_recorded: result.consentRecorded,
      stopped: result.stopped,
    };
    return c.json({ data }, result.created ? 201 : 200);
  });

  r.get("/:id", V, async (c) => {
    const found = await detailOr404(c, c.req.param("id"));
    if (found.kind === "merged") return c.json({ data: { merged_into: found.into } });
    return c.json({ data: found.detail });
  });

  r.patch("/:id", M, async (c) => {
    const id = uuidParam(c, "id");
    const body = PatchBody.parse(await jsonBody(c));
    const next: { name?: string; email?: string | null; defaultAddress?: string | null; notes?: string | null } = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) refuse(422, "Enter a name.");
      if (name.length > CONTACT_LIMITS.name) refuse(422, "That name is too long.");
      next.name = name;
    }
    if (body.email !== undefined) {
      const email = normaliseContactEmail(body.email);
      if (email === undefined) refuse(422, "That email doesn't look right.");
      next.email = email;
    }
    if (body.address !== undefined) {
      const address = (body.address ?? "").trim();
      if (address.length > CONTACT_LIMITS.address) refuse(422, "That address is too long.");
      // Blank becomes null, which makes the last delivery address show again.
      next.defaultAddress = address || null;
    }
    if (body.notes !== undefined) {
      if ((body.notes ?? "").length > CONTACT_LIMITS.notes) refuse(422, "Those notes are too long.");
      next.notes = body.notes === null || body.notes.trim() === "" ? null : body.notes;
    }

    const change = await db.transaction(async (tx) => {
      const cur = await liveContact(tx, id, true);
      if (!cur) return null;
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      const set: Partial<typeof customer.$inferInsert> = {};
      if (next.name !== undefined && next.name !== cur.name) {
        before.name = cur.name;
        after.name = next.name;
        set.name = next.name;
      }
      if (next.email !== undefined && next.email !== cur.email) {
        before.email = cur.email;
        after.email = next.email;
        set.email = next.email;
      }
      if (next.defaultAddress !== undefined && next.defaultAddress !== cur.defaultAddress) {
        before.address = cur.defaultAddress;
        after.address = next.defaultAddress;
        set.defaultAddress = next.defaultAddress;
      }
      if (next.notes !== undefined && next.notes !== cur.notes) {
        before.notes = cur.notes;
        after.notes = next.notes;
        set.notes = next.notes;
      }
      if (Object.keys(set).length === 0) return { before, after, changed: false };
      await tx.update(customer).set({ ...set, updatedAt: new Date() }).where(eq(customer.id, id));
      await refreshContactSummary(tx, [id]);
      return { before, after, changed: true };
    });
    if (!change) notFound();
    // A body that changes nothing writes no audit row (rule R10).
    if (change.changed) await audit(c, "contacts.update", "customer", id, change.after, change.before);
    const found = await detailOr404(c, id);
    if (found.kind !== "contact") notFound();
    return c.json({ data: found.detail });
  });

  r.get("/:id/history", V, async (c) => {
    const id = uuidParam(c, "id");
    const [cust] = await db.select({ id: customer.id, deletedAt: customer.deletedAt }).from(customer).where(eq(customer.id, id));
    if (!cust || cust.deletedAt) notFound();
    const consentRows = await db
      .select({ k: contactConsent, byName: adminUser.name, byEmail: adminUser.email })
      .from(contactConsent)
      .leftJoin(adminUser, eq(adminUser.id, contactConsent.recordedBy))
      .where(eq(contactConsent.customerId, id))
      .orderBy(desc(contactConsent.recordedAt), desc(contactConsent.isCurrent))
      .limit(200);
    const consent: ConsentRow[] = consentRows.map(({ k, byName, byEmail }) => ({
      id: k.id,
      channel: k.channel as ConsentRow["channel"],
      purpose: k.purpose as ConsentRow["purpose"],
      state: k.state as ConsentRow["state"],
      method: k.method as ConsentRow["method"],
      wording: k.wording,
      note: k.note,
      collected_on: k.collectedOn,
      recorded_at: k.recordedAt.toISOString(),
      recorded_by_name: byName ?? byEmail ?? null,
      is_current: k.isCurrent,
    }));
    const editRows = await db
      .select({ a: auditLog, byName: adminUser.name, byEmail: adminUser.email })
      .from(auditLog)
      .leftJoin(adminUser, eq(adminUser.id, auditLog.actorUserId))
      .where(
        and(
          eq(auditLog.entityType, "customer"),
          eq(auditLog.entityId, id),
          inArray(auditLog.action, [
            "contacts.update",
            "contacts.create",
            "contacts.import_fill",
            "inbox.contact_update",
            "inbox.contact_merge",
            "inbox.contact_erase",
          ]),
        ),
      )
      .orderBy(desc(auditLog.occurredAt))
      .limit(100);
    const FIELDS = ["name", "email", "address", "notes"];
    const edits = editRows.map(({ a, byName, byEmail }) => ({
      at: a.occurredAt.toISOString(),
      by_name: byName ?? byEmail ?? null,
      action: a.action,
      changed: FIELDS.filter((k) => k in ((a.afterJson ?? {}) as Record<string, unknown>)),
    }));
    return c.json({ data: { consent, edits } });
  });

  r.post("/:id/consent", M, async (c) => {
    const id = uuidParam(c, "id");
    const body = ConsentBody.parse(await jsonBody(c));
    const wording = body.wording?.trim() || null;
    if (body.state === "granted" && !wording) refuse(422, "Say what the customer agreed to.");
    const userId = c.get("auth").userId;
    const outcome = await db.transaction(async (tx) => {
      const cur = await liveContact(tx, id, true);
      if (!cur) return null;
      const [current] = await tx
        .select({ state: contactConsent.state, method: contactConsent.method })
        .from(contactConsent)
        .where(
          and(
            eq(contactConsent.customerId, id),
            eq(contactConsent.channel, body.channel),
            eq(contactConsent.purpose, body.purpose),
            eq(contactConsent.isCurrent, true),
          ),
        );
      // Lifting a stop is the one change that needs a person to say the customer asked for it (rule R26).
      if (current?.state === "withdrawn" && body.state === "granted" && body.asked_again !== true) return { needsTick: true as const };
      const changed = await recordConsent(tx, id, {
        channel: body.channel,
        purpose: body.purpose,
        state: body.state,
        method: "staff",
        wording,
        note: body.note?.trim() || null,
        collectedOn: body.collected_on ?? (body.state === "granted" ? lagosToday(contactDeps.now()) : null),
        recordedBy: userId,
      });
      return { needsTick: false as const, changed, before: current ?? null };
    });
    if (!outcome) notFound();
    if (outcome.needsTick) {
      refuse(409, "This customer asked us to stop. Only change this if they have clearly asked to get promotions again, and tick the box to say so.", {
        reason: "stopped",
      });
    }
    if (outcome.changed) {
      await audit(
        c,
        "contacts.consent",
        "customer",
        id,
        { channel: body.channel, purpose: body.purpose, state: body.state, lifted_a_stop: outcome.before?.state === "withdrawn" && body.state === "granted" },
        outcome.before ? { state: outcome.before.state, method: outcome.before.method } : { state: "not_asked" },
      );
    }
    return c.json({ data: { changed: outcome.changed, consent_now: await consentNow(db, id) } });
  });

  r.put("/:id/labels", M, async (c) => {
    const id = uuidParam(c, "id");
    const body = z.object({ label_ids: IdList(CONTACT_LIMITS.labelsPerContact) }).strict().parse(await jsonBody(c));
    const wanted = [...new Set(body.label_ids)];
    const userId = c.get("auth").userId;
    const result = await db.transaction(async (tx) => {
      const cur = await liveContact(tx, id, true);
      if (!cur) return null;
      const known = wanted.length ? await tx.select({ id: contactLabel.id }).from(contactLabel).where(inArray(contactLabel.id, wanted)) : [];
      if (known.length !== wanted.length) return { missing: true as const };
      const before = (await tx.select({ id: contactLabelMember.labelId }).from(contactLabelMember).where(eq(contactLabelMember.customerId, id))).map((x) => x.id);
      const drop = before.filter((x) => !wanted.includes(x));
      const add = wanted.filter((x) => !before.includes(x));
      if (drop.length) {
        await tx.delete(contactLabelMember).where(and(eq(contactLabelMember.customerId, id), inArray(contactLabelMember.labelId, drop)));
      }
      if (add.length) {
        await tx.insert(contactLabelMember).values(add.map((labelId) => ({ customerId: id, labelId, addedBy: userId }))).onConflictDoNothing();
      }
      return { missing: false as const, before, changed: drop.length + add.length > 0 };
    });
    if (!result) notFound();
    if (result.missing) refuse(422, "One of those labels no longer exists.");
    if (result.changed) await audit(c, "contacts.labels", "customer", id, { label_ids: wanted }, { label_ids: result.before });
    const labels = await db
      .select({ id: contactLabel.id, name: contactLabel.name, colour: contactLabel.colour })
      .from(contactLabelMember)
      .innerJoin(contactLabel, eq(contactLabel.id, contactLabelMember.labelId))
      .where(eq(contactLabelMember.customerId, id))
      .orderBy(contactLabel.nameKey);
    return c.json({ data: labels });
  });

  return r;
}
