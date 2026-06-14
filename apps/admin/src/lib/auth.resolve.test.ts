import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveSession } from "./auth.js";

const USER = { id: "u1", email: "a@b.c", role: "owner", branch_id: null, capabilities: [] };

describe("resolveSession", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns the user when /auth/me succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: USER }), { status: 200 })));
    expect(await resolveSession()).toEqual(USER);
  });

  it("refreshes once then returns the user when access cookie expired", async () => {
    let meCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      meCalls++;
      if (meCalls === 1) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ data: USER }), { status: 200 });
    }));
    expect(await resolveSession()).toEqual(USER);
  });

  it("returns null when refresh also fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await resolveSession()).toBeNull();
  });
});
