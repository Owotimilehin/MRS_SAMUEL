import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTemplate,
  deleteTemplate,
  editTemplate,
  explainTemplateError,
  findTemplateByName,
  getTemplate,
  isTemplateConfigError,
  listTemplatesFull,
  TEMPLATE_FIELDS,
} from "./templates.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every test stubs fetch. The token below is obviously fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };
const WABA = "100200300";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
type Call = { url: string; method: string; body: unknown };
function stub(handler: (c: Call, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      return handler(call, calls.length - 1);
    }),
  );
  return calls;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTemplate", () => {
  it("createTemplate posts name, language, upper-case category, POSITIONAL and components", async () => {
    const calls = stub(() => json({ id: "555", status: "PENDING", category: "UTILITY" }));
    const components = [{ type: "BODY", text: "Hello" }];
    const res = await createTemplate(cfg, WABA, { name: "hello_there", language: "en", category: "UTILITY", components });
    expect(res).toEqual({ id: "555", status: "PENDING", category: "UTILITY" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/v23.0/${WABA}/message_templates`);
    expect(calls[0]!.body).toEqual({ name: "hello_there", language: "en", category: "UTILITY", parameter_format: "POSITIONAL", components });
  });
  it("takes the category Meta chose and a numeric id", async () => {
    stub(() => json({ id: 777, status: "approved", category: "marketing" }));
    const res = await createTemplate(cfg, WABA, { name: "n", language: "en", category: "UTILITY", components: [] });
    expect(res).toEqual({ id: "777", status: "APPROVED", category: "MARKETING" });
  });
  it("tries the flat body example shape once when Meta answers code 100", async () => {
    const calls = stub((_c, n) => (n === 0 ? json({ error: { message: "Invalid parameter", code: 100 } }, 400) : json({ id: "9", status: "PENDING" })));
    const res = await createTemplate(cfg, WABA, {
      name: "n",
      language: "en",
      category: "UTILITY",
      components: [{ nested: true }],
      altComponents: [{ nested: false }],
    });
    expect(res.id).toBe("9");
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { components: unknown[] }).components).toEqual([{ nested: false }]);
  });
  it("does not retry a duplicate-name refusal", async () => {
    const calls = stub(() => json({ error: { message: "Duplicate", code: 100, error_subcode: 2388024, error_user_msg: "Name taken" } }, 400));
    const err = await createTemplate(cfg, WABA, { name: "n", language: "en", category: "UTILITY", components: [], altComponents: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.subcode).toBe("2388024");
    expect(err.details).toMatchObject({ userMessage: "Name taken" });
    expect(calls).toHaveLength(1);
  });
});

describe("editTemplate and deleteTemplate", () => {
  it("editTemplate posts the components and the category only when given", async () => {
    const calls = stub(() => json({ success: true }));
    await editTemplate(cfg, "555", { components: [{ type: "BODY", text: "x" }] });
    await editTemplate(cfg, "555", { components: [], category: "MARKETING" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/555");
    expect(calls[0]!.body).toEqual({ components: [{ type: "BODY", text: "x" }] });
    expect(calls[1]!.body).toEqual({ components: [], category: "MARKETING" });
  });
  it("deleteTemplate sends hsm_id and name", async () => {
    const calls = stub(() => json({ success: true }));
    await deleteTemplate(cfg, WABA, { id: "555", name: "order_confirmed" });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/v23.0/${WABA}/message_templates?hsm_id=555&name=order_confirmed`);
  });
});

describe("listTemplatesFull and friends", () => {
  it("listTemplatesFull asks for the full field list and follows paging", async () => {
    const calls = stub((c) =>
      c.url.includes("after=2")
        ? json({ data: [{ id: "2", name: "b", language: "en", status: "APPROVED" }] })
        : json({
            data: [{ id: "1", name: "a", language: "en", status: "APPROVED" }],
            paging: { next: `https://graph.facebook.com/v23.0/${WABA}/message_templates?after=2` },
          }),
    );
    const all = await listTemplatesFull(cfg, WABA);
    expect(all.map((t) => t.id)).toEqual(["1", "2"]);
    expect(calls[0]!.url).toContain(`fields=${TEMPLATE_FIELDS}`);
  });
  it("listTemplatesFull falls back to the short field list on code 100", async () => {
    const calls = stub((c) =>
      c.url.includes("quality_score")
        ? json({ error: { message: "Tried accessing nonexisting field", code: 100 } }, 400)
        : json({ data: [{ id: "1", name: "a", language: "en", status: "APPROVED" }] }),
    );
    const all = await listTemplatesFull(cfg, WABA);
    expect(all).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("fields=id,name,language,status,category,components");
    expect(calls[1]!.url).not.toContain("quality_score");
  });
  it("listTemplatesFull does not hide other refusals", async () => {
    stub(() => json({ error: { message: "token", code: 190 } }, 401));
    await expect(listTemplatesFull(cfg, WABA)).rejects.toMatchObject({ code: "190" });
  });
  it("getTemplate reads one template by id", async () => {
    const calls = stub(() => json({ id: "55", name: "a", language: "en", status: "PENDING" }));
    const t = await getTemplate(cfg, "55");
    expect(t.status).toBe("PENDING");
    expect(calls[0]!.url).toContain("/55?fields=");
  });
  it("findTemplateByName matches name and language (en-US written either way)", async () => {
    const calls = stub(() =>
      json({
        data: [
          { id: "1", name: "hello", language: "en", status: "APPROVED" },
          { id: "2", name: "hello", language: "en_US", status: "PENDING" },
        ],
      }),
    );
    expect((await findTemplateByName(cfg, WABA, "hello", "en-US"))?.id).toBe("2");
    expect(await findTemplateByName(cfg, WABA, "hello", "fr")).toBeNull();
    expect(calls[0]!.url).toContain("name=hello");
  });
});

describe("explainTemplateError", () => {
  const refuse = (code: number, subcode?: number, message = "bad") =>
    new MetaApiError(message, 400, String(code), false, "not_sent", subcode ? String(subcode) : null);
  it("explainTemplateError maps each subcode, a timeout and a token error", () => {
    expect(explainTemplateError(refuse(100, 2388024))).toMatch(/^A template with this name and language already exists at WhatsApp\. Press Sync/);
    expect(explainTemplateError(refuse(100, 2388019))).toMatch(/^You have reached WhatsApp's limit/);
    expect(explainTemplateError(refuse(100, 2388039))).toMatch(/^WhatsApp is reviewing this template/);
    expect(explainTemplateError(refuse(100, 2388040))).toMatch(/^One part is too long/);
    expect(explainTemplateError(refuse(100, 2388047))).toMatch(/layout of the heading/);
    expect(explainTemplateError(refuse(100, 2388072))).toMatch(/layout of the message/);
    expect(explainTemplateError(refuse(100, 2388073))).toMatch(/layout of the small print/);
    expect(explainTemplateError(refuse(100, 2388293))).toMatch(/^Too many blanks/);
    expect(explainTemplateError(refuse(100, 2388299))).toMatch(/^The message cannot start or end with a blank\./);
    expect(explainTemplateError(refuse(100, 2388299))).toContain("(Meta 100/2388299");
    expect(explainTemplateError(refuse(80008))).toMatch(/^WhatsApp is busy/);
    expect(explainTemplateError(new MetaApiError("Meta API 503", 503, null, true))).toMatch(/^WhatsApp is busy/);
    expect(explainTemplateError(new MetaApiError("No answer from WhatsApp", 0, null, true, "unknown"))).toBe(
      "WhatsApp did not answer. Nothing was lost. Check the list in a minute before trying again.",
    );
    for (const code of [190, 10, 200, 299]) {
      expect(explainTemplateError(refuse(code))).toMatch(/^WhatsApp would not let us in\./);
    }
  });
  it("falls back to Meta's own words, prefixed, and never to a stack trace", () => {
    expect(explainTemplateError(refuse(100, undefined, "Param components[0] invalid"))).toBe("WhatsApp refused this: Param components[0] invalid (Meta 100)");
    const withUser = new MetaApiError("Invalid parameter", 400, "100", false, "not_sent", null, { userMessage: "The body is too short" });
    expect(explainTemplateError(withUser)).toBe("WhatsApp refused this: The body is too short (Meta 100)");
    expect(explainTemplateError(new Error("boom at /srv/x.ts:1"))).not.toContain("boom");
  });
  it("isTemplateConfigError sees the configuration codes only", () => {
    expect(isTemplateConfigError(refuse(190))).toBe(true);
    expect(isTemplateConfigError(refuse(283))).toBe(true);
    expect(isTemplateConfigError(refuse(100))).toBe(false);
    expect(isTemplateConfigError(new Error("x"))).toBe(false);
  });
});
