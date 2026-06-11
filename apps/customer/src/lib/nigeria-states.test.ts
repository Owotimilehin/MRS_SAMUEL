import { describe, it, expect } from "vitest";
import { NIGERIA_STATES } from "./nigeria-states";

describe("NIGERIA_STATES", () => {
  it("lists 36 states plus FCT", () => {
    expect(NIGERIA_STATES).toHaveLength(37);
  });
  it("has Lagos first (the default)", () => {
    expect(NIGERIA_STATES[0]).toBe("Lagos");
  });
  it("includes FCT and is otherwise unique", () => {
    expect(NIGERIA_STATES).toContain("FCT (Abuja)");
    expect(new Set(NIGERIA_STATES).size).toBe(NIGERIA_STATES.length);
  });
});
