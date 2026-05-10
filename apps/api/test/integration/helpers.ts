import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, adminUser } from "@ms/db";
import { hashPassword } from "../../src/auth/argon.js";

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
