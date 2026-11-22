import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { branch, catalogueChatOrder, customer, inboxConversation, inboxPhoneNumber, saleOrder } from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

// GET /v1/reports/chat-orders (suite Overview, blueprint stage 16): paid orders that came
// from a WhatsApp chat cart, counted on the same terms as /reports/revenue.
describe("reports/chat-orders", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let owner: string;
  let server: ReturnType<typeof serve>;

  const DAY = "2026-05-15";

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    const db = tdb.db;
    await seedOwner(db);
    await seedUser(db, { email: "staff@example.com", role: "branch_staff" });

    const [br] = await db.insert(branch).values({ name: "Chat Branch", code: "CHT1" }).returning();
    const [line] = await db.insert(inboxPhoneNumber).values({ e164: "+2348000000001", label: "Main line", channels: "both" }).returning();
    const [cust] = await db.insert(customer).values({ name: "Ada", source: "online" }).returning();
    const [conv] = await db.insert(inboxConversation).values({ customerId: cust!.id, phoneNumberId: line!.id }).returning();
    const at = new Date(`${DAY}T10:00:00+01:00`);

    async function order(n: number, status: "paid" | "delivered" | "confirmed" | "cancelled", total: number, fromChat: boolean, when = at) {
      const [o] = await db
        .insert(saleOrder)
        .values({
          orderNumber: `CHT-${n}`,
          branchId: br!.id,
          channel: "online",
          status,
          subtotalNgn: total,
          totalNgn: total,
          paymentMethod: "transfer",
          paymentStatus: status === "paid" || status === "delivered" ? "paid" : "pending",
          createdAtLocal: when,
          idempotencyKey: `eeeeeeee-0000-4000-8000-00000000000${n}`,
        })
        .returning();
      if (fromChat) {
        await db.insert(catalogueChatOrder).values({
          conversationId: conv!.id,
          customerId: cust!.id,
          waMessageId: `wamid.${n}`,
          cart: [],
          state: "placed",
          saleOrderId: o!.id,
        });
      }
    }

    await order(1, "paid", 6000, true); // counted
    await order(2, "delivered", 4500, true); // counted
    await order(3, "confirmed", 9000, true); // unpaid: not counted
    await order(4, "cancelled", 3000, true); // cancelled: not counted
    await order(5, "paid", 7000, false); // website order, not from a chat
    await order(6, "paid", 2500, true, new Date("2026-04-20T10:00:00+01:00")); // outside the range

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  async function get(path: string, cookie = owner): Promise<{ status: number; body: { data?: { orders: number; gross_ngn: number } } }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as { data?: { orders: number; gross_ngn: number } } };
  }

  it("counts only paid orders placed from a chat cart, inside the range", async () => {
    const res = await get("/v1/reports/chat-orders?from=2026-05-01&to=2026-05-31");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ orders: 2, gross_ngn: 10500 });
  });

  it("returns zeros for a range with no chat orders", async () => {
    const res = await get("/v1/reports/chat-orders?from=2026-01-01&to=2026-01-31");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ orders: 0, gross_ngn: 0 });
  });

  it("rejects a missing or reversed range", async () => {
    expect((await get("/v1/reports/chat-orders")).status).toBe(400);
    expect((await get("/v1/reports/chat-orders?from=2026-05-31&to=2026-05-01")).status).toBe(400);
  });

  it("is guarded by reports.view like the other sales reports", async () => {
    const staff = await loginAs(baseUrl, "staff@example.com", "userpassword123");
    expect((await get("/v1/reports/chat-orders?from=2026-05-01&to=2026-05-31", staff)).status).toBe(403);
  });
});
