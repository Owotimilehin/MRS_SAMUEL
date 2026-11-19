import { describe, it, expect } from "vitest";
import { blanksIn } from "./template-draft.js";
import { STARTER_TEMPLATES } from "./template-starter.js";

describe("starter templates", () => {
  it("has the seven starter templates, all drafts in English", () => {
    expect(STARTER_TEMPLATES.map((s) => s.key)).toEqual([
      "conversation_reopen",
      "order_confirmed",
      "order_out_for_delivery",
      "order_delivered",
      "missed_call_followup",
      "payment_reminder",
      "preorder_ready",
    ]);
    for (const s of STARTER_TEMPLATES) {
      expect(s.language).toBe("en");
      expect(s.category).toBe("UTILITY");
      expect(s.name).toBe(s.key);
    }
  });
  it("every starter body obeys the blank rules and is under 1024 characters", () => {
    for (const s of STARTER_TEMPLATES) {
      const t = s.draft.body.text;
      const n = blanksIn(t);
      expect(n, s.key).toEqual(Array.from({ length: n.length }, (_, i) => i + 1));
      expect(t.length).toBeLessThan(1024);
      expect(t.trim().startsWith("{{"), s.key).toBe(false);
      expect(t.trim().endsWith("}}"), s.key).toBe(false);
      expect(/\}\}\s*\{\{/.test(t), s.key).toBe(false);
      expect(s.draft.body.examples.length, s.key).toBe(n.length);
      expect(s.draft.body.examples.every((e) => e.trim() !== ""), s.key).toBe(true);
    }
  });
  it("missed_call_followup has exactly one blank", () => {
    const s = STARTER_TEMPLATES.find((x) => x.key === "missed_call_followup")!;
    expect(blanksIn(s.draft.body.text)).toEqual([1]);
  });
});
