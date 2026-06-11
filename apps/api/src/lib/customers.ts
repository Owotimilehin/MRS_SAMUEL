import { eq, and, isNull } from "drizzle-orm";
import { customer, type DbExecutor } from "@ms/db";
import { normalizeNigerianPhone } from "@ms/shared";

type CustomerSource = NonNullable<(typeof customer)["$inferInsert"]["source"]>;

export interface ResolveCustomerInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  defaultAddress?: string | null;
  source: CustomerSource;
}

/**
 * Find-or-create a customer by phone — the single identity rule shared by the
 * POS (`sales.ts`) and online checkout (`public-orders.ts`).
 *
 * Behaviour:
 *  - No name AND no phone → returns null (a fully anonymous walk-up; no row,
 *    matching the previous "only insert when name||phone" guard).
 *  - Phone that normalizes to canonical +234 form → look up an existing,
 *    non-deleted customer with that phone and reuse it, backfilling a name /
 *    email / address only when the stored value is currently empty (we never
 *    overwrite details already on file). Otherwise insert a new row storing the
 *    normalized phone.
 *  - Phone that fails to normalize (a typo) → insert a new row carrying the raw
 *    input; no merge is attempted. This keeps the till from ever erroring on a
 *    bad number — the caller decides whether to pre-validate (online does, and
 *    returns 422 before reaching here; the POS does not).
 *
 * Always called inside the surrounding sale transaction so a new customer and
 * its order commit atomically.
 */
export async function resolveCustomer(
  tx: DbExecutor,
  input: ResolveCustomerInput,
): Promise<string | null> {
  const name = input.name?.trim() || null;
  const rawPhone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  const defaultAddress = input.defaultAddress?.trim() || null;

  if (!name && !rawPhone) return null;

  const normalized = normalizeNigerianPhone(rawPhone);

  if (normalized) {
    const [existing] = await tx
      .select()
      .from(customer)
      .where(and(eq(customer.phone, normalized), isNull(customer.deletedAt)))
      .limit(1);
    if (existing) {
      const patch: Partial<typeof customer.$inferInsert> = {};
      if (!existing.name && name) patch.name = name;
      if (!existing.email && email) patch.email = email;
      if (!existing.defaultAddress && defaultAddress) patch.defaultAddress = defaultAddress;
      if (Object.keys(patch).length > 0) {
        await tx
          .update(customer)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(customer.id, existing.id));
      }
      return existing.id;
    }
  }

  const [created] = await tx
    .insert(customer)
    .values({
      name,
      // Canonical form when valid; raw input otherwise (on record, won't merge).
      phone: normalized ?? rawPhone,
      email,
      defaultAddress,
      source: input.source,
    })
    .returning();
  if (!created) throw new Error("customer insert failed");
  return created.id;
}
