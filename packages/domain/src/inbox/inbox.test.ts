import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  verifyMetaSignature,
  buildSendPayload,
  renderTemplateBody,
  templateParamCount,
  graph,
  graphRaw,
  getNumberInfo,
  numberMessagingLimit,
  MetaApiError,
  metaConfigFromEnv,
} from "./meta.js";
import { parseInbound } from "./whatsapp-ingest.js";
import { canSeeConversation, type InboxViewer } from "./scope.js";
import type { Capability } from "@ms/shared";

describe("verifyMetaSignature", () => {
  const secret = "app-secret";
  const body = '{"object":"whatsapp_business_account"}';
  const good = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  it("accepts the right signature", () => {
    expect(verifyMetaSignature(body, good, secret)).toBe(true);
  });
  it("rejects a tampered body, wrong secret, missing or malformed header", () => {
    expect(verifyMetaSignature(body + " ", good, secret)).toBe(false);
    expect(verifyMetaSignature(body, good, "other")).toBe(false);
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=zz", secret)).toBe(false);
    expect(verifyMetaSignature(body, good, "")).toBe(false);
  });
});

describe("buildSendPayload", () => {
  it("builds text, media and template payloads", () => {
    expect(buildSendPayload("2347000000000", { type: "text", body: "hi" })).toMatchObject({
      to: "2347000000000",
      type: "text",
      text: { body: "hi" },
    });
    expect(
      buildSendPayload("1", { type: "document", link: "https://x/y.pdf", caption: "inv", filename: "y.pdf" }),
    ).toMatchObject({ type: "document", document: { link: "https://x/y.pdf", caption: "inv", filename: "y.pdf" } });
    expect(buildSendPayload("1", { type: "audio", link: "https://x/a.ogg", caption: "ignored" })).toMatchObject({
      audio: { link: "https://x/a.ogg" },
    });
    expect(
      buildSendPayload("1", { type: "template", name: "missed_call_followup", language: "en", bodyParams: ["Ada"] }),
    ).toMatchObject({
      type: "template",
      template: {
        name: "missed_call_followup",
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }] }],
      },
    });
  });
});

describe("buildSendPayload recipients", () => {
  it("buildSendPayload uses recipient for a BSUID and to for a phone", () => {
    const phone = buildSendPayload("2347000000000", { type: "text", body: "hi" });
    expect(phone).toMatchObject({ messaging_product: "whatsapp", recipient_type: "individual", to: "2347000000000" });
    expect(phone).not.toHaveProperty("recipient");
    const bsuid = buildSendPayload({ bsuid: "US.13491208655302741918" }, { type: "text", body: "hi" });
    expect(bsuid).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      recipient: "US.13491208655302741918",
      type: "text",
      text: { body: "hi" },
    });
    expect(bsuid).not.toHaveProperty("to");
  });
});

describe("graph", () => {
  const cfg = { token: "SYSTEM-TOKEN-TEST", graphVersion: "v23.0" };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses opts.token as the bearer when given, and reports the response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const seen: number[] = [];
    await graph(cfg, "GET", "123?fields=name", undefined, { token: "PAGE-TOKEN-TEST", onResponse: (r) => seen.push(r.status) });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer PAGE-TOKEN-TEST");
    expect(seen).toEqual([200]);
    await graph(cfg, "GET", "123");
    const init2 = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect((init2.headers as Record<string, string>).authorization).toBe("Bearer SYSTEM-TOKEN-TEST");
  });

  it("keeps Meta's code and subcode on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Outside window", code: 10, error_subcode: 2018278 } }), {
            status: 400,
          }),
      ),
    );
    const err = await graph(cfg, "GET", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).code).toBe("10");
    expect((err as MetaApiError).subcode).toBe("2018278");
  });

  it("names Meta (or the caller's service) when it can't connect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
      }),
    );
    await expect(graph(cfg, "GET", "x")).rejects.toThrow("Could not reach Meta");
    await expect(graph(cfg, "GET", "x", undefined, { service: "WhatsApp" })).rejects.toThrow("Could not reach WhatsApp");
  });
});

describe("graphRaw", () => {
  const cfg = { token: "SYSTEM-TOKEN-TEST", graphVersion: "v23.0" };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the raw body with the chosen scheme, headers and timeout, and maps errors like graph", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ h: "H1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = new Uint8Array([1, 2, 3]);
    const out = await graphRaw<{ h: string }>(cfg, "POST", "upload:SESSION", {
      authScheme: "OAuth",
      headers: { file_offset: "0" },
      body: bytes,
      timeoutMs: 60_000,
    });
    expect(out).toEqual({ h: "H1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/upload:SESSION");
    expect((init.headers as Record<string, string>).authorization).toBe("OAuth SYSTEM-TOKEN-TEST");
    expect((init.headers as Record<string, string>).file_offset).toBe("0");
    expect(init.body).toBe(bytes);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Bad", code: 190 } }), { status: 401 })),
    );
    const err = await graphRaw(cfg, "GET", "x", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).code).toBe("190");
    // Bearer is the default scheme.
    const f2 = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f2);
    await graphRaw(cfg, "GET", "y", {});
    expect(((f2.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe(
      "Bearer SYSTEM-TOKEN-TEST",
    );
  });
});

describe("getNumberInfo", () => {
  const cfg = { token: "SYSTEM-TOKEN-TEST", graphVersion: "v23.0" };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the current limit field with the old one, and prefers the current value", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "CONNECTED", whatsapp_business_manager_messaging_limit: "TIER_2K", messaging_limit_tier: "TIER_250" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const info = await getNumberInfo(cfg, "1098765432");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("whatsapp_business_manager_messaging_limit");
    expect(numberMessagingLimit(info)).toBe("TIER_2K");
    expect(numberMessagingLimit({ messaging_limit_tier: "TIER_250" })).toBe("TIER_250");
    expect(numberMessagingLimit({})).toBeNull();
  });

  it("falls back to the old field alone when Meta refuses the new one with code 100", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "nonexisting field", code: 100 } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "CONNECTED", messaging_limit_tier: "TIER_250" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const info = await getNumberInfo(cfg, "1098765432");
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).not.toContain("whatsapp_business_manager_messaging_limit");
    expect(numberMessagingLimit(info)).toBe("TIER_250");
  });

  it("does not hide other refusals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "token", code: 190 } }), { status: 401 })));
    await expect(getNumberInfo(cfg, "1")).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("template rendering", () => {
  const components = [{ type: "BODY", text: "Hi {{1}}, sorry we missed your call about {{2}}." }];
  it("fills variables and counts them", () => {
    expect(renderTemplateBody(components, ["Ada", "juice"])).toBe("Hi Ada, sorry we missed your call about juice.");
    expect(renderTemplateBody(components, ["Ada"])).toBe("Hi Ada, sorry we missed your call about {{2}}.");
    expect(templateParamCount(components)).toBe(2);
    expect(templateParamCount([])).toBe(0);
  });
});

describe("parseInbound", () => {
  it("reads text, media with caption, button replies and unknown types", () => {
    expect(parseInbound({ from: "1", id: "a", type: "text", text: { body: "hello" } })).toMatchObject({
      type: "text",
      body: "hello",
      mediaId: null,
    });
    expect(
      parseInbound({ from: "1", id: "b", type: "image", image: { id: "M1", mime_type: "image/jpeg", caption: "look" } }),
    ).toEqual({ type: "image", body: "look", mediaId: "M1", mediaMime: "image/jpeg", mediaFilename: null });
    expect(
      parseInbound({ from: "1", id: "c", type: "interactive", interactive: { button_reply: { title: "Yes" } } }).body,
    ).toBe("Yes");
    expect(parseInbound({ from: "1", id: "d", type: "button", button: { text: "Stop" } })).toMatchObject({
      type: "interactive",
      body: "Stop",
    });
    expect(parseInbound({ from: "1", id: "e", type: "ephemeral" }).type).toBe("unsupported");
  });

  it("parseInbound turns a system message into type system with its body", () => {
    expect(
      parseInbound({
        from_user_id: "US.2",
        id: "s1",
        type: "system",
        system: { type: "user_changed_user_id", body: "User changed from US.1 to US.2", user_id: "US.2", previous_user_id: "US.1" },
      }),
    ).toEqual({ type: "system", body: "User changed from US.1 to US.2", mediaId: null, mediaMime: null, mediaFilename: null });
    expect(parseInbound({ id: "s2", type: "system" })).toMatchObject({
      type: "system",
      body: "WhatsApp updated this customer's details.",
    });
  });
});

describe("canSeeConversation", () => {
  const base = { phoneNumberId: "N1", teamId: "T1", assigneeId: null as string | null };
  const viewer = (caps: Capability[], extra: Partial<InboxViewer> = {}): InboxViewer => ({
    userId: "U1",
    capabilities: caps,
    teamIds: ["T1"],
    numberIds: ["N1"],
    ...extra,
  });

  it("needs inbox.view at all", () => {
    expect(canSeeConversation(viewer([]), base)).toBe(false);
  });
  it("view_all sees everything on every number", () => {
    expect(canSeeConversation(viewer(["inbox.view", "inbox.view_all"], { numberIds: [] }), { ...base, phoneNumberId: "N9" })).toBe(true);
  });
  it("is blocked on numbers not granted", () => {
    expect(
      canSeeConversation(viewer(["inbox.view", "inbox.view_team"]), { ...base, phoneNumberId: "N2", assigneeId: "U1" }),
    ).toBe(false);
  });
  it("team scope sees the team's threads, not other teams'", () => {
    const v = viewer(["inbox.view", "inbox.view_team"]);
    expect(canSeeConversation(v, { ...base, assigneeId: "U2" })).toBe(true);
    expect(canSeeConversation(v, { ...base, teamId: "T2", assigneeId: "U2" })).toBe(false);
    expect(canSeeConversation(v, { ...base, teamId: "T2", assigneeId: "U1" })).toBe(true);
  });
  it("own scope sees own + unassigned in team only", () => {
    const v = viewer(["inbox.view"]);
    expect(canSeeConversation(v, base)).toBe(true);
    expect(canSeeConversation(v, { ...base, assigneeId: "U1" })).toBe(true);
    expect(canSeeConversation(v, { ...base, assigneeId: "U2" })).toBe(false);
    expect(canSeeConversation(v, { ...base, teamId: null })).toBe(false);
  });
});

describe("whatsappRecipient (rule R13)", () => {
  it("prefers the conversation's WhatsApp identity, then the customer's phone", async () => {
    const { whatsappRecipient } = await import("./send.js");
    expect(whatsappRecipient({ channel: "whatsapp", externalId: "2347090000041" }, "+2347090000040")).toBe("2347090000041");
    expect(whatsappRecipient({ channel: "whatsapp", externalId: "NG.1000000000001" }, null)).toEqual({ bsuid: "NG.1000000000001" });
    expect(whatsappRecipient(null, "0803 123 4567")).toBe("2348031234567");
    expect(whatsappRecipient({ channel: "instagram", externalId: "IGSID" }, null)).toBeNull();
    expect(whatsappRecipient(null, null)).toBeNull();
  });
});

describe("metaConfigFromEnv (spec 02)", () => {
  it("reads META_APP_ID and META_HUMAN_AGENT_ENABLED", () => {
    const base = { META_SYSTEM_USER_TOKEN: "t" } as NodeJS.ProcessEnv;
    expect(metaConfigFromEnv({})).toBeNull();
    const off = metaConfigFromEnv(base)!;
    expect(off.appId).toBeUndefined();
    expect(off.humanAgent).toBe(false);
    const on = metaConfigFromEnv({ ...base, META_APP_ID: "123", META_HUMAN_AGENT_ENABLED: "true" })!;
    expect(on.appId).toBe("123");
    expect(on.humanAgent).toBe(true);
    expect(metaConfigFromEnv({ ...base, META_HUMAN_AGENT_ENABLED: "yes" })!.humanAgent).toBe(false);
  });
});
