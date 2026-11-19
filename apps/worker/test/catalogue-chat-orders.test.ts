import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  branch,
  catalogueChatOrder,
  catalogueLink,
  customer,
  inboxConversation,
  inboxPhoneNumber,
  product,
  saleOrder,
  stockReservation,
  type DbClient,
} from "@ms/db";
import { expireUnpaidOrders } from "../src/jobs/expire-unpaid-orders.js";
import { runCatalogueBatchCheck, runCatalogueReconcile, runCatalogueSync, runChatOrderJobs } from "../src/jobs/catalogue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");
const log = { info: () => {}, warn: () => {}, error: () => {} };
// An obvious fake; no test here lets a request leave the process.
const cfg = { token: "itest-token", graphVersion: "v23.0" };

describe("catalogue jobs and chat orders in the worker (suite spec 08)", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let branchId: string;
  let productId: string;
  let conversationId: string;
  let customerId: string;
  const realFetch = globalThis.fetch;
  let outbound = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    // Any call out would be a bug: count it and refuse it.
    globalThis.fetch = (async () => {
      outbound++;
      throw new Error("no network in this test");
    }) as typeof fetch;

    const [b] = await db.insert(branch).values({ name: "Test Branch", code: "TEST", isOnlineDefault: true }).returning();
    branchId = b!.id;
    const [p] = await db.insert(product).values({ name: "Zobo", slug: "zobo", category: "regular" }).returning();
    productId = p!.id;
    const [c] = await db.insert(customer).values({ name: "Ada Test", phone: "+2348035510001", source: "whatsapp" }).returning();
    customerId = c!.id;
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000000", label: "Main line", channels: "both", wabaId: "WABA1", waPhoneNumberId: "1098765432" })
      .returning();
    const [conv] = await db.insert(inboxConversation).values({ customerId, phoneNumberId: line!.id, lastInboundWaAt: new Date() }).returning();
    conversationId = conv!.id;
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container.stop();
  });

  it("the unpaid-order expiry cancels an unpaid chat order like any online order", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 61 * 60_000);
    // The row placeOnlineOrder writes for a chat order: channel online, confirmed, payment pending.
    const [order] = await db
      .insert(saleOrder)
      .values({
        orderNumber: `SO-${randomUUID()}`,
        branchId,
        channel: "online",
        customerId,
        status: "confirmed",
        paymentStatus: "pending",
        subtotalNgn: 3000,
        totalNgn: 3000,
        paymentMethod: "card",
        createdAtLocal: old,
        createdAt: old,
        idempotencyKey: randomUUID(),
        notes: "Ordered in WhatsApp chat",
      })
      .returning();
    await db.insert(stockReservation).values({ saleOrderId: order!.id, branchId, productId, quantity: 2, expiresAt: new Date(now.getTime() + 30 * 60_000) });
    const [cart] = await db
      .insert(catalogueChatOrder)
      .values({
        conversationId,
        customerId,
        waMessageId: `wamid.${randomUUID()}`,
        cart: [{ product_retailer_id: "v-00000000-0000-4000-8000-000000000001", quantity: 2, item_price: 1500, currency: "NGN" }],
        state: "placed",
        saleOrderId: order!.id,
        idempotencyKey: order!.idempotencyKey,
        lastNotifiedStatus: "confirmed",
      })
      .returning();

    const cancelled = await expireUnpaidOrders(db, now, async () => true);
    expect(cancelled).toBe(1);
    const [after] = await db.select().from(saleOrder).where(eq(saleOrder.id, order!.id));
    expect(after).toMatchObject({ status: "cancelled", cancelReason: "payment_expired" });
    expect(await db.select().from(stockReservation).where(eq(stockReservation.saleOrderId, order!.id))).toHaveLength(0);
    // The cart row still points at the order, so the card beside the chat shows it as cancelled.
    const [row] = await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, cart!.id));
    expect(row).toMatchObject({ state: "placed", saleOrderId: order!.id });

    // With the owner's order-updates switch on, a cancelled order is recorded and nothing is sent (rule R29).
    await db.insert(catalogueLink).values({ catalogId: "123456789012345", orderUpdatesEnabled: true });
    expect(await runChatOrderJobs(db, log, cfg)).toEqual({ prompts: 0, updates: 0 });
    const [told] = await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, cart!.id));
    expect(told!.lastNotifiedStatus).toBe("cancelled");
    expect(outbound).toBe(0);
    await db.delete(catalogueLink);
  });

  it("every catalogue job returns at once without Meta configuration or without a linked catalogue", async () => {
    expect(await runCatalogueSync(db, log, null)).toBeNull();
    expect(await runCatalogueBatchCheck(db, log, null)).toBe(0);
    expect(await runCatalogueReconcile(db, log, null)).toBeNull();
    expect(await runChatOrderJobs(db, log, null)).toBeNull();
    // Configured, but no catalogue linked.
    expect(await runCatalogueSync(db, log, cfg)).toBeNull();
    expect(await runCatalogueBatchCheck(db, log, cfg)).toBe(0);
    expect(await runCatalogueReconcile(db, log, cfg)).toBeNull();
    expect(await runChatOrderJobs(db, log, cfg)).toBeNull();
    expect(outbound).toBe(0);
  });

  it("with a catalogue linked but every switch off, nothing is sent anywhere", async () => {
    await db.insert(catalogueLink).values({ catalogId: "123456789012345", whatsappConnected: true });
    try {
      expect(await runCatalogueSync(db, log, cfg)).toBeNull();
      expect(await runCatalogueBatchCheck(db, log, cfg)).toBe(0);
      expect(await runCatalogueReconcile(db, log, cfg, new Date("2026-11-20T01:30:00Z"))).toBeNull();
      expect(await runChatOrderJobs(db, log, cfg)).toBeNull();
      expect(outbound).toBe(0);
    } finally {
      await db.delete(catalogueLink);
    }
  });
});
