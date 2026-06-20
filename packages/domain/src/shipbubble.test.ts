import { describe, it, expect } from "vitest";
import { parseShipbubbleWebhook } from "./shipbubble.js";

describe("parseShipbubbleWebhook", () => {
  it("reads root-level order_id and status (current Shipbubble payload)", () => {
    const body = JSON.stringify({
      event: "shipment.status.changed",
      order_id: "SB-6BAD4363F17C",
      status: "in_transit",
      courier: { name: "Darum NG", rider_info: { name: "Sola A.", phone: "08031234567" } },
    });
    const out = parseShipbubbleWebhook(body);
    expect(out).not.toBeNull();
    expect(out!.externalRef).toBe("SB-6BAD4363F17C");
    expect(out!.status).toBe("in_transit");
    expect(out!.rider?.name).toBe("Sola A.");
    expect(out!.rider?.phone).toBe("08031234567");
  });

  it("maps shipment.cancelled to cancelled", () => {
    const body = JSON.stringify({ event: "shipment.cancelled", order_id: "SB-X", status: "cancelled" });
    expect(parseShipbubbleWebhook(body)!.status).toBe("cancelled");
  });

  it("still parses a legacy nested data.* payload via fallback", () => {
    const body = JSON.stringify({ event: "shipment.status.changed", data: { order_id: "SB-Y", status: "delivered" } });
    const out = parseShipbubbleWebhook(body);
    expect(out!.externalRef).toBe("SB-Y");
    expect(out!.status).toBe("delivered");
  });

  it("returns null for an unknown status", () => {
    const body = JSON.stringify({ event: "shipment.status.changed", order_id: "SB-Z", status: "banana" });
    expect(parseShipbubbleWebhook(body)).toBeNull();
  });
});
