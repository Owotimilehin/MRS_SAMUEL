import { eq, and, sql } from "drizzle-orm";
import { recurringExpense, businessExpense, type DbClient } from "@ms/db";

/** Last day of a given Gregorian month. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Materialise today's recurring expense schedules as real business_expense rows.
 *
 * Schedules with day_of_month > the month's actual day count fire on the last
 * day instead (so a "31st" schedule still triggers in February).
 *
 * Dedup is naive: skip insert when a business_expense with the same
 * (expense_date, category_code, amount_ngn, vendor_name) already exists.
 */
export async function sweepRecurringExpenses(
  db: DbClient,
  todayIso: string,
  lagos: { year: number; month: number; day: number },
): Promise<number> {
  const dim = daysInMonth(lagos.year, lagos.month);
  // Active schedules whose day_of_month either matches today, OR exceeds the
  // current month's length and today is the last day.
  const candidates = await db
    .select()
    .from(recurringExpense)
    .where(
      and(
        eq(recurringExpense.active, true),
        sql`(
          ${recurringExpense.dayOfMonth} = ${lagos.day}
          OR (${recurringExpense.dayOfMonth} > ${dim} AND ${lagos.day} = ${dim})
        )`,
        sql`${recurringExpense.startsOn} <= ${todayIso}::date`,
        sql`(${recurringExpense.endsOn} IS NULL OR ${recurringExpense.endsOn} >= ${todayIso}::date)`,
      ),
    );

  let materialised = 0;
  for (const sched of candidates) {
    // Dedup: skip if a matching business_expense already exists today.
    const existing = await db
      .select()
      .from(businessExpense)
      .where(
        and(
          eq(businessExpense.expenseDate, todayIso),
          eq(businessExpense.categoryCode, sched.categoryCode),
          eq(businessExpense.amountNgn, sched.amountNgn),
          sched.vendorName
            ? eq(businessExpense.vendorName, sched.vendorName)
            : sql`${businessExpense.vendorName} IS NULL`,
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;

    await db.insert(businessExpense).values({
      expenseDate: todayIso,
      categoryCode: sched.categoryCode,
      amountNgn: sched.amountNgn,
      vendorName: sched.vendorName,
      description: sched.description,
      reasonNote: sched.reasonNote,
      recordedByUserId: sched.recordedByUserId,
    });
    materialised++;
  }

  return materialised;
}
