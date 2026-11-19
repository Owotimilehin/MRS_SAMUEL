/**
 * What the inbox's contact MERGE and ERASE do to the contact_ tables (suite
 * spec 14, section 5.6; foundation ruling 9.2.8). Both run inside the route's
 * own transaction, after the identities have moved or gone.
 *
 * Neither touches a `customer` row. A "stopped" record survives both: in a
 * merge a stop on either side wins, and an erase keeps (or makes) one.
 *
 * PHASE B adds its broadcast_recipient steps here (5.6 merge step 7, erase step 4).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  contactAlias,
  contactConsent,
  contactImportRow,
  contactLabelMember,
  contactListMember,
  contactOrigin,
  contactSummary,
  type DbExecutor,
} from "@ms/db";
import { recordConsent, refreshContactSummary } from "@ms/domain";

/** The same lock recordConsent takes, so a STOP arriving mid-merge waits its turn. */
async function lockConsent(tx: DbExecutor, customerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`contact-consent:${customerId}`}))`);
}

/** Merge `fromId` (F) into `intoId` (T). Returns how many labels and lists moved. */
export async function mergeContactTables(
  tx: DbExecutor,
  fromId: string,
  intoId: string,
  userId: string | null,
): Promise<{ movedLabels: number; movedLists: number }> {
  // 1. Labels: T gains F's; F keeps none.
  const labels = (await tx.execute(sql`
    INSERT INTO contact_label_member (customer_id, label_id, added_by, added_at)
    SELECT ${intoId}::uuid, label_id, added_by, added_at FROM contact_label_member WHERE customer_id = ${fromId}::uuid
    ON CONFLICT DO NOTHING RETURNING label_id
  `)) as unknown as unknown[];
  await tx.delete(contactLabelMember).where(eq(contactLabelMember.customerId, fromId));

  // 2. Lists: the same.
  const lists = (await tx.execute(sql`
    INSERT INTO contact_list_member (list_id, customer_id, added_by, added_at)
    SELECT list_id, ${intoId}::uuid, added_by, added_at FROM contact_list_member WHERE customer_id = ${fromId}::uuid
    ON CONFLICT DO NOTHING RETURNING list_id
  `)) as unknown as unknown[];
  await tx.delete(contactListMember).where(eq(contactListMember.customerId, fromId));

  // 3. Consent. For each channel and purpose F has a record for: the histories join, and
  //    one row is made current. A "stop" on either side always wins. Nothing new is inserted.
  for (const id of [fromId, intoId].sort()) await lockConsent(tx, id);
  const pairs = await tx
    .selectDistinct({ channel: contactConsent.channel, purpose: contactConsent.purpose })
    .from(contactConsent)
    .where(eq(contactConsent.customerId, fromId));
  for (const pair of pairs) {
    const ofPair = and(eq(contactConsent.channel, pair.channel), eq(contactConsent.purpose, pair.purpose));
    const current = await tx
      .select({ state: contactConsent.state })
      .from(contactConsent)
      .where(and(inArray(contactConsent.customerId, [fromId, intoId]), ofPair, eq(contactConsent.isCurrent, true)));
    const stopWins = current.some((r) => r.state === "withdrawn");
    await tx
      .update(contactConsent)
      .set({ isCurrent: false })
      .where(and(inArray(contactConsent.customerId, [fromId, intoId]), ofPair));
    await tx.update(contactConsent).set({ customerId: intoId }).where(and(eq(contactConsent.customerId, fromId), ofPair));
    const [winner] = await tx
      .select({ id: contactConsent.id })
      .from(contactConsent)
      .where(and(eq(contactConsent.customerId, intoId), ofPair, eq(contactConsent.state, stopWins ? "withdrawn" : "granted")))
      .orderBy(desc(contactConsent.recordedAt))
      .limit(1);
    if (winner) await tx.update(contactConsent).set({ isCurrent: true }).where(eq(contactConsent.id, winner.id));
  }

  // 4. Import rows now point at the kept contact.
  await tx.update(contactImportRow).set({ customerId: intoId }).where(eq(contactImportRow.customerId, fromId));

  // 5. Origin: T keeps its own; otherwise it takes F's.
  const [targetOrigin] = await tx.select({ id: contactOrigin.customerId }).from(contactOrigin).where(eq(contactOrigin.customerId, intoId));
  if (targetOrigin) {
    await tx.delete(contactOrigin).where(eq(contactOrigin.customerId, fromId));
  } else {
    await tx.update(contactOrigin).set({ customerId: intoId }).where(eq(contactOrigin.customerId, fromId));
  }

  // 6. Alias: anything merged into F earlier now points at T; F itself becomes an alias of T.
  await tx.update(contactAlias).set({ intoCustomerId: intoId }).where(eq(contactAlias.intoCustomerId, fromId));
  await tx
    .insert(contactAlias)
    .values({ customerId: fromId, intoCustomerId: intoId, createdBy: userId })
    .onConflictDoUpdate({ target: contactAlias.customerId, set: { intoCustomerId: intoId } });

  // 8. F leaves the Contacts page; its orders now count under T.
  await refreshContactSummary(tx, [fromId, intoId]);
  return { movedLabels: labels.length, movedLists: lists.length };
}

/** Erase a contact's labels, lists, origin and import details. Returns how many labels and lists went. */
export async function eraseContactTables(tx: DbExecutor, customerId: string): Promise<{ labels: number; lists: number }> {
  // 1. Labels, lists and where they came from.
  const labels = await tx.delete(contactLabelMember).where(eq(contactLabelMember.customerId, customerId)).returning({ id: contactLabelMember.labelId });
  const lists = await tx.delete(contactListMember).where(eq(contactListMember.customerId, customerId)).returning({ id: contactListMember.listId });
  await tx.delete(contactOrigin).where(eq(contactOrigin.customerId, customerId));

  // 2. What an import uploaded about them.
  await tx
    .update(contactImportRow)
    .set({ raw: {}, name: null, phoneE164: null, email: null, address: null, notes: null, filled: null })
    .where(eq(contactImportRow.customerId, customerId));

  // 3. Consent. A person who asks to be deleted must never get a promotion, so they are
  //    marked as stopped (a no-op if they already are). THE "STOP" ITSELF IS KEPT ON PURPOSE:
  //    it is the one fact that must outlive the erase. Everything else about their consent
  //    goes, and the kept row loses its wording and note.
  await recordConsent(tx, customerId, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "erase_request" });
  await tx
    .delete(contactConsent)
    .where(and(eq(contactConsent.customerId, customerId), sql`not (${contactConsent.isCurrent} and ${contactConsent.state} = 'withdrawn')`));
  await tx
    .update(contactConsent)
    .set({ wording: null, note: null, confirmState: "none" })
    .where(eq(contactConsent.customerId, customerId));

  // 5. The customer row stays (the shop's record), so they remain a contact, marked stopped.
  await tx.update(contactSummary).set({ waUnreachableAt: null }).where(eq(contactSummary.customerId, customerId));
  await refreshContactSummary(tx, [customerId]);
  return { labels: labels.length, lists: lists.length };
}
