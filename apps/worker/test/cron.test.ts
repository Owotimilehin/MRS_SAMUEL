import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, recurringExpense, businessExpense } from "@ms/db";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");

describe("cron + recurring expense sweeper", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    delete process.env["TELEGRAM_BOT_TOKEN"];
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it("claimCronRun is idempotent: first call true, second call false", async () => {
    const { claimCronRun } = await import("../src/jobs/cron.js");
    const a = await claimCronRun(db, "test_job", "2026-06");
    const b = await claimCronRun(db, "test_job", "2026-06");
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it("sweepRecurringExpenses materialises a today-matching schedule", async () => {
    const { sweepRecurringExpenses } = await import("../src/jobs/recurring-expense-sweeper.js");
    const [sched] = await db
      .insert(recurringExpense)
      .values({
        categoryCode: "rent",
        amountNgn: 120000,
        vendorName: "Landlord A",
        dayOfMonth: 5,
        startsOn: "2026-01-01",
        active: true,
      })
      .returning();
    expect(sched).toBeDefined();

    const todayIso = "2026-06-05";
    const made = await sweepRecurringExpenses(db, todayIso, { year: 2026, month: 6, day: 5 });
    expect(made).toBe(1);

    const rows = await db
      .select()
      .from(businessExpense)
      .where(eq(businessExpense.vendorName, "Landlord A"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.expenseDate).toBe(todayIso);
    expect(rows[0]!.amountNgn).toBe(120000);
  });

  it("sweep is deduped — running twice on the same day produces no duplicate row", async () => {
    const { sweepRecurringExpenses } = await import("../src/jobs/recurring-expense-sweeper.js");
    const todayIso = "2026-06-05";
    const made = await sweepRecurringExpenses(db, todayIso, { year: 2026, month: 6, day: 5 });
    expect(made).toBe(0);

    const rows = await db
      .select()
      .from(businessExpense)
      .where(eq(businessExpense.vendorName, "Landlord A"));
    expect(rows.length).toBe(1);
  });

  it("schedule with day_of_month=31 fires on Feb 28 (last day fallback)", async () => {
    const { sweepRecurringExpenses } = await import("../src/jobs/recurring-expense-sweeper.js");
    await db.insert(recurringExpense).values({
      categoryCode: "utilities",
      amountNgn: 8000,
      vendorName: "Diesel guy",
      dayOfMonth: 31,
      startsOn: "2026-01-01",
      active: true,
    });
    const todayIso = "2026-02-28";
    const made = await sweepRecurringExpenses(db, todayIso, { year: 2026, month: 2, day: 28 });
    expect(made).toBe(1);
  });

  it("inactive schedules are skipped", async () => {
    const { sweepRecurringExpenses } = await import("../src/jobs/recurring-expense-sweeper.js");
    await db.insert(recurringExpense).values({
      categoryCode: "marketing",
      amountNgn: 50000,
      vendorName: "Ad agency",
      dayOfMonth: 10,
      startsOn: "2026-01-01",
      active: false,
    });
    const made = await sweepRecurringExpenses(db, "2026-06-10", { year: 2026, month: 6, day: 10 });
    expect(made).toBe(0);
  });
});
