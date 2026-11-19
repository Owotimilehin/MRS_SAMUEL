import { describe, it, expect, beforeEach } from "vitest";
import type { DbClient } from "@ms/db";
import type { InsightsState, MetaConfig } from "@ms/domain";
import { collectInsightsIfDue, insightsRunDue, resetInsightsCollectMemory, type InsightsCollectDeps } from "./insights-collect.js";

/**
 * Suite spec 11, section 6: when the collector runs. The state and the collection itself
 * are stand-ins held in memory (no database, no Meta), and every case passes its own
 * "now", so nothing depends on the wall clock or the machine's time zone. The same job
 * against a real Postgres is in insights-collect-db.test.ts.
 */

const cfg: MetaConfig = { token: "WORKER-TEST-TOKEN", graphVersion: "v23.0" };
const log = { info: () => {}, warn: () => {}, error: () => {} };
const noDb = null as unknown as DbClient;
type Top = Pick<InsightsState, "last_daily_run_day" | "last_run_at" | "refresh_requested_at">;

function harness(initial: Partial<Top> = {}) {
  const state: Top = { last_daily_run_day: null, last_run_at: null, refresh_requested_at: null, ...initial };
  const runs: { now: string; storiesOnly: boolean }[] = [];
  let claimed = false;
  const deps: Partial<InsightsCollectDeps> = {
    cfg,
    readState: async () => ({ ...state }),
    patchState: async (_db, patch) => {
      Object.assign(state, patch);
    },
    claim: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    release: async () => {
      claimed = false;
    },
    run: async (_db, _cfg, _log, opts = {}) => {
      runs.push({ now: opts.now!.toISOString(), storiesOnly: opts.storiesOnly === true });
      return { written: 3, problems: 0 };
    },
  };
  return {
    state,
    runs,
    deps,
    full: () => runs.filter((r) => !r.storiesOnly),
    at: (iso: string) => collectInsightsIfDue(noDb, log, new Date(iso), deps),
    hold: () => {
      claimed = true;
    },
  };
}

beforeEach(() => resetInsightsCollectMemory());

describe("collectInsightsIfDue", () => {
  it("collectInsightsIfDue: does nothing before 10:00 Lagos", async () => {
    const h = harness();
    // 08:59 UTC is 09:59 in Lagos.
    expect(await h.at("2026-11-19T08:59:00Z")).toBe("stories");
    expect(h.full()).toHaveLength(0);
    expect(h.state).toEqual({ last_daily_run_day: null, last_run_at: null, refresh_requested_at: null });
    // The next tick, still before 10:00 Lagos and within the hour of the stories pass: nothing at all.
    expect(await h.at("2026-11-19T08:59:30Z")).toBe("idle");
    expect(h.runs).toHaveLength(1);
  });

  it("collectInsightsIfDue: runs once after 10:00 and not again the same day", async () => {
    const h = harness();
    // 09:00 UTC is 10:00 in Lagos.
    expect(await h.at("2026-11-19T09:00:00Z")).toBe("full");
    expect(h.full()).toEqual([{ now: "2026-11-19T09:00:00.000Z", storiesOnly: false }]);
    expect(h.state).toEqual({ last_daily_run_day: "2026-11-19", last_run_at: "2026-11-19T09:00:00.000Z", refresh_requested_at: null });

    // The rest of the Lagos day (it ends at 23:00 UTC): no second full collection.
    for (const t of ["2026-11-19T09:10:00Z", "2026-11-19T15:00:00Z", "2026-11-19T22:59:00Z"]) await h.at(t);
    expect(h.full()).toHaveLength(1);
    // 23:30 UTC is 00:30 on the 20th in Lagos: a new day, but before 10:00.
    await h.at("2026-11-19T23:30:00Z");
    expect(h.full()).toHaveLength(1);
    // 10:00 Lagos on the 20th: the next daily collection.
    expect(await h.at("2026-11-20T09:00:00Z")).toBe("full");
    expect(h.full()).toHaveLength(2);
    expect(h.state.last_daily_run_day).toBe("2026-11-20");
  });

  it("collectInsightsIfDue: a refresh request triggers a run at any hour", async () => {
    // 02:00 UTC is 03:00 in Lagos; today's daily collection has not happened yet.
    const h = harness({ last_daily_run_day: "2026-11-18", last_run_at: "2026-11-18T09:00:00.000Z", refresh_requested_at: "2026-11-19T01:58:00.000Z" });
    expect(await h.at("2026-11-19T02:00:00Z")).toBe("full");
    expect(h.full()).toHaveLength(1);
    // A refresh is not the daily collection: the daily marker is untouched, the request is cleared.
    expect(h.state).toEqual({ last_daily_run_day: "2026-11-18", last_run_at: "2026-11-19T02:00:00.000Z", refresh_requested_at: null });
    // So the daily collection still happens at 10:00 Lagos.
    expect(await h.at("2026-11-19T09:00:00Z")).toBe("full");
    expect(h.state.last_daily_run_day).toBe("2026-11-19");
  });

  it("an old refresh request (already served) does not trigger a run", async () => {
    const h = harness({ last_daily_run_day: "2026-11-19", last_run_at: "2026-11-19T09:00:00.000Z", refresh_requested_at: "2026-11-19T08:00:00.000Z" });
    expect(await h.at("2026-11-19T12:00:00Z")).toBe("stories");
    expect(h.full()).toHaveLength(0);
  });

  it("measures stories at most once an hour between full collections", async () => {
    const h = harness({ last_daily_run_day: "2026-11-19", last_run_at: "2026-11-19T09:00:00.000Z" });
    expect(await h.at("2026-11-19T12:00:00Z")).toBe("stories");
    expect(await h.at("2026-11-19T12:10:00Z")).toBe("idle");
    expect(await h.at("2026-11-19T12:59:00Z")).toBe("idle");
    expect(await h.at("2026-11-19T13:00:00Z")).toBe("stories");
    expect(h.runs).toEqual([
      { now: "2026-11-19T12:00:00.000Z", storiesOnly: true },
      { now: "2026-11-19T13:00:00.000Z", storiesOnly: true },
    ]);
    // A stories-only pass never changes when the figures were "last updated".
    expect(h.state.last_run_at).toBe("2026-11-19T09:00:00.000Z");
  });

  it("does nothing without a Meta token, and nothing while another worker is collecting", async () => {
    const h = harness();
    expect(await collectInsightsIfDue(noDb, log, new Date("2026-11-19T09:00:00Z"), { ...h.deps, cfg: null })).toBe("no_meta");
    h.hold();
    expect(await h.at("2026-11-19T09:00:00Z")).toBe("busy");
    expect(h.runs).toHaveLength(0);
    expect(h.state.last_daily_run_day).toBeNull();
  });

  it("gives the marker back when the collection throws, and leaves the day to be tried again", async () => {
    const h = harness();
    let failed = false;
    const run: InsightsCollectDeps["run"] = async () => {
      failed = true;
      throw new Error("database went away");
    };
    await expect(collectInsightsIfDue(noDb, log, new Date("2026-11-19T09:00:00Z"), { ...h.deps, run })).rejects.toThrow("database went away");
    expect(failed).toBe(true);
    expect(h.state.last_daily_run_day).toBeNull();
    // The marker was released, so the next tick collects.
    expect(await h.at("2026-11-19T09:10:00Z")).toBe("full");
  });
});

describe("insightsRunDue", () => {
  const none: Top = { last_daily_run_day: null, last_run_at: null, refresh_requested_at: null };
  it("follows the Lagos clock, whatever zone the machine is in", () => {
    expect(insightsRunDue(none, new Date("2026-11-19T08:59:59Z"))).toBeNull();
    expect(insightsRunDue(none, new Date("2026-11-19T09:00:00Z"))).toEqual({ daily: true, refresh: false });
    // 23:30 UTC on the 19th is the 20th in Lagos, 00:30: the 19th's run does not count for the 20th, but it is too early.
    expect(insightsRunDue({ ...none, last_daily_run_day: "2026-11-19" }, new Date("2026-11-19T23:30:00Z"))).toBeNull();
    expect(insightsRunDue({ ...none, last_daily_run_day: "2026-11-19" }, new Date("2026-11-20T09:00:00Z"))).toEqual({ daily: true, refresh: false });
    expect(insightsRunDue({ ...none, last_daily_run_day: "2026-11-19" }, new Date("2026-11-19T22:00:00Z"))).toBeNull();
  });
  it("a refresh counts only when it is newer than the last run", () => {
    expect(insightsRunDue({ ...none, refresh_requested_at: "2026-11-19T01:00:00.000Z" }, new Date("2026-11-19T01:05:00Z"))).toEqual({ daily: false, refresh: true });
    expect(
      insightsRunDue({ last_daily_run_day: "2026-11-19", last_run_at: "2026-11-19T09:00:00.000Z", refresh_requested_at: "2026-11-19T08:00:00.000Z" }, new Date("2026-11-19T12:00:00Z")),
    ).toBeNull();
  });
});
