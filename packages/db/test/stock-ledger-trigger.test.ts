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

describe("stock_ledger non-negative balance trigger (per-variant, 0041)", () => {
  it("enforces the floor per (location, product, variant), not per flavour", async () => {
    if (!available) return;
    const fakeLocation = "88888888-8888-8888-8888-888888888888";
    const production = "99999999-9999-9999-9999-999999999999";
    const sale = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    // Create a fresh product with two active variants so this test is
    // self-contained and doesn't depend on seeded data shapes.
    const [prod] = await sql<{ id: string }[]>`
      INSERT INTO product (name, slug, category)
      VALUES ('Per-Variant Test Flavour', 'per-variant-test-flavour-' || gen_random_uuid(), 'regular')
      RETURNING id
    `;

    const [variantA] = await sql<{ id: string }[]>`
      INSERT INTO product_variant (product_id, size_ml, sku)
      VALUES (${prod.id}::uuid, 330, 'PVT-330-' || gen_random_uuid())
      RETURNING id
    `;
    const [variantB] = await sql<{ id: string }[]>`
      INSERT INTO product_variant (product_id, size_ml, sku)
      VALUES (${prod.id}::uuid, 650, 'PVT-650-' || gen_random_uuid())
      RETURNING id
    `;

    try {
      // +5 production run for variantA only. variantB stays at 0.
      await sql`
        INSERT INTO stock_ledger (location_type, location_id, product_id, variant_id, delta, source_type, source_id)
        VALUES ('factory', ${fakeLocation}::uuid, ${prod.id}::uuid, ${variantA.id}::uuid, 5, 'production_run', ${production}::uuid)
      `;

      // Flavour total is 5, but variantB's own balance is 0 — a -1 for
      // variantB must be rejected even though the pooled flavour total
      // would still be non-negative.
      await expect(async () => {
        await sql`
          INSERT INTO stock_ledger (location_type, location_id, product_id, variant_id, delta, source_type, source_id)
          VALUES ('factory', ${fakeLocation}::uuid, ${prod.id}::uuid, ${variantB.id}::uuid, -1, 'sale', ${sale}::uuid)
        `;
      }).rejects.toMatchObject({ code: "23514" });

      // -5 against variantA (balance 5) is fine.
      await sql`
        INSERT INTO stock_ledger (location_type, location_id, product_id, variant_id, delta, source_type, source_id)
        VALUES ('factory', ${fakeLocation}::uuid, ${prod.id}::uuid, ${variantA.id}::uuid, -5, 'sale', ${sale}::uuid)
      `;
    } finally {
      await sql`DELETE FROM stock_ledger WHERE location_id = ${fakeLocation}::uuid`;
      await sql`DELETE FROM product_variant WHERE product_id = ${prod.id}::uuid`;
      await sql`DELETE FROM product WHERE id = ${prod.id}::uuid`;
    }
  });
});
