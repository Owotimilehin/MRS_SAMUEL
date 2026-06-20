import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { assertNonProdDb } from "@ms/db";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Gate test for the 0052 journal-timestamp fix.
 *
 * Prod's migrator only applies a journal entry if its `when` (folderMillis)
 * is greater than the max created_at already recorded in
 * drizzle.__drizzle_migrations. Migration 0052_shift_open originally had a
 * `when` BELOW the watermark set by 0051, so the real migrator silently
 * skipped it -- shift_open was never created on prod, and 0053 then failed
 * ("relation shift_open does not exist").
 *
 * This test reproduces prod's exact state (migrated through 0051 only,
 * watermark 1782900000000, shift_open absent) against a real Postgres
 * testcontainer, then re-runs the migrator pointed at the REAL (fixed)
 * migrations folder and proves 0052 + 0053 now apply.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");

describe("0052_shift_open journal timestamp fix is picked up by the migrator", () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let tempMigrationsFolder: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    url = container.getConnectionUri();
    assertNonProdDb(url);

    // Build a temp copy of the migrations folder whose journal is truncated
    // to idx 0..50 (0000_..._the_hunter .. 0051_admin_user_name), i.e.
    // prod's exact applied state BEFORE 0052/0053 exist at all.
    tempMigrationsFolder = fs.mkdtempSync(path.join(os.tmpdir(), "ms-migrations-prod-state-"));
    fs.mkdirSync(path.join(tempMigrationsFolder, "meta"), { recursive: true });

    const journalRaw = fs.readFileSync(
      path.join(realMigrationsFolder, "meta", "_journal.json"),
      "utf8",
    );
    const journal = JSON.parse(journalRaw) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const truncatedEntries = journal.entries.filter((e) => e.idx <= 50);
    expect(truncatedEntries).toHaveLength(51); // idx 0..50 inclusive
    expect(truncatedEntries.at(-1)?.tag).toBe("0051_admin_user_name");
    expect(truncatedEntries.at(-1)?.when).toBe(1782900000000);

    fs.writeFileSync(
      path.join(tempMigrationsFolder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: truncatedEntries }, null, 2),
    );

    // Copy the .sql files referenced by the truncated journal.
    for (const entry of truncatedEntries) {
      const sqlFile = `${entry.tag}.sql`;
      fs.copyFileSync(
        path.join(realMigrationsFolder, sqlFile),
        path.join(tempMigrationsFolder, sqlFile),
      );
    }
  }, 120_000);

  afterAll(async () => {
    await container.stop();
    fs.rmSync(tempMigrationsFolder, { recursive: true, force: true });
  });

  it("step 1: migrating the truncated (prod-state) folder stops at 0051 -- shift_open absent, watermark 1782900000000", async () => {
    const sql = postgres(url, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: tempMigrationsFolder });

    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('shift_open', 'shift_open_stock_count')
    `;
    expect(tables).toHaveLength(0);

    const watermark = await sql`
      select max(created_at) as max_created_at, count(*)::int as n
      from drizzle.__drizzle_migrations
    `;
    expect(Number(watermark[0]?.max_created_at)).toBe(1782900000000);
    expect(watermark[0]?.n).toBe(51);

    await sql.end();
  });

  it("step 2: migrating the REAL fixed folder on top now applies 0052 + 0053 -- shift_open present, columns/index exist, 53 rows total", async () => {
    const sql = postgres(url, { max: 1 });

    // This is the exact call prod's startup performs. Prior to the fix,
    // running this against a db sitting at watermark 1782900000000 would
    // silently skip 0052 (when=1781876921730 < 1782900000000) and then
    // crash on 0053 ("relation shift_open does not exist"). It must now
    // succeed cleanly.
    await expect(
      migrate(drizzle(sql), { migrationsFolder: realMigrationsFolder }),
    ).resolves.not.toThrow();

    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('shift_open', 'shift_open_stock_count')
      order by table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual(["shift_open", "shift_open_stock_count"]);

    const shiftOpenCols = await sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'shift_open'
      and column_name in ('status', 'closed_at', 'closed_by_user_id', 'shift_number')
    `;
    expect(new Set(shiftOpenCols.map((c) => c.column_name))).toEqual(
      new Set(["status", "closed_at", "closed_by_user_id", "shift_number"]),
    );

    const dailyCloseCols = await sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'daily_close' and column_name = 'shift_id'
    `;
    expect(dailyCloseCols).toHaveLength(1);

    const indexes = await sql`
      select indexname from pg_indexes
      where schemaname = 'public' and indexname = 'uq_shift_open_one_open_per_branch'
    `;
    expect(indexes).toHaveLength(1);

    const finalState = await sql`
      select max(created_at) as max_created_at, count(*)::int as n
      from drizzle.__drizzle_migrations
    `;
    expect(finalState[0]?.n).toBe(53);
    expect(Number(finalState[0]?.max_created_at)).toBe(1782950000000);

    await sql.end();
  });

  it("step 3 (strong check): partial unique index enforces one open shift per branch", async () => {
    const sql = postgres(url, { max: 1 });

    const [branch] = await sql`
      insert into branch (name, code) values ('Test Branch', 'TST') returning id
    `;
    const branchId = branch?.id as string;
    expect(branchId).toBeTruthy();

    await sql`
      insert into shift_open (branch_id, business_date, status)
      values (${branchId}, current_date, 'open')
    `;

    await expect(
      sql`
        insert into shift_open (branch_id, business_date, status)
        values (${branchId}, current_date + 1, 'open')
      `,
    ).rejects.toThrow();

    await sql.end();
  });
});
