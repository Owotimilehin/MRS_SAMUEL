import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres, { type Sql } from "postgres";

/**
 * Black-box test of the non-negative-balance trigger on stock_ledger.
 *
 * Hits the local dev DB directly (postgres://ms:ms@localhost:5432/ms_dev).
 * If DATABASE_URL is unset OR the connection fails, the suite skips itself
 * cleanly so CI runs that lack a postgres container don't blow up. The
 * integration tests in apps/api spin up their own testcontainer separately.
 */

const url = process.env.DATABASE_URL ?? "postgres://ms:ms@localhost:5432/ms_dev";

let sql: Sql;
let available = true;

beforeAll(async () => {
  sql = postgres(url, { max: 1, idle_timeout: 2 });
  try {
    await sql`SELECT 1`;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
});

describe("stock_ledger non-negative balance trigger", () => {
  it("accepts a positive opening_balance row", async () => {
    if (!available) return;
    const fakeLocation = "11111111-1111-1111-1111-111111111111";
    const fakeProduct = "22222222-2222-2222-2222-222222222222";

    // Need a real product row because of the FK. Use any existing seeded product.
    const [prod] = await sql<{ id: string }[]>`SELECT id FROM product LIMIT 1`;
    if (!prod) throw new Error("seeded products required for this test");

    // Insert opening balance of +50 at a fake branch location.
    await sql`
      INSERT INTO stock_ledger (location_type, location_id, product_id, delta, source_type, source_id)
      VALUES ('branch', ${fakeLocation}::uuid, ${prod.id}::uuid, 50, 'opening_balance', ${fakeProduct}::uuid)
    `;

    const [{ sum }] = await sql<{ sum: number }[]>`
      SELECT COALESCE(SUM(delta), 0)::int AS sum FROM stock_ledger
      WHERE location_type='branch' AND location_id=${fakeLocation}::uuid AND product_id=${prod.id}::uuid
    `;
    expect(Number(sum)).toBeGreaterThanOrEqual(50);

    // Clean up our test rows so reruns don't accumulate.
    await sql`DELETE FROM stock_ledger WHERE location_id = ${fakeLocation}::uuid`;
  });

  it("rejects an insert that would drive the running balance negative", async () => {
    if (!available) return;
    const fakeLocation = "33333333-3333-3333-3333-333333333333";
    const fakeSourceId = "44444444-4444-4444-4444-444444444444";
    const [prod] = await sql<{ id: string }[]>`SELECT id FROM product LIMIT 1`;
    if (!prod) throw new Error("seeded products required");

    // Try a single negative insert with no prior positive: balance would be -10.
    // The trigger should fire with sqlstate '23514' (check_violation).
    await expect(async () => {
      await sql`
        INSERT INTO stock_ledger (location_type, location_id, product_id, delta, source_type, source_id)
        VALUES ('branch', ${fakeLocation}::uuid, ${prod.id}::uuid, -10, 'sale', ${fakeSourceId}::uuid)
      `;
    }).rejects.toMatchObject({ code: "23514" });

    // No row should have been committed.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM stock_ledger WHERE location_id = ${fakeLocation}::uuid
    `;
    expect(Number(n)).toBe(0);
  });

  it("allows -N to land after a prior +M >= N", async () => {
    if (!available) return;
    const fakeLocation = "55555555-5555-5555-5555-555555555555";
    const opening = "66666666-6666-6666-6666-666666666666";
    const sale = "77777777-7777-7777-7777-777777777777";
    const [prod] = await sql<{ id: string }[]>`SELECT id FROM product LIMIT 1`;
    if (!prod) throw new Error("seeded products required");

    await sql`
      INSERT INTO stock_ledger (location_type, location_id, product_id, delta, source_type, source_id)
      VALUES ('branch', ${fakeLocation}::uuid, ${prod.id}::uuid, 20, 'opening_balance', ${opening}::uuid)
    `;
    // -15 leaves balance at +5 — should be accepted.
    await sql`
      INSERT INTO stock_ledger (location_type, location_id, product_id, delta, source_type, source_id)
      VALUES ('branch', ${fakeLocation}::uuid, ${prod.id}::uuid, -15, 'sale', ${sale}::uuid)
    `;
    // -10 more would take it to -5 — should be rejected.
    await expect(async () => {
      await sql`
        INSERT INTO stock_ledger (location_type, location_id, product_id, delta, source_type, source_id)
        VALUES ('branch', ${fakeLocation}::uuid, ${prod.id}::uuid, -10, 'sale', ${sale}::uuid)
      `;
    }).rejects.toMatchObject({ code: "23514" });

    await sql`DELETE FROM stock_ledger WHERE location_id = ${fakeLocation}::uuid`;
  });
});
