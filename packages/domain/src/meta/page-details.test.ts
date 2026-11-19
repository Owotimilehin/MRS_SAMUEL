import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describePageDetailsError, pageUpdateBody, readPage, updatePage } from "./page-details.js";
import { clearPageTokenCache, type ChannelAccount } from "./accounts.js";
import { MetaApiError } from "../inbox/meta.js";
import { emptyWeek } from "@ms/shared";

// Never the real Graph API: every test stubs fetch. Tokens here are obviously fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };
const account: ChannelAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "messenger",
  label: "Facebook Page",
  externalId: "100200300",
  pageId: "100200300",
  isActive: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("pageUpdateBody", () => {
  const week = { ...emptyWeek(), mon: [{ open: "08:00", close: "18:00" }] };

  it("pageUpdateBody: maps each key; always_open true omits hours; null text becomes \"\"", () => {
    expect(pageUpdateBody({ about: "Hi", description: null, phone: "+2348012345678", website: null })).toEqual({
      about: "Hi",
      description: "",
      phone: "+2348012345678",
      website: "",
    });
    expect(pageUpdateBody({ emails: ["a@x.com"] })).toEqual({ emails: ["a@x.com"] });
    expect(pageUpdateBody({ emails: [] })).toEqual({ emails: [] });
    expect(pageUpdateBody({ always_open: true, hours: week })).toEqual({ is_always_open: true });
    expect(pageUpdateBody({ always_open: false, hours: week })).toEqual({
      is_always_open: false,
      hours: { mon_1_open: "08:00", mon_1_close: "18:00" },
    });
    expect(pageUpdateBody({ hours: week })).toEqual({ hours: { mon_1_open: "08:00", mon_1_close: "18:00" } });
    expect(
      pageUpdateBody({ address: { street: "1 Allen Avenue", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "100271" } }),
    ).toEqual({ location: { street: "1 Allen Avenue", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "100271" } });
    expect(pageUpdateBody({})).toEqual({});
  });

  it("pageUpdateBody: never emits name, username, category_list, cover or is_published", () => {
    const sneaky = {
      about: "x",
      name: "Hacked",
      username: "hacked",
      category_list: ["1"],
      cover: "123",
      is_published: false,
      temporary_status: "permanently_closed",
    } as never;
    expect(Object.keys(pageUpdateBody(sneaky))).toEqual(["about"]);
  });
});

describe("readPage and updatePage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    clearPageTokenCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("readPage: maps Meta's fields and survives a failed picture call", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("fields=access_token")) return json({ access_token: "PAGE-TOKEN-TEST" });
      if (url.includes("/picture")) return json({ error: { message: "nope", code: 100 } }, 400);
      return json({
        id: "100200300",
        name: "Mrs Samuel fruit juice",
        username: "mrssamuel",
        about: "Fresh juice",
        phone: "+2348012345678",
        emails: ["a@x.com"],
        hours: { mon_1_open: "08:00", mon_1_close: "18:00" },
        is_always_open: false,
        location: { street: "1 Allen Avenue", city: "Ikeja", country: "Nigeria" },
        cover: { source: "https://img.example/c.jpg" },
        is_published: true,
        followers_count: 120,
      });
    });
    const snap = await readPage(cfg, account);
    expect(snap).toMatchObject({ name: "Mrs Samuel fruit juice", username: "mrssamuel", picture_url: null, cover_url: "https://img.example/c.jpg", is_published: true });
    expect(snap.editable.address).toEqual({ street: "1 Allen Avenue", city: "Ikeja", state: "", country: "Nigeria", zip: "" });
    expect(snap.editable.hours?.mon).toEqual([{ open: "08:00", close: "18:00" }]);
    expect(snap.editable.description).toBeNull();
    expect(snap.editable.always_open).toBe(false);
  });

  it("updatePage: posts only the mapped body with the Page token", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("fields=access_token")) return json({ access_token: "PAGE-TOKEN-TEST" });
      return json({ success: true });
    });
    await updatePage(cfg, account, { about: "Hello" });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST")!;
    expect(String(post[0])).toBe("https://graph.facebook.com/v23.0/100200300");
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ about: "Hello" });
    expect(((post[1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer PAGE-TOKEN-TEST");
  });
});

describe("describePageDetailsError", () => {
  const e = (code: string | null, status = 400, delivery: "not_sent" | "unknown" = "not_sent", message = "Meta says no") =>
    new MetaApiError(message, status, code, false, delivery);
  it("classifies configuration, temporary, blocked, refusal and no-answer", () => {
    for (const c of ["190", "10", "200", "299", "283", "no_page_token"]) expect(describePageDetailsError(e(c)).cls, c).toBe("config");
    for (const c of ["4", "17", "32", "613", "80001"]) expect(describePageDetailsError(e(c)).cls, c).toBe("temporary");
    expect(describePageDetailsError(e(null, 503)).cls).toBe("temporary");
    expect(describePageDetailsError(e("368")).cls).toBe("blocked");
    const refusal = describePageDetailsError(e("100", 400, "not_sent", "Invalid city"));
    expect(refusal).toMatchObject({ cls: "refusal", text: "Facebook refused this: Invalid city (code 100)." });
    expect(describePageDetailsError(e(null, 0, "unknown", "No answer from Meta")).cls).toBe("unknown");
  });
});
