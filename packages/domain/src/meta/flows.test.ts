import { afterEach, describe, it, expect, vi } from "vitest";
import { MetaApiError, type MetaConfig } from "../inbox/meta.js";
import {
  cleanFlowErrors,
  createFlow,
  deleteDraftFlow,
  deprecateFlow,
  explainFlowError,
  flowPreviewUrl,
  getFlow,
  isFlowConfigError,
  listFlows,
  publishFlow,
  uploadFlowJson,
} from "./flows.js";

const cfg: MetaConfig = { token: "test-token", graphVersion: "v23.0" };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(answers: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ?? null };
    calls.push(call);
    const out = answers(call);
    const status = (out as { __status?: number } | null)?.__status ?? 200;
    return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Flows API calls (suite spec 07, section 5.3)", () => {
  it("createFlow posts name, categories and the JSON as a string, and never asks Meta to publish", async () => {
    const calls = stub(() => ({ id: "9001", success: true, validation_errors: [{ error: "X", message: "Bad label", line_start: 3, pointers: [] }] }));
    const out = await createFlow(cfg, "waba1", { name: "ms_complaint", categories: ["CUSTOMER_SUPPORT"], flowJson: '{"version":"7.3"}' });
    expect(out).toEqual({ id: "9001", validationErrors: [{ error: "X", message: "Bad label", line_start: 3 }] });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/waba1/flows");
    expect(calls[0]!.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.body)) as Record<string, unknown>;
    expect(body).toEqual({ name: "ms_complaint", categories: ["CUSTOMER_SUPPORT"], flow_json: '{"version":"7.3"}' });
    expect("publish" in body).toBe(false);
  });

  it("createFlow passes endpoint_uri only when given, and fails when Meta returns no id", async () => {
    const calls = stub(() => ({ id: "9002", success: true }));
    await createFlow(cfg, "waba1", { name: "n", categories: ["OTHER"], flowJson: "{}", endpointUri: "https://api.example.test/v1/webhooks/whatsapp-flows" });
    expect((JSON.parse(String(calls[0]!.body)) as Record<string, unknown>).endpoint_uri).toBe("https://api.example.test/v1/webhooks/whatsapp-flows");
    stub(() => ({ success: true }));
    await expect(createFlow(cfg, "waba1", { name: "n", categories: ["OTHER"], flowJson: "{}" })).rejects.toBeInstanceOf(MetaApiError);
  });

  it("uploadFlowJson sends a multipart form with the file, name and asset type", async () => {
    const calls = stub(() => ({ success: true, validation_errors: [] }));
    expect(await uploadFlowJson(cfg, "9001", '{"version":"7.3"}')).toEqual([]);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/9001/assets");
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("name")).toBe("flow.json");
    expect(form.get("asset_type")).toBe("FLOW_JSON");
    const file = form.get("file") as File;
    expect(file.name).toBe("flow.json");
    expect(await file.text()).toBe('{"version":"7.3"}');
  });

  it("getFlow, listFlows (following cursors) and the preview link", async () => {
    const calls = stub((c) => {
      if (c.url.includes("/waba1/flows")) return { data: [{ id: "1", status: "DRAFT" }], paging: { next: "https://graph.facebook.com/v23.0/next-page" } };
      if (c.url.includes("next-page")) return { data: [{ id: "2", status: "PUBLISHED" }] };
      if (c.url.includes("preview.invalidate")) return { preview: { preview_url: "https://preview.example.test/x", expires_at: "2026-12-20T00:00:00+0000" }, id: "1" };
      return { id: "1", name: "ms_complaint", status: "PUBLISHED", json_version: "7.3" };
    });
    expect((await listFlows(cfg, "waba1")).map((f) => f.id)).toEqual(["1", "2"]);
    expect((await getFlow(cfg, "1")).status).toBe("PUBLISHED");
    expect(calls[2]!.url).toContain("fields=id,name,status,categories,validation_errors,json_version,endpoint_uri");
    expect(await flowPreviewUrl(cfg, "1", false)).toEqual({ url: "https://preview.example.test/x", expiresAt: "2026-12-20T00:00:00+0000" });
    expect(calls[3]!.url).toContain("preview.invalidate(false)");
    await flowPreviewUrl(cfg, "1", true);
    expect(calls[4]!.url).toContain("preview.invalidate(true)");
  });

  it("publish, deprecate and delete call the right address and refuse a success:false answer", async () => {
    const calls = stub(() => ({ success: true }));
    await publishFlow(cfg, "77");
    await deprecateFlow(cfg, "77");
    await deleteDraftFlow(cfg, "77");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://graph.facebook.com/v23.0/", "")}`)).toEqual(["POST 77/publish", "POST 77/deprecate", "DELETE 77"]);
    stub(() => ({ success: false }));
    await expect(publishFlow(cfg, "77")).rejects.toBeInstanceOf(MetaApiError);
  });

  it("cleanFlowErrors keeps only what we show", () => {
    expect(cleanFlowErrors(null)).toEqual([]);
    expect(cleanFlowErrors([{ error: "E", error_type: "T", message: "M", line_start: 1, column_start: 2, pointers: [1], extra: true }, "x"])).toEqual([
      { error: "E", error_type: "T", message: "M", line_start: 1, column_start: 2 },
    ]);
  });

  it("explainFlowError uses the spec's wording", () => {
    const e = (code: string | null, o: { retryable?: boolean; delivery?: "not_sent" | "unknown"; message?: string } = {}): MetaApiError =>
      new MetaApiError(o.message ?? "Meta said no", 400, code, o.retryable ?? false, o.delivery ?? "not_sent");
    for (const code of ["190", "10", "200", "299"]) {
      expect(explainFlowError(e(code))).toBe("WhatsApp would not let us in. The connection needs fixing by the technical lead.");
      expect(isFlowConfigError(e(code))).toBe(true);
    }
    expect(isFlowConfigError(e("100"))).toBe(false);
    expect(explainFlowError(e(null, { delivery: "unknown", retryable: true }))).toBe("WhatsApp did not answer. Check the list in a minute before trying again.");
    expect(explainFlowError(e("4", { retryable: true }))).toBe("WhatsApp did not answer. Check the list in a minute before trying again.");
    expect(explainFlowError(e("132068"))).toBe("WhatsApp has blocked this form because of errors. It cannot be sent until that is fixed.");
    expect(explainFlowError(e("132069"))).toContain("sent 10 times in the last hour");
    expect(explainFlowError(e("131047"))).toBe("More than 24 hours have passed since the customer last wrote. Send a template first.");
    expect(explainFlowError(e("131026"))).toContain("too old to open the form");
    expect(explainFlowError(e("100", { message: "Flow name is not unique" }))).toBe("WhatsApp refused this: Flow name is not unique (Meta 100)");
    expect(explainFlowError(new Error("boom"))).toContain("Something went wrong on our side");
  });
});
