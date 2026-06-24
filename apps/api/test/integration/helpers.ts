import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDbClient, adminUser, assertNonProdDb, branch, product, productVariant, productPrice, stockLedger, saleOrder } from "@ms/db";
import { hashPassword } from "../../src/auth/argon.js";
import type { AdminRole, Capability } from "@ms/shared";
import type { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");

export async function setupTestDb(): Promise<{
  container: StartedPostgreSqlContainer;
  url: string;
  db: ReturnType<typeof createDbClient>;
}> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  assertNonProdDb(url);
  const sql = postgres(url, { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder });
  await sql.end();
  process.env.DATABASE_URL = url;
  process.env.JWT_SIGNING_KEY ??= "test-only-jwt-signing-key-padding-XXXXXX";
  process.env.PUBLIC_API_URL ??= "http://localhost";
  process.env.PUBLIC_ADMIN_URL ??= "http://localhost";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.RATE_LIMIT_DISABLED = "1";
  // A PKTEST key so online-order/subscription checkout config builds in "Test"
  // mode. There is no mock-confirm fallback anymore — without a key,
  // buildPayazaCheckoutConfig throws — so every integration test that creates an
  // online order needs one. Confirmation itself still requires a real Payaza
  // "Completed" (tests that assert a flip-to-paid stub the transaction-query).
  process.env.PAYAZA_PUBLIC_KEY ??= "PZ78-PKTEST-itest";
  return { container, url, db: createDbClient(url) };
}

export async function seedOwner(db: ReturnType<typeof createDbClient>): Promise<{ id: string }> {
  const hash = await hashPassword("ownerpassword123");
  const [row] = await db
    .insert(adminUser)
    .values({
      email: "owner@example.com",
      passwordHash: hash,
      role: "owner",
    })
    .returning();
  if (!row) throw new Error("failed to seed owner");
  return row;
}

export async function loginAs(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.get("set-cookie") ?? "";
}

/**
 * Sum the per-variant balance rows returned by `/v1/stock/...` and
 * `/v1/reports/branch-stock` for a given product, across all variant
 * buckets (incl. the NULL/legacy bucket). Tests that only ever produce
 * variant-less stock for a product can treat this as that product's total.
 */
export function stockBalance(
  rows: Array<{ product_id: string; variant_id?: string | null; balance: number }>,
  productId: string,
): number {
  return rows
    .filter((r) => r.product_id === productId)
    .reduce((sum, r) => sum + r.balance, 0);
}

/**
 * Spin up a Hono app and return it alongside its db handle.
 * The caller is responsible for calling server.close() + container.stop().
 * Uses the already-running DATABASE_URL set by setupTestDb().
 */
export async function makeTestApp(): Promise<{
  app: Hono;
  db: ReturnType<typeof createDbClient>;
  container: StartedPostgreSqlContainer;
}> {
  const tdb = await setupTestDb();
  await seedOwner(tdb.db);
  const { buildApp } = await import("../../src/test-app.js");
  return { app: buildApp(), db: tdb.db, container: tdb.container };
}

/**
 * Seed one active flavour (product) with a single 330ml variant priced at
 * ₦2500. Returns ids needed to drive stock/availability helpers.
 */
export async function seedCatalog(
  db: ReturnType<typeof createDbClient>,
): Promise<{ productId: string; variantId: string; branchId: string }> {
  const [prod] = await db
    .insert(product)
    .values({ name: "Test Juice", slug: `test-juice-${Date.now()}`, category: "regular" })
    .returning();
  if (!prod) throw new Error("seedCatalog: product insert failed");

  const [variant] = await db
    .insert(productVariant)
    .values({ productId: prod.id, sizeMl: 330, sku: `TJ330-${Date.now()}` })
    .returning();
  if (!variant) throw new Error("seedCatalog: variant insert failed");

  await db.insert(productPrice).values({ productId: prod.id, variantId: variant.id, priceNgn: 2500 });

  const [br] = await db
    .insert(branch)
    .values({ name: "Test Branch", code: `TB-${Date.now()}` })
    .returning();
  if (!br) throw new Error("seedCatalog: branch insert failed");

  return { productId: prod.id, variantId: variant.id, branchId: br.id };
}

/** Set a branch as the single online-default (clears all others first). */
export async function setOnlineDefaultBranch(
  db: ReturnType<typeof createDbClient>,
  branchId: string,
): Promise<void> {
  // Clear all first (mirrors the app's own invariant enforcement).
  await db.update(branch).set({ isOnlineDefault: false }).where(eq(branch.isOnlineDefault, true));
  await db.update(branch).set({ isOnlineDefault: true }).where(eq(branch.id, branchId));
}

/** Insert a raw branch stock ledger row (opening_balance source). */
export async function addBranchStock(
  db: ReturnType<typeof createDbClient>,
  opts: { branchId: string; productId: string; qty: number },
): Promise<void> {
  const { v4: uuid } = await import("uuid");
  await db.insert(stockLedger).values({
    locationType: "branch",
    locationId: opts.branchId,
    productId: opts.productId,
    delta: opts.qty,
    sourceType: "opening_balance",
    sourceId: uuid(),
  });
}

export async function seedUser(
  db: ReturnType<typeof createDbClient>,
  opts: {
    email: string;
    role: AdminRole;
    password?: string;
    branchId?: string | null;
    granted?: Capability[];
    revoked?: Capability[];
  },
): Promise<{ id: string }> {
  const hash = await hashPassword(opts.password ?? "userpassword123");
  const [row] = await db
    .insert(adminUser)
    .values({
      email: opts.email,
      passwordHash: hash,
      role: opts.role,
      branchId: opts.branchId ?? null,
      permissionOverrides: { granted: opts.granted ?? [], revoked: opts.revoked ?? [] },
    })
    .returning();
  if (!row) throw new Error("failed to seed user");
  return row;
}

/**
 * Return a cookie header string for the seeded owner by calling /auth/login on
 * the provided Hono app directly (no extra server needed).
 * The owner must already be seeded (via seedOwner or makeTestApp).
 */
export async function authOwner(
  app: Hono,
): Promise<Record<string, string>> {
  const res = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "ownerpassword123" }),
  });
  if (!res.ok) throw new Error(`authOwner: login failed ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { cookie: setCookie };
}

/**
 * Insert a minimal sale_order row directly into the DB for report-count tests.
 * Creates a dummy branch on demand; uses channel='online', is_preorder=false by default.
 */
export async function seedOnlineOrder(
  db: ReturnType<typeof createDbClient>,
  opts: { status: "confirmed" | "paid" | "handed_over" | "out_for_delivery" | "cancelled" | "failed" },
): Promise<{ id: string }> {
  const { v4: uuid } = await import("uuid");

  // Ensure a branch exists (reuse if present).
  const branches = await db.select().from(branch).limit(1);
  let branchId: string;
  if (branches[0]) {
    branchId = branches[0].id;
  } else {
    const [br] = await db
      .insert(branch)
      .values({ name: "Seed Branch", code: `SB-${Date.now()}` })
      .returning();
    if (!br) throw new Error("seedOnlineOrder: branch insert failed");
    branchId = br.id;
  }

  const [row] = await db
    .insert(saleOrder)
    .values({
      id: uuid(),
      orderNumber: `TEST-${uuid().slice(0, 8).toUpperCase()}`,
      branchId,
      channel: "online",
      status: opts.status,
      subtotalNgn: 2500,
      deliveryFeeNgn: 0,
      totalNgn: 2500,
      paymentMethod: "transfer",
      paymentStatus: opts.status === "paid" ? "paid" : "pending",
      createdAtLocal: new Date(),
      idempotencyKey: uuid(),
      isPreorder: false,
    })
    .returning();
  if (!row) throw new Error("seedOnlineOrder: insert failed");
  return { id: row.id };
}
