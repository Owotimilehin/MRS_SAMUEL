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

describe("sale.paid_online message formatting", () => {
  const base = {
    sale_order_id: "abc",
    order_number: "MS-2026-00010",
    total_ngn: 9000,
  };

  it("scheduled order names the time and says Bolt is NOT dispatched", async () => {
    const { format } = await import("../src/outbox.js");
    const { text } = format({
      eventType: "sale.paid_online",
      payload: { ...base, scheduled_delivery_at: "2026-06-03T13:00:00.000Z", delivery_state: null },
    });
    expect(text).toMatch(/scheduled/i);
    expect(text).toMatch(/manual|NOT dispatched/i);
    expect(text).not.toContain("dispatch queued");
  });

  it("outside-Lagos order names the state and says Bolt is NOT dispatched", async () => {
    const { format } = await import("../src/outbox.js");
    const { text } = format({
      eventType: "sale.paid_online",
      payload: { ...base, scheduled_delivery_at: null, delivery_state: "Oyo" },
    });
    expect(text).toContain("Oyo");
    expect(text).toMatch(/manual|NOT dispatched/i);
    expect(text).not.toContain("dispatch queued");
  });

  it("immediate Lagos order keeps the dispatch-queued copy", async () => {
    const { format } = await import("../src/outbox.js");
    const { text } = format({
      eventType: "sale.paid_online",
      payload: { ...base, scheduled_delivery_at: null, delivery_state: null },
    });
    expect(text).toContain("dispatch queued");
  });
});

describe("stock_adjustment.recorded message formatting", () => {
  it("formats per-line delta with sign and includes the note", async () => {
    const { format } = await import("../src/outbox.js");
    const out = format({
      eventType: "stock_adjustment.recorded",
      payload: {
        adjustment_id: "00000000-0000-0000-0000-000000000001",
        location_type: "factory",
        location_id: "00000000-0000-0000-0000-000000000002",
        reason_code: "damaged",
        reason_note: "Forklift accident",
        items: [
          {
            product_id: "p1",
            product_name: "Sunrise Blend",
            old_quantity: 50,
            new_quantity: 47,
            delta: -3,
          },
        ],
      },
    });
    expect(out.text).toContain("📒");
    expect(out.text).toContain("Sunrise Blend");
    expect(out.text).toContain("50 → 47 (-3)");
    expect(out.text).toContain("Forklift accident");
    expect(out.text).toContain("/owner/inventory");
  });
});

describe("packaging.purchase_recorded formatting", () => {
  it("formats with supplier + total cost + qty + material name", async () => {
    const { format } = await import("../src/outbox.js");
    const out = format({
      eventType: "packaging.purchase_recorded",
      payload: {
        purchase_id: "p1",
        factory_id: "f1",
        material_id: "m1",
        material_name: "330ml glass bottle",
        quantity: 5000,
        total_cost_ngn: 200000,
        supplier_name: "Glass Co.",
      },
    });
    expect(out.text).toContain("🧴");
    expect(out.text).toContain("Glass Co.");
    expect(out.text).toContain("200,000");
    expect(out.text).toContain("5,000");
    expect(out.text).toContain("330ml glass bottle");
    expect(out.text).toContain("/owner/packaging");
  });
});

describe("appendFooter", () => {
  it("adds the actor and Lagos time", async () => {
    const { appendFooter } = await import("../src/outbox.js");
    const out = appendFooter("body", {
      actor_name: "Aisha Bello", actor_role: "branch_staff", actor_branch_name: "Ajao",
    }, "2026-06-17T14:42:00.000Z");
    expect(out).toContain("body");
    expect(out).toContain("Aisha Bello");
    expect(out).toContain("Branch staff");
    expect(out).toContain("Ajao");
    expect(out).toMatch(/🕒/);
  });
  it("omits the actor line when no actor is present", async () => {
    const { appendFooter } = await import("../src/outbox.js");
    const out = appendFooter("body", {});
    expect(out).toBe("body");
  });
});

describe("audit.logged formatting", () => {
  it("renders before→after change lines", async () => {
    const { format } = await import("../src/outbox.js");
    const { text } = format({
      eventType: "audit.logged",
      payload: {
        action: "product.update", entity_noun: "Product", identifier: "Zobo",
        changes: [{ label: "Price", from: "₦1,800", to: "₦2,000" }],
      },
    });
    expect(text).toContain("Product");
    expect(text).toContain("Zobo");
    expect(text).toContain("Price: ₦1,800 → ₦2,000");
  });
});

describe("sale.branch_sold item lines", () => {
  it("lists flavour, size and quantity", async () => {
    const { format } = await import("../src/outbox.js");
    const { text } = format({
      eventType: "sale.branch_sold",
      payload: {
        sale_order_id: "s1", order_number: "ORD-00123", total_ngn: 4200, channel: "pos",
        items: [
          { name: "Zobo", size: "50cl", qty: 2, line_total_ngn: 1600 },
          { name: "Pineapple", size: "35cl", qty: 3, line_total_ngn: 2600 },
        ],
      },
    });
    expect(text).toContain("ORD-00123");
    expect(text).toContain("2× Zobo 50cl");
    expect(text).toContain("3× Pineapple 35cl");
  });
});

describe("shift_open.submitted message formatting", () => {
  it("formats shift_open.submitted for the owner", async () => {
    const { format } = await import("../src/outbox.js");
    const msg = format({
      eventType: "shift_open.submitted",
      payload: { business_date: "2026-06-19", opened_by: "amaka", variance_count: 2, branch_name: "Ajao" },
    });
    expect(msg.text).toContain("Shift start");
    expect(msg.text).toContain("amaka");
    expect(msg.text).toContain("2");
  });
});
