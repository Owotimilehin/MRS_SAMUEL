import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, checkoutAttemptLog } from "@ms/db";
import { pruneCheckoutLog } from "./prune-checkout-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");

describe("pruneCheckoutLog", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  beforeEach(async () => {
    await db.delete(checkoutAttemptLog);
  });

  it("deletes rows older than 30 days and keeps newer ones", async () => {
    const old = new Date(Date.now() - 31 * 24 * 3600_000);
    const recent = new Date(Date.now() - 1 * 24 * 3600_000);
    await db.insert(checkoutAttemptLog).values([
      { attemptId: "old", stage: "pressed", status: "info", createdAt: old },
      { attemptId: "new", stage: "pressed", status: "info", createdAt: recent },
    ]);

    const deleted = await pruneCheckoutLog(db);
    expect(deleted).toBe(1);

    const remaining = await db.select().from(checkoutAttemptLog);
    expect(remaining.map((r) => r.attemptId)).toEqual(["new"]);
  });

  it("returns 0 when nothing is stale", async () => {
    await db.insert(checkoutAttemptLog).values({ attemptId: "fresh", stage: "pressed", status: "info" });
    expect(await pruneCheckoutLog(db)).toBe(0);
  });
});
