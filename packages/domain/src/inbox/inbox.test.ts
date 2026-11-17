import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyMetaSignature, buildSendPayload, renderTemplateBody, templateParamCount } from "./meta.js";
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
