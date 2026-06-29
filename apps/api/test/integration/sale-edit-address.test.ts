import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { saleOrder, auditLog, branch } from "@ms/db";
import {
  makeTestApp,
  authOwner,
  authBranchStaff,
  seedOnlineOrder,
} from "./helpers.js";
import type { Hono } from "hono";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * PATCH /branches/:branchId/sales/:id/delivery-address — lets the owner / branch
 * clean up a drop-off address (and state) before booking a rider. The booking
 * flow reads these fields, so this is the seam that makes "put in a better
 * address from my side" actually reach Shipbubble.
 */
describe("edit delivery address", () => {
  let app: Hono;
  let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    const t = await makeTestApp();
    app = t.app;
    db = t.db;
    container = t.container;
  }, 120000);

  afterAll(async () => {
    await container.stop();
  }, 30000);

  it("owner edits address + state, persists, and writes an audit row", async () => {
    const { cookie } = await authOwner(app);
    const { saleId, branchId } = await seedOnlineOrder(db, {
      status: "paid",
      deliveryState: "Ogun",
      deliveryFeeNgn: 1500,
    });

    const res = await app.request(
      `/v1/branches/${branchId}/sales/${saleId}/delivery-address`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: "12 Adeola Odeku St, Victoria Island", state: "Lagos" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deliveryAddressFormatted: string; deliveryState: string } };
    expect(body.data.deliveryAddressFormatted).toBe("12 Adeola Odeku St, Victoria Island");
    expect(body.data.deliveryState).toBe("Lagos");

    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(row?.deliveryAddressFormatted).toBe("12 Adeola Odeku St, Victoria Island");
    expect(row?.deliveryState).toBe("Lagos");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, "sale.edit_delivery_address")));
    expect(audits.length).toBe(1);
  });

  it("trims the address and leaves state untouched when omitted", async () => {
    const { cookie } = await authOwner(app);
    const { saleId, branchId } = await seedOnlineOrder(db, {
      status: "paid",
      deliveryState: "Lagos",
      deliveryFeeNgn: 1500,
    });

    const res = await app.request(
      `/v1/branches/${branchId}/sales/${saleId}/delivery-address`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: "  5 Bourdillon Rd, Ikoyi  " }),
      },
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(row?.deliveryAddressFormatted).toBe("5 Bourdillon Rd, Ikoyi");
    expect(row?.deliveryState).toBe("Lagos"); // unchanged
  });

  it("rejects a delivered (terminal) order with 409", async () => {
    const { cookie } = await authOwner(app);
    const { saleId, branchId } = await seedOnlineOrder(db, {
      status: "delivered",
      deliveryState: "Lagos",
      deliveryFeeNgn: 1500,
    });

    const res = await app.request(
      `/v1/branches/${branchId}/sales/${saleId}/delivery-address`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: "anything" }),
      },
    );
    expect(res.status).toBe(409);
  });

  it("rejects a walk-up order with 409", async () => {
    const { cookie } = await authOwner(app);
    const [br] = await db
      .insert(branch)
      .values({ name: "Walk Branch", code: `WB-${Date.now()}` })
      .returning();
    if (!br) throw new Error("branch insert failed");
    const [row] = await db
      .insert(saleOrder)
      .values({
        id: uuid(),
        orderNumber: `WALK-${uuid().slice(0, 8).toUpperCase()}`,
        branchId: br.id,
        channel: "walkup",
        status: "paid",
        subtotalNgn: 2500,
        deliveryFeeNgn: 0,
        totalNgn: 2500,
        paymentMethod: "transfer",
        paymentStatus: "paid",
        createdAtLocal: new Date(),
        idempotencyKey: uuid(),
        isPreorder: false,
      })
      .returning();
    if (!row) throw new Error("walkup insert failed");

    const res = await app.request(
      `/v1/branches/${br.id}/sales/${row.id}/delivery-address`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: "anything" }),
      },
    );
    expect(res.status).toBe(409);
  });

  it("rejects an empty address with 400", async () => {
    const { cookie } = await authOwner(app);
    const { saleId, branchId } = await seedOnlineOrder(db, {
      status: "paid",
      deliveryState: "Lagos",
      deliveryFeeNgn: 1500,
    });

    const res = await app.request(
      `/v1/branches/${branchId}/sales/${saleId}/delivery-address`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: "   " }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("lets branch staff (pos.sell) edit an order at their branch", async () => {
    const { saleId, branchId } = await seedOnlineOrder(db, {
      status: "paid",
      deliveryState: "Lagos",
      deliveryFeeNgn: 1500,
    });
    const { cookie } = await authBranchStaff(app, db, { branchId });

    const res = await app.request(
      `/v1/branches/${branchId}/sales/${saleId}/delivery-address`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: "9 Glover Rd, Ikoyi", state: "Lagos" }),
      },
    );
    expect(res.status).toBe(200);
  });
});
