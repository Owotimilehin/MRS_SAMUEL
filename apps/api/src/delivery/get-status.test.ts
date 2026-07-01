import { describe, it, expect } from "vitest";
import { ShipbubbleMockProvider } from "./shipbubble-mock.js";

describe("ShipbubbleMockProvider.getStatus", () => {
  it("returns a deterministic delivered snapshot for any ref", async () => {
    const p = new ShipbubbleMockProvider({ webhookUrl: "http://127.0.0.1:9/none", fastMode: true });
    // Mock has no persistence, so getStatus reports a deterministic 'delivered'
    // snapshot for any ref it is asked about (the poller integration test relies
    // on this to simulate a webhook that never fired).
    const snap = await p.getStatus("mock_d_probe");
    expect(snap).not.toBeNull();
    expect(snap?.externalRef).toBe("mock_d_probe");
    expect(snap?.status).toBe("delivered");
  });
});
