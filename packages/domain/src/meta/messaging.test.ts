import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildMetaSendPayload,
  classifyMessagingError,
  fetchSenderProfile,
  isPageSubscribed,
  PAGE_WEBHOOK_FIELDS,
  sendMetaMessage,
  sendSenderAction,
  subscribePage,
  type MetaErrorClass,
} from "./messaging.js";
import { clearPageTokenCache } from "./accounts.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every test stubs fetch. Tokens here are obviously fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function metaError(code: number, subcode?: number, message = "Meta says no", status = 400): Response {
  return json({ error: { message, code, ...(subcode ? { error_subcode: subcode } : {}) } }, status);
}

let fetchMock: ReturnType<typeof vi.fn>;
let pageTokenNo = 0;

beforeEach(() => {
  clearPageTokenCache();
  pageTokenNo = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer the Page-token look-up, then hand everything else to `rest`. */
function route(rest: (url: string, init: RequestInit) => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.includes("fields=access_token")) return json({ access_token: `PAGE-TOKEN-${++pageTokenNo}` });
    return rest(url, init);
  });
}
const authOf = (init: RequestInit) => (init.headers as Record<string, string>).authorization;

describe("buildMetaSendPayload", () => {
  it("buildMetaSendPayload builds a RESPONSE text", () => {
    expect(buildMetaSendPayload("PSID1", { type: "text", body: "Hi" }, { humanAgent: false })).toEqual({
      recipient: { id: "PSID1" },
      messaging_type: "RESPONSE",
      message: { text: "Hi" },
    });
  });
  it("buildMetaSendPayload maps document to a file attachment with is_reusable false", () => {
    expect(
      buildMetaSendPayload("PSID1", { type: "document", link: "https://files.example/a.pdf" }, { humanAgent: false }),
    ).toEqual({
      recipient: { id: "PSID1" },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "file", payload: { url: "https://files.example/a.pdf", is_reusable: false } } },
    });
    const img = buildMetaSendPayload("X", { type: "image", link: "https://f/i.png" }, { humanAgent: false });
    expect((img.message as { attachment: { type: string } }).attachment.type).toBe("image");
  });
  it("buildMetaSendPayload adds MESSAGE_TAG and HUMAN_AGENT when humanAgent is true", () => {
    const p = buildMetaSendPayload("PSID1", { type: "text", body: "Hi" }, { humanAgent: true });
    expect(p.messaging_type).toBe("MESSAGE_TAG");
    expect(p.tag).toBe("HUMAN_AGENT");
  });
  it("buildMetaSendPayload includes metadata only when given", () => {
    const without = buildMetaSendPayload("P", { type: "text", body: "Hi" }, { humanAgent: false });
    expect("metadata" in (without.message as object)).toBe(false);
    const withMeta = buildMetaSendPayload("P", { type: "text", body: "Hi" }, { humanAgent: false, metadata: "suite:abc" });
    expect((withMeta.message as { metadata: string }).metadata).toBe("suite:abc");
    expect("tag" in withMeta).toBe(false);
  });
});

describe("classifyMessagingError", () => {
  const cases: [string, number | null, number | null, MetaErrorClass, string, number?][] = [
    ["190", 190, null, "config", "Our connection to Meta has expired. The owner has been told."],
    ["10/2018278", 10, 2018278, "refusal", "Messenger refused this: it is more than 24 hours since the customer last wrote."],
    ["10/2018065", 10, 2018065, "refusal", "Messenger refused this: it is more than 24 hours since the customer last wrote."],
    ["10/2534022", 10, 2534022, "refusal", "Messenger refused this: it is more than 24 hours since the customer last wrote."],
    ["10/2018108", 10, 2018108, "refusal", "This person can't receive messages from us right now. They may have blocked us or closed their account."],
    ["200/1545041", 200, 1545041, "refusal", "This person can't receive messages from us right now. They may have blocked us or closed their account."],
    ["551", 551, 1545041, "refusal", "This person can't receive messages from us right now. They may have blocked us or closed their account."],
    ["10/2018300", 10, 2018300, "refusal", "Another app is handling this chat for the Page. Ask the owner to check Conversation routing in Meta Business Suite."],
    ["100/2534037", 100, 2534037, "refusal", "Another app is handling this chat for the Page. Ask the owner to check Conversation routing in Meta Business Suite."],
    ["10/1893063", 10, 1893063, "config", "Meta has paused messaging on Facebook Page. The owner has been told."],
    ["2022", 2022, null, "config", "Meta has paused messaging on Facebook Page. The owner has been told."],
    ["10/2534077", 10, 2534077, "config", "Instagram is no longer linked to the Facebook Page. The owner has been told."],
    ["100/2534013", 100, 2534013, "config", "Instagram is no longer linked to the Facebook Page. The owner has been told."],
    ["200/2534041", 200, 2534041, "config", "Message access is switched off in the Instagram app. The owner has been told."],
    ["200/2018028", 200, 2018028, "config", "Meta has not yet approved us to message people outside the test team."],
    ["200", 200, null, "config", "Meta has not yet approved us to message people outside the test team."],
    ["10", 10, 12345, "config", "Meta says we are not allowed to do this. The owner has been told."],
    ["299", 299, null, "config", "Meta says we are not allowed to do this. The owner has been told."],
    ["36103", 36103, null, "config", "Meta says we are not allowed to do this. The owner has been told."],
    ["100/2018001", 100, 2018001, "refusal", "Messenger can't find this person any more."],
    ["100/2534014", 100, 2534014, "refusal", "Messenger can't find this person any more."],
    ["100/2018008", 100, 2018008, "refusal", "Messenger couldn't collect the file. Try sending it again."],
    ["100/2018294", 100, 2018294, "refusal", "Messenger couldn't collect the file. Try sending it again."],
    ["100/2018047", 100, 2018047, "refusal", "Messenger doesn't accept this file (wrong type or too large)."],
    ["100/2018109", 100, 2018109, "refusal", "Messenger doesn't accept this file (wrong type or too large)."],
    ["100", 100, 9, "refusal", "Messenger refused this message."],
    ["4", 4, null, "temporary", "Messenger is busy. Try again in a minute."],
    ["17", 17, null, "temporary", "Messenger is busy. Try again in a minute."],
    ["32", 32, null, "temporary", "Messenger is busy. Try again in a minute."],
    ["613", 613, null, "temporary", "Messenger is busy. Try again in a minute."],
    ["80007", 80007, null, "temporary", "Messenger is busy. Try again in a minute."],
    ["1", 1, null, "temporary", "Messenger is busy. Try again in a minute."],
    ["2", 2, null, "temporary", "Messenger is busy. Try again in a minute."],
    ["HTTP 429", 999, null, "temporary", "Messenger is busy. Try again in a minute.", 429],
    ["HTTP 503", 999, null, "temporary", "Messenger is busy. Try again in a minute.", 503],
    ["anything else", 12, null, "refusal", "Messenger refused this message."],
  ];
  for (const [name, code, sub, cls, text, status] of cases) {
    it(`classifies ${name} as ${cls}`, () => {
      const err = new MetaApiError("x", status ?? 400, code === null ? null : String(code), false, "not_sent", sub === null ? null : String(sub));
      const r = classifyMessagingError(err, "Messenger", "Facebook Page");
      expect(r.cls).toBe(cls);
      expect(r.staffText).toBe(text);
      expect(r.retryable).toBe(cls === "temporary" || name === "100/2018008" || name === "100/2018294");
    });
  }
  it("classifies no answer as an unconfirmed refusal that is never retried", () => {
    const err = new MetaApiError("No answer from Meta", 0, null, true, "unknown");
    const r = classifyMessagingError(err, "Instagram", "Instagram");
    expect(r).toMatchObject({ cls: "refusal", retryable: false });
  });
});

describe("sendMetaMessage", () => {
  it("posts to {page}/messages with the Page token and returns the message id", async () => {
    route(async (url, init) => {
      expect(url).toBe("https://graph.facebook.com/v23.0/111/messages");
      expect(authOf(init)).toBe("Bearer PAGE-TOKEN-1");
      expect(JSON.parse(String(init.body))).toMatchObject({ recipient: { id: "PSID" }, messaging_type: "RESPONSE" });
      return json({ recipient_id: "PSID", message_id: "m_1" });
    });
    expect(await sendMetaMessage(cfg, "111", "PSID", { type: "text", body: "Hi" }, { humanAgent: false })).toBe("m_1");
  });

  it("sendMetaMessage retries once with a fresh page token after code 190", async () => {
    const seen: string[] = [];
    route(async (_url, init) => {
      seen.push(authOf(init)!);
      return seen.length === 1 ? metaError(190, undefined, "expired", 401) : json({ message_id: "m_2" });
    });
    expect(await sendMetaMessage(cfg, "111", "PSID", { type: "text", body: "Hi" }, { humanAgent: false })).toBe("m_2");
    expect(seen).toEqual(["Bearer PAGE-TOKEN-1", "Bearer PAGE-TOKEN-2"]);
  });

  it("does not retry a second 190", async () => {
    route(async () => metaError(190, undefined, "expired", 401));
    await expect(sendMetaMessage(cfg, "111", "P", { type: "text", body: "Hi" }, { humanAgent: false })).rejects.toMatchObject({
      code: "190",
    });
    expect(fetchMock.mock.calls.filter(([u]) => !String(u).includes("access_token"))).toHaveLength(2);
  });

  it("sendSenderAction posts only the action", async () => {
    route(async (_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ recipient: { id: "PSID" }, sender_action: "mark_seen" });
      return json({ recipient_id: "PSID" });
    });
    await sendSenderAction(cfg, "111", "PSID", "mark_seen");
  });
});

describe("fetchSenderProfile", () => {
  it("reads Messenger first and last name and Instagram username", async () => {
    route(async (url) =>
      url.includes("first_name")
        ? json({ first_name: "Ada", last_name: "Obi", profile_pic: "https://cdn.example/p.jpg" })
        : json({ name: null, username: "ada_o", profile_pic: null }),
    );
    expect(await fetchSenderProfile(cfg, "messenger", "111", "PSID")).toEqual({
      displayName: "Ada Obi",
      username: null,
      profilePicUrl: "https://cdn.example/p.jpg",
    });
    expect(await fetchSenderProfile(cfg, "instagram", "111", "IGSID")).toEqual({
      displayName: null,
      username: "ada_o",
      profilePicUrl: null,
    });
  });

  it("fetchSenderProfile returns nulls for an empty object, for 2018218 and for a consent error, and throws on a rate limit", async () => {
    const empty = { displayName: null, username: null, profilePicUrl: null };
    route(async () => json({}));
    expect(await fetchSenderProfile(cfg, "messenger", "111", "A")).toEqual(empty);
    route(async () => metaError(2018218, undefined, "No profile available for this user"));
    expect(await fetchSenderProfile(cfg, "messenger", "111", "B")).toEqual(empty);
    route(async () => metaError(230, undefined, "User consent is required to access the user profile"));
    expect(await fetchSenderProfile(cfg, "instagram", "111", "C")).toEqual(empty);
    route(async () => metaError(100, 33, "Unsupported get request"));
    expect(await fetchSenderProfile(cfg, "instagram", "111", "D")).toEqual(empty);
    route(async () => metaError(613, undefined, "Calls to this api have exceeded the rate limit."));
    await expect(fetchSenderProfile(cfg, "messenger", "111", "E")).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("page subscription", () => {
  const all = [...PAGE_WEBHOOK_FIELDS];
  it("isPageSubscribed is false when a field is missing", async () => {
    route(async () => json({ data: [{ id: "APP1", subscribed_fields: all.slice(1) }] }));
    expect(await isPageSubscribed({ ...cfg, appId: "APP1" }, "111")).toBe(false);
  });
  it("isPageSubscribed looks only at our app when the app id is known", async () => {
    route(async () => json({ data: [{ id: "OTHER", subscribed_fields: all }] }));
    expect(await isPageSubscribed({ ...cfg, appId: "APP1" }, "111")).toBe(false);
    expect(await isPageSubscribed(cfg, "111")).toBe(true);
    route(async () => json({ data: [{ id: "APP1", subscribed_fields: all.map((name) => ({ name })) }] }));
    expect(await isPageSubscribed({ ...cfg, appId: "APP1" }, "111")).toBe(true);
  });
  it("subscribePage posts every field with the Page token", async () => {
    route(async (url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toBe(`https://graph.facebook.com/v23.0/111/subscribed_apps?subscribed_fields=${all.join(",")}`);
      expect(authOf(init)).toBe("Bearer PAGE-TOKEN-1");
      return json({ success: true });
    });
    await subscribePage(cfg, "111");
  });
});
