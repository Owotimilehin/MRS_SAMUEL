import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, outboxEvent } from "@ms/db";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");

describe("worker outbox drain", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    // No Telegram token in tests — drain should skip the network call.
    delete process.env["TELEGRAM_BOT_TOKEN"];
  }, 60_000);

  afterAll(async () => {
    await container.stop();
  });

  it("marks a known-event-type row as sent even with no chat ids configured", async () => {
    const [row] = await db
      .insert(outboxEvent)
      .values({
        eventType: "stock_transfer.dispatched",
        payload: {
          transfer_id: "00000000-0000-0000-0000-000000000001",
          transfer_number: "TRF-2026-00001",
          branch_id: "00000000-0000-0000-0000-000000000002",
          factory_id: "00000000-0000-0000-0000-000000000003",
        },
      })
      .returning();
    if (!row) throw new Error("insert returned no row");

    const { drainOutbox } = await import("../src/outbox.js");
    const processed = await drainOutbox(db);
    expect(processed).toBeGreaterThanOrEqual(1);

    const [updated] = await db.select().from(outboxEvent).where(eq(outboxEvent.id, row.id));
    expect(updated?.status).toBe("sent");
    expect(updated?.processedAt).not.toBeNull();
  });

  it("ignores unknown event types but still marks them sent", async () => {
    const [row] = await db
      .insert(outboxEvent)
      .values({
        eventType: "noisy.heartbeat",
        payload: { ignored: true },
      })
      .returning();
    if (!row) throw new Error("insert returned no row");

    const { drainOutbox } = await import("../src/outbox.js");
    await drainOutbox(db);

    const [updated] = await db.select().from(outboxEvent).where(eq(outboxEvent.id, row.id));
    expect(updated?.status).toBe("sent");
  });
});
