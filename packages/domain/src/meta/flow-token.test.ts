import { describe, it, expect } from "vitest";
import { makeFlowToken, peekFlowToken, readFlowToken } from "./flow-token.js";

const SECRET = "unit-test-signing-secret";
const CONV = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-11-20T10:00:00Z");

describe("form tokens (suite spec 07, section 5.4)", () => {
  it("round-trips key and conversation", () => {
    const token = makeFlowToken(SECRET, "delivery_address", CONV, NOW);
    expect(token.split(".")).toHaveLength(4);
    expect(token.split(".")[3]).toHaveLength(32);
    expect(readFlowToken(SECRET, token, NOW)).toEqual({ ok: true, key: "delivery_address", conversationId: CONV });
    // Still good just before the three days are up.
    expect(readFlowToken(SECRET, token, new Date(NOW.getTime() + 3 * 24 * 3600_000 - 2000)).ok).toBe(true);
  });

  it("rejects a changed token, a wrong secret and an expired token", () => {
    const token = makeFlowToken(SECRET, "complaint", CONV, NOW);
    const [key, conv, exp, sig] = token.split(".") as [string, string, string, string];
    expect(readFlowToken(SECRET, `delivery_slot.${conv}.${exp}.${sig}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(readFlowToken(SECRET, `${key}.${conv}.${Number(exp) + 999}.${sig}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(readFlowToken(SECRET, `${key}.${conv}.${exp}.${sig.slice(0, 31)}x`, NOW).ok).toBe(false);
    expect(readFlowToken("another-secret", token, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(readFlowToken(SECRET, token, new Date(NOW.getTime() + 3 * 24 * 3600_000 + 1000))).toEqual({ ok: false, reason: "expired" });
    expect(readFlowToken(SECRET, makeFlowToken(SECRET, "complaint", CONV, NOW, 60_000), new Date(NOW.getTime() + 61_000))).toEqual({ ok: false, reason: "expired" });
  });

  it("calls anything that is not a token malformed", () => {
    for (const bad of ["", "unused", "a.b.c", "a.b.c.d.e", `complaint.${CONV}.abc.sig`, `complaint.not-a-uuid.123.sig`, 42, null, undefined, { a: 1 }]) {
      expect(readFlowToken(SECRET, bad, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("peekFlowToken names the form of an expired token and nothing for a non-token", () => {
    const old = makeFlowToken(SECRET, "pickup_request", CONV, new Date("2026-01-01T00:00:00Z"));
    expect(readFlowToken(SECRET, old, NOW).ok).toBe(false);
    expect(peekFlowToken(old)).toEqual({ key: "pickup_request", conversationId: CONV });
    expect(peekFlowToken("unused")).toBeNull();
    expect(peekFlowToken(null)).toBeNull();
  });
});
