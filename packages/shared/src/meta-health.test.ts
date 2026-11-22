import { describe, expect, it } from "vitest";
import { healthBanner, lineHealth, sortHealthItems, worstStatus, type MetaHealthItem } from "./meta-health.js";

const item = (over: Partial<MetaHealthItem>): MetaHealthItem => ({
  key: "line:a",
  kind: "whatsapp_number",
  label: "WhatsApp Main line",
  line_ids: ["a"],
  status: "ok",
  reason: "Connected to WhatsApp.",
  impact: "Customers are getting replies",
  since: "2026-11-22T09:00:00.000Z",
  checked_at: "2026-11-22T10:00:00.000Z",
  alerted_at: null,
  ...over,
});

describe("healthBanner", () => {
  it("shows nothing when everything is ok", () => {
    expect(healthBanner([item({})])).toBeNull();
    expect(healthBanner([])).toBeNull();
  });
  it("is red with one sentence for a broken item: what it means, then why", () => {
    const b = healthBanner([
      item({ status: "broken", impact: "Customers on WhatsApp (Main line) are not getting replies", reason: "Meta has banned this number from WhatsApp." }),
      item({ key: "waba:1", status: "warning", reason: "Meta is still reviewing the WhatsApp account." }),
    ]);
    expect(b).toMatchObject({
      tone: "danger",
      text: "Customers on WhatsApp (Main line) are not getting replies: Meta has banned this number from WhatsApp.",
    });
  });
  it("is amber for warnings only, counts the rest, and lower-cases an ordinary first word", () => {
    const b = healthBanner([
      item({ status: "warning", impact: "WhatsApp messages may be limited", reason: "This number is not fully set up at Meta yet." }),
      item({ key: "line:b", label: "WhatsApp Second", status: "warning", reason: "x" }),
    ]);
    expect(b?.tone).toBe("warning");
    expect(b?.text).toBe("WhatsApp messages may be limited: this number is not fully set up at Meta yet, and 1 more connection needs attention.");
  });
  it("puts the access key first among broken items", () => {
    const b = healthBanner([
      item({ status: "broken", label: "A line", impact: "line impact" }),
      item({ key: "token", kind: "token", label: "Meta access key", status: "broken", impact: "Everything is down", reason: "Key gone." }),
    ]);
    expect(b?.text).toBe("Everything is down: key gone, and 1 more connection needs attention.");
  });
  it("changes its signature when the problems change (a dismissed amber banner comes back)", () => {
    const a = healthBanner([item({ status: "warning", reason: "one" })])!;
    const b = healthBanner([item({ status: "warning", reason: "two" })])!;
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("lineHealth", () => {
  const items = [
    item({ key: "token", kind: "token", line_ids: ["a", "b"], status: "ok" }),
    item({ key: "waba:1", kind: "whatsapp_account", line_ids: ["a"], status: "warning", reason: "Limited." }),
    item({ key: "line:b", line_ids: ["b"], status: "broken", reason: "Banned." }),
  ];
  it("takes the worst of the line's own item, its account and the key", () => {
    expect(lineHealth(items, "a")).toEqual({ status: "warning", reasons: ["Limited."] });
    expect(lineHealth(items, "b")).toEqual({ status: "broken", reasons: ["Banned."] });
    expect(lineHealth(items, "zzz")).toBeNull();
  });
});

describe("worstStatus / sortHealthItems", () => {
  it("orders broken, then warning, then ok", () => {
    const s = sortHealthItems([item({ status: "ok", label: "b" }), item({ status: "broken", label: "c" }), item({ status: "warning", label: "a" })]);
    expect(s.map((i) => i.status)).toEqual(["broken", "warning", "ok"]);
    expect(worstStatus(s)).toBe("broken");
  });
});
