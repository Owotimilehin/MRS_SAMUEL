/**
 * Regression test: 0053_shift_session.sql must survive pre-existing data
 * where multiple shift_open rows exist per branch with NO daily_close match.
 *
 * Root cause of prod outage:
 *   The old migration ran CREATE UNIQUE INDEX ... WHERE status='open' BEFORE
 *   closing orphaned (no daily_close) shift_open rows. On prod with real data,
 *   multiple rows per branch were still status='open' (the column default after
 *   ALTER TABLE ADD COLUMN), so the unique index creation aborted → transaction
 *   rolled back → migrator exit 1 → outage.
 *
 * This test:
 *   1. Starts a fresh Postgres testcontainer.
 *   2. Applies migrations 0000..0052 ONLY (NOT 0053) using raw SQL files in
 *      journal order — so the shift_open table exists but status column does not.
 *   3. Seeds two shift_open rows for the SAME branch on different dates with
 *      NO daily_close (realistic prod scenario).
 *   4. Applies 0053_shift_session.sql and asserts it does NOT throw.
 *   5. Asserts post-migration invariants:
 *      - Both seeded rows are now status='closed'.
 *      - The partial unique index exists.
 *      - A NEW status='open' row for that branch can be inserted.
 *      - A SECOND status='open' row for that same branch FAILS (unique violation).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const journalPath = path.join(migrationsFolder, "meta/_journal.json");

/** Split a drizzle SQL file on the breakpoint sentinel and execute each chunk. */
async function applyMigrationFile(sql: postgres.Sql, tag: string): Promise<void> {
  const filePath = path.join(migrationsFolder, `${tag}.sql`);
  const contents = fs.readFileSync(filePath, "utf8");
  // drizzle files use '--> statement-breakpoint' as a separator
  const statements = contents
    .split(/--> statement-breakpoint/g)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

describe("migration-0053 tolerates pre-existing multi-open shifts", () => {
  let container: StartedPostgreSqlContainer;
  let sql: postgres.Sql;

  // IDs we'll seed
  let branchId: string;
  let shiftId1: string;
  let shiftId2: string;

  beforeAll(async () => {
    // 1. Start testcontainer
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const url = container.getConnectionUri();
    sql = postgres(url, { max: 1 });

    // 2. Apply migrations 0000..0052 (NOT 0053) in journal order
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    // Sort by idx to be safe, then apply up to and including idx=51 (tag=0052_shift_open)
    const entriesToApply = journal.entries
      .slice()
      .sort((a, b) => a.idx - b.idx)
      .filter((e) => e.idx <= 51); // 0..51 = migrations 0000..0052

    for (const entry of entriesToApply) {
      await applyMigrationFile(sql, entry.tag);
    }

    // 3. Seed: insert an admin_user (required for opened_by_user_id FK) and a branch
    const adminResult = await sql`
      INSERT INTO admin_user (email, password_hash, role)
      VALUES ('testadmin@example.com', 'not-a-real-hash', 'owner')
      RETURNING id
    `;
    const adminUserId = adminResult[0]!.id as string;

    const branchResult = await sql`
      INSERT INTO branch (name, code)
      VALUES ('Test Branch', 'TBREG')
      RETURNING id
    `;
    branchId = branchResult[0]!.id as string;

    // Insert TWO shift_open rows for the same branch — different business_dates,
    // NO daily_close match. After 0053 ADD COLUMN status DEFAULT 'open', both
    // would retain status='open' and cause the unique index to fail.
    const shift1 = await sql`
      INSERT INTO shift_open (branch_id, business_date, opened_by_user_id)
      VALUES (${branchId}, '2026-06-17', ${adminUserId})
      RETURNING id
    `;
    shiftId1 = shift1[0]!.id as string;

    const shift2 = await sql`
      INSERT INTO shift_open (branch_id, business_date, opened_by_user_id)
      VALUES (${branchId}, '2026-06-18', ${adminUserId})
      RETURNING id
    `;
    shiftId2 = shift2[0]!.id as string;

    // Confirm the unique per-branch-date constraint exists at this point (0052 adds it)
    // and that no daily_close rows reference these shifts.
    const dcCount = await sql`SELECT COUNT(*) as n FROM daily_close`;
    expect(Number(dcCount[0]!.n)).toBe(0); // no daily_close rows

    // 4. Apply 0053_shift_session.sql (the fixed version) — must NOT throw
    await applyMigrationFile(sql, "0053_shift_session");
  }, 120_000);

  afterAll(async () => {
    await sql.end();
    await container.stop();
  });

  it("both seeded shift_open rows are now status=closed", async () => {
    const rows = await sql`
      SELECT id, status FROM shift_open WHERE id = ANY(ARRAY[${shiftId1}::uuid, ${shiftId2}::uuid])
    `;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe("closed");
    }
  });

  it("partial unique index uq_shift_open_one_open_per_branch exists", async () => {
    const result = await sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'shift_open'
        AND indexname = 'uq_shift_open_one_open_per_branch'
    `;
    expect(result.length).toBe(1);
  });

  it("a fresh status=open row for that branch can be inserted (first open)", async () => {
    // Insert a new open shift for today
    const result = await sql`
      INSERT INTO shift_open (branch_id, business_date, status)
      VALUES (${branchId}, '2026-06-20', 'open')
      RETURNING id
    `;
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBeTruthy();
  });

  it("a SECOND status=open row for the same branch fails with unique violation", async () => {
    // Attempting to insert a second open shift for the same branch must throw
    await expect(
      sql`
        INSERT INTO shift_open (branch_id, business_date, status)
        VALUES (${branchId}, '2026-06-21', 'open')
      `,
    ).rejects.toThrow();
  });
});
