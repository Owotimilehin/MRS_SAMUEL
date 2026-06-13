import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, adminUser } from "@ms/db";
import { hashPassword } from "../../src/auth/argon.js";
import type { AdminRole, Capability } from "@ms/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");

export async function setupTestDb(): Promise<{
  container: StartedPostgreSqlContainer;
  url: string;
  db: ReturnType<typeof createDbClient>;
}> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  const sql = postgres(url, { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder });
  await sql.end();
  process.env.DATABASE_URL = url;
  process.env.JWT_SIGNING_KEY ??= "test-only-jwt-signing-key-padding-XXXXXX";
  process.env.PUBLIC_API_URL ??= "http://localhost";
  process.env.PUBLIC_ADMIN_URL ??= "http://localhost";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.RATE_LIMIT_DISABLED = "1";
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
