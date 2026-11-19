/**
 * Adding contacts by hand and from a spreadsheet (suite spec 14, rules R13 to
 * R22).
 *
 * The shop's customer data is precious, so the rules here are strict:
 *  - A person who already exists is found with matchCustomerForPhone, the very
 *    function the inbox uses, and is returned untouched.
 *  - An import never overwrites a value that exists. With "fill blanks" on it
 *    may set a name, email or address that is empty, and records what it set.
 *  - No customer row is ever deleted. No WhatsApp identity is written: we do
 *    not know the number is on WhatsApp.
 *  - A "stopped" record outlives the customer record it was made on (R14).
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLog,
  contactImport,
  contactImportRow,
  contactLabelMember,
  contactListMember,
  contactOrigin,
  customer,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  buildImportRow,
  contactPhoneDigits,
  importReason,
  normaliseContactEmail,
  toE164,
  type CustomerSourceValue,
  type ImportMapping,
} from "@ms/shared";
import { matchCustomerForPhone } from "../inbox/core.js";
import { recordConsent, resolveContactId, whatsappMarketingConsent } from "./consent.js";
import { refreshContactSummary } from "./summary.js";

/** A contact that cannot be created as given. `message` is plain English for the screen. */
export class ContactInputError extends Error {
  constructor(
    public readonly code: "bad_phone" | "bad_email" | "no_contact",
    message: string,
  ) {
    super(message);
    this.name = "ContactInputError";
  }
}

export interface FindOrCreateContactInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  customerSource: CustomerSourceValue;
  origin: "manual" | "import";
  importId?: string | null;
  sourceLabel?: string | null;
  createdBy: string | null;
}

function blankToNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

/**
 * Is there a kept "stop" for this number on any OTHER customer record, deleted
 * or not (rule R14)? Looks only at records that hold a current withdrawal.
 */
export async function numberHasKeptStop(db: DbExecutor, e164: string, exceptCustomerId?: string | null): Promise<boolean> {
  const digits = contactPhoneDigits(e164);
  if (!digits) return false;
  const rows = (await db.execute(sql`
    SELECT 1 AS hit FROM contact_consent k JOIN customer c ON c.id = k.customer_id
    WHERE k.is_current AND k.channel = 'whatsapp' AND k.purpose = 'marketing' AND k.state = 'withdrawn'
      AND regexp_replace(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), '^(234|0)', '') = ${digits}
      ${exceptCustomerId ? sql`AND c.id <> ${exceptCustomerId}::uuid` : sql``}
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** The oldest live customer with this email (already trimmed and lower-cased). */
async function matchCustomerByEmail(db: DbExecutor, email: string): Promise<{ id: string; name: string | null } | null> {
  const [row] = await db
    .select({ id: customer.id, name: customer.name })
    .from(customer)
    .where(and(isNull(customer.deletedAt), sql`lower(btrim(${customer.email})) = ${email}`))
    .orderBy(asc(customer.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Create a contact by hand or from an import row, or return the match (rule
 * R13). Runs inside a transaction (the per-number lock is the one the inbox
 * uses, so an import and a webhook at the same moment cannot make a duplicate).
 *
 * With a phone: matchCustomerForPhone; a match is returned untouched. With no
 * phone but an email: the oldest live customer with that email. No match: a
 * new customer and a contact_origin row. `carriedStop` is true when the new
 * contact inherited a "stop" from an earlier record of the same number; the
 * caller must then ignore any "agreed" declared in the same request.
 */
export async function findOrCreateContact(
  db: DbExecutor,
  input: FindOrCreateContactInput,
): Promise<{ customerId: string; created: boolean; matchedBy: "phone" | "email" | null; carriedStop: boolean }> {
  const rawPhone = blankToNull(input.phone);
  const e164 = rawPhone ? toE164(rawPhone) : null;
  if (rawPhone && !e164) {
    throw new ContactInputError("bad_phone", "That phone number doesn't look right. Use a number like 0803 123 4567.");
  }
  const email = normaliseContactEmail(input.email);
  if (email === undefined) throw new ContactInputError("bad_email", "That email doesn't look right.");
  if (!e164 && !email) throw new ContactInputError("no_contact", "Add a phone number or an email.");

  if (e164) {
    const match = await matchCustomerForPhone(db, e164);
    if (match) return { customerId: await resolveContactId(db, match.id), created: false, matchedBy: "phone", carriedStop: false };
  } else if (email) {
    const match = await matchCustomerByEmail(db, email);
    if (match) return { customerId: await resolveContactId(db, match.id), created: false, matchedBy: "email", carriedStop: false };
  }

  const [row] = await db
    .insert(customer)
    .values({
      name: blankToNull(input.name)?.slice(0, 120) ?? null,
      phone: e164,
      email: email ?? null,
      defaultAddress: blankToNull(input.address)?.slice(0, 500) ?? null,
      notes: blankToNull(input.notes)?.slice(0, 4000) ?? null,
      source: input.customerSource,
    })
    .returning({ id: customer.id });
  const customerId = row!.id;
  await db
    .insert(contactOrigin)
    .values({
      customerId,
      origin: input.origin,
      importId: input.importId ?? null,
      sourceLabel: blankToNull(input.sourceLabel),
      createdBy: input.createdBy,
    })
    .onConflictDoNothing();

  // A stop outlives the record: the same number asked us to stop under an earlier record.
  let carriedStop = false;
  if (e164 && (await numberHasKeptStop(db, e164, customerId))) {
    carriedStop = await recordConsent(db, customerId, {
      channel: "whatsapp",
      purpose: "marketing",
      state: "withdrawn",
      method: "carried_over",
      wording: "Asked us to stop under an earlier record of this number",
    });
  }
  return { customerId, created: true, matchedBy: null, carriedStop };
}

// ── Import: the dry run ──────────────────────────────────────────────────────

const WRITE_BATCH = 500;

interface RowResult {
  row_no: number;
  name: string | null;
  phone_e164: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  outcome: "new" | "matched" | "rejected";
  reason: string | null;
  customer_id: string | null;
}

/**
 * Work out, without touching any customer, what applying this import would do
 * (rules R18 to R21). Writes only to contact_import_row and contact_import. No
 * lock is held between rows: each row's match runs in its own short
 * transaction, because matchCustomerForPhone takes the per-number lock.
 */
export async function previewImport(db: DbClient, importId: string): Promise<{ new: number; matched: number; rejected: number }> {
  const [imp] = await db.select().from(contactImport).where(eq(contactImport.id, importId));
  if (!imp) throw new Error("import not found");
  const mapping = (imp.mapping ?? {}) as ImportMapping;
  const rows = await db
    .select({ rowNo: contactImportRow.rowNo, raw: contactImportRow.raw })
    .from(contactImportRow)
    .where(eq(contactImportRow.importId, importId))
    .orderBy(asc(contactImportRow.rowNo));

  const phoneSeen = new Map<string, number>();
  const emailSeen = new Map<string, number>();
  const results: RowResult[] = [];
  const counts = { new: 0, matched: 0, rejected: 0 };

  for (const r of rows) {
    const d = buildImportRow(r.raw ?? {}, mapping);
    const out: RowResult = {
      row_no: r.rowNo,
      name: d.name,
      phone_e164: d.phone_e164,
      email: d.email,
      address: d.address,
      notes: d.notes,
      outcome: "rejected",
      reason: null,
      customer_id: null,
    };
    const notes: string[] = [];
    const reject = (reason: string) => {
      out.reason = reason;
      counts.rejected++;
      results.push(out);
    };

    if (!d.phone_cell && !d.email_cell) {
      reject(importReason("no_contact"));
      continue;
    }
    if (d.bad_phone && !d.email) {
      reject(importReason("bad_phone", d.phone_cell));
      continue;
    }
    if (d.bad_email && !d.phone_e164) {
      reject(importReason("bad_email", d.email_cell));
      continue;
    }
    if (d.phone_e164) {
      const first = phoneSeen.get(d.phone_e164);
      if (first !== undefined) {
        reject(importReason("duplicate_phone", first));
        continue;
      }
      phoneSeen.set(d.phone_e164, r.rowNo);
    } else if (d.email) {
      const first = emailSeen.get(d.email);
      if (first !== undefined) {
        reject(importReason("duplicate_email", first));
        continue;
      }
      emailSeen.set(d.email, r.rowNo);
    }
    if (d.bad_email) notes.push(importReason("email_dropped", d.email_cell));
    if (d.bad_phone) notes.push(importReason("phone_dropped", d.phone_cell));

    // The same rule the apply step and the inbox use; read only.
    let matchId: string | null = null;
    if (d.phone_e164) {
      const e164 = d.phone_e164;
      const m = await db.transaction((tx) => matchCustomerForPhone(tx, e164));
      matchId = m ? await resolveContactId(db, m.id) : null;
    } else if (d.email) {
      const m = await matchCustomerByEmail(db, d.email);
      matchId = m ? await resolveContactId(db, m.id) : null;
    }

    let stopped = false;
    if (matchId) {
      out.outcome = "matched";
      out.customer_id = matchId;
      notes.unshift(importReason("matched"));
      counts.matched++;
      stopped = (await whatsappMarketingConsent(db, matchId))?.state === "withdrawn";
    } else {
      out.outcome = "new";
      counts.new++;
      if (d.phone_e164 && d.email) {
        const sameEmail = await matchCustomerByEmail(db, d.email);
        if (sameEmail) notes.push(importReason("same_email", sameEmail.name ?? "another contact"));
      }
      if (d.phone_e164) stopped = await numberHasKeptStop(db, d.phone_e164);
    }
    if (stopped) notes.push(importReason("stopped"));
    out.reason = notes.length ? notes.join("\n") : null;
    results.push(out);
  }

  for (let i = 0; i < results.length; i += WRITE_BATCH) {
    const chunk = results.slice(i, i + WRITE_BATCH);
    await db.execute(sql`
      UPDATE contact_import_row r
      SET name = x.name, phone_e164 = x.phone_e164, email = x.email, address = x.address, notes = x.notes,
          outcome = x.outcome, reason = x.reason, customer_id = x.customer_id
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
        AS x(row_no int, name text, phone_e164 text, email text, address text, notes text, outcome text, reason text, customer_id uuid)
      WHERE r.import_id = ${importId}::uuid AND r.row_no = x.row_no AND r.applied_at IS NULL
    `);
  }
  await db
    .update(contactImport)
    .set({
      status: "previewed",
      newCount: counts.new,
      matchedCount: counts.matched,
      rejectedCount: counts.rejected,
      previewedAt: new Date(),
    })
    .where(and(eq(contactImport.id, importId), inArray(contactImport.status, ["uploaded", "previewed"])));
  return counts;
}

// ── Import: applying ─────────────────────────────────────────────────────────

/**
 * Apply up to `size` rows of an import (rule R22; the worker calls this until
 * `done`). One transaction per row, so a bad row cannot undo good ones, and
 * rows already applied are skipped, so running it again after a crash creates
 * nothing twice.
 */
export async function applyImportBatch(db: DbClient, importId: string, size: number): Promise<{ done: boolean; applied: number }> {
  const [imp] = await db.select().from(contactImport).where(eq(contactImport.id, importId));
  if (!imp) throw new Error("import not found");
  const todo = await db
    .select()
    .from(contactImportRow)
    .where(
      and(
        eq(contactImportRow.importId, importId),
        isNull(contactImportRow.appliedAt),
        inArray(contactImportRow.outcome, ["new", "matched"]),
      ),
    )
    .orderBy(asc(contactImportRow.rowNo))
    .limit(size);

  let applied = 0;
  for (const row of todo) {
    const did = await db.transaction(async (tx) => {
      // Claim the row: a second worker (or a re-run) skips it.
      const [mine] = await tx
        .select({ rowNo: contactImportRow.rowNo })
        .from(contactImportRow)
        .where(and(eq(contactImportRow.importId, importId), eq(contactImportRow.rowNo, row.rowNo), isNull(contactImportRow.appliedAt)))
        .for("update", { skipLocked: true });
      if (!mine) return false;

      const found = await findOrCreateContact(tx, {
        name: row.name,
        phone: row.phoneE164,
        email: row.email,
        address: row.address,
        notes: row.notes,
        customerSource: imp.customerSource as CustomerSourceValue,
        origin: "import",
        importId,
        sourceLabel: imp.sourceLabel,
        createdBy: imp.createdBy,
      });
      const customerId = found.customerId;

      // Matched: change nothing, unless asked to fill what is empty. Never overwrite a value that exists.
      let filled: Record<string, string> | null = null;
      if (!found.created && imp.fillBlanks) {
        const [cur] = await tx.select().from(customer).where(eq(customer.id, customerId)).for("update");
        if (cur && cur.deletedAt === null) {
          const blank = (v: string | null) => v === null || v.trim() === "";
          const patch: { name?: string; email?: string; defaultAddress?: string } = {};
          if (blank(cur.name) && row.name) patch.name = row.name;
          if (blank(cur.email) && row.email) patch.email = row.email;
          if (blank(cur.defaultAddress) && row.address) patch.defaultAddress = row.address;
          if (Object.keys(patch).length > 0) {
            await tx.update(customer).set({ ...patch, updatedAt: new Date() }).where(eq(customer.id, customerId));
            filled = {
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.email !== undefined ? { email: patch.email } : {}),
              ...(patch.defaultAddress !== undefined ? { address: patch.defaultAddress } : {}),
            };
            // Every change a person causes to a customer is audited with before and after.
            await tx.insert(auditLog).values({
              actorUserId: imp.createdBy,
              actorRole: null,
              action: "contacts.import_fill",
              entityType: "customer",
              entityId: customerId,
              beforeJson: Object.fromEntries(Object.keys(filled).map((k) => [k, null])),
              afterJson: { ...filled, import_id: importId },
            });
          }
        }
      }

      // Declared consent: only with a phone, and never over a "stop" (recordConsent refuses that too).
      if (imp.consentDeclared === "marketing_whatsapp" && row.phoneE164 && !found.carriedStop) {
        const current = await whatsappMarketingConsent(tx, customerId);
        if (current?.state !== "withdrawn") {
          await recordConsent(tx, customerId, {
            channel: "whatsapp",
            purpose: "marketing",
            state: "granted",
            method: "import",
            wording: imp.consentWording,
            note: imp.consentMethod ? `How they agreed: ${imp.consentMethod}` : null,
            collectedOn: imp.consentCollectedOn,
            recordedBy: imp.createdBy,
            importId,
          });
        }
      }

      if (imp.labelId) {
        await tx.insert(contactLabelMember).values({ customerId, labelId: imp.labelId, addedBy: imp.createdBy }).onConflictDoNothing();
      }
      if (imp.listId) {
        await tx.insert(contactListMember).values({ listId: imp.listId, customerId, addedBy: imp.createdBy }).onConflictDoNothing();
      }

      await tx
        .update(contactImportRow)
        .set({ appliedAt: new Date(), customerId, outcome: found.created ? "new" : "matched", ...(filled ? { filled } : {}) })
        .where(and(eq(contactImportRow.importId, importId), eq(contactImportRow.rowNo, row.rowNo)));
      await tx
        .update(contactImport)
        .set({ appliedRows: sql`${contactImport.appliedRows} + 1` })
        .where(eq(contactImport.id, importId));
      await refreshContactSummary(tx, [customerId]);
      return true;
    });
    if (did) applied++;
  }

  const [left] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM contact_import_row
    WHERE import_id = ${importId}::uuid AND applied_at IS NULL AND outcome IN ('new','matched')
  `)) as unknown as { n: number }[];
  return { done: (left?.n ?? 0) === 0, applied };
}
