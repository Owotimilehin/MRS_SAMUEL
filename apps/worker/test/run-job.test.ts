import { describe, it, expect, vi } from "vitest";
import { runJob } from "../src/jobs/run-job.js";

const fakeLogger = { error: vi.fn() };

describe("runJob", () => {
  it("returns the job result on success", async () => {
    const out = await runJob(fakeLogger, "ok", async () => 42);
    expect(out).toBe(42);
  });

  it("swallows a throw, logs it, and returns undefined", async () => {
    fakeLogger.error.mockClear();
    const out = await runJob(fakeLogger, "boom", async () => {
      throw new Error("kaboom");
    });
    expect(out).toBeUndefined();
    expect(fakeLogger.error).toHaveBeenCalledTimes(1);
    const [obj] = fakeLogger.error.mock.calls[0];
    expect(obj).toMatchObject({ job: "boom" });
  });

  it("does not let one failing job stop the next", async () => {
    const second = vi.fn(async () => "ran");
    await runJob(fakeLogger, "first", async () => { throw new Error("x"); });
    const out = await runJob(fakeLogger, "second", second);
    expect(second).toHaveBeenCalled();
    expect(out).toBe("ran");
  });
});
