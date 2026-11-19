import { describe, it, expect } from "vitest";
import type { WaInboundMessage } from "../inbox/whatsapp-ingest.js";
import { flowResponseCard, flowResponseData, parseFlowReply } from "./flow-responses.js";

const nfm = (response_json: unknown): WaInboundMessage =>
  ({ id: "wamid.F1", from: "2347000000000", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json } } }) as WaInboundMessage;

describe("form answers (suite spec 07, section 5.6)", () => {
  it("parseFlowReply reads response_json and the token", () => {
    const r = parseFlowReply(nfm(JSON.stringify({ flow_token: "tok.1", flow_key: "complaint", problem_type: "late" })));
    expect(r).toEqual({ responseJson: { flow_token: "tok.1", flow_key: "complaint", problem_type: "late" }, flowToken: "tok.1" });
    expect(parseFlowReply(nfm(JSON.stringify({ a: 1 })))!.flowToken).toBeNull();
    // Not a form answer.
    expect(parseFlowReply({ id: "x", type: "text", text: { body: "hi" } })).toBeNull();
    expect(parseFlowReply({ id: "x", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "1", title: "Yes" } } })).toBeNull();
  });

  it("parseFlowReply survives invalid JSON", () => {
    expect(parseFlowReply(nfm("{not json"))).toEqual({ responseJson: { _raw: "{not json" }, flowToken: null });
    expect(parseFlowReply(nfm("[1,2]"))).toEqual({ responseJson: { _raw: "[1,2]" }, flowToken: null });
    expect(parseFlowReply(nfm(undefined))).toEqual({ responseJson: { _raw: "" }, flowToken: null });
    expect(parseFlowReply(nfm("x".repeat(5000)))!.responseJson._raw).toHaveLength(2000);
  });

  it("flowResponseData drops the token and the key, cuts long values and stops at 40 keys", () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, "v"]));
    const data = flowResponseData({ flow_token: "t", flow_key: "complaint", note: "n".repeat(3000), count: 3, empty: null, ...many });
    expect(data.flow_token).toBeUndefined();
    expect(data.flow_key).toBeUndefined();
    expect(data.empty).toBeUndefined();
    expect((data.note as string).length).toBe(2000);
    expect(data.count).toBe(3);
    expect(Object.keys(data)).toHaveLength(40);
  });

  it("flowResponseCard orders rows by the registry, maps choice ids to titles, and lists unknown keys last", () => {
    const card = flowResponseCard("complaint", { extra: "x", wanted: "refund", what_happened: "It leaked\nall over", problem_type: "damaged" });
    expect(card.title).toBe("Report a problem");
    expect(card.rows.map((r) => [r.label, r.value])).toEqual([
      ["Problem", "Damaged or leaking"],
      ["What happened", "It leaked\nall over"],
      ["They would like", "A refund"],
      ["Other: extra", "x"],
    ]);
    expect(flowResponseCard("bulk_order", { needed_by: "2026-11-20" }).rows).toEqual([{ label: "Needed by", value: "Fri 20 Nov 2026", kind: "date" }]);
  });

  it("flowResponseCard hides flow_token and flow_key", () => {
    const card = flowResponseCard("pickup_request", { flow_token: "t", flow_key: "pickup_request", collector_name: "Test Person" });
    expect(card.rows).toEqual([{ label: "Collected by", value: "Test Person", kind: "text" }]);
    expect(flowResponseCard("unknown", { _raw: "{x" })).toEqual({ title: "Form", rows: [{ label: "Answer", value: "{x", kind: "longtext" }] });
  });
});
