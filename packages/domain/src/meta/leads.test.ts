import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildConsent,
  classifyLeadError,
  describeLeadError,
  ensureLeadgenSubscribed,
  fetchForm,
  fetchLeadExtras,
  leadFollowUpBlock,
  leadRetryDelayMs,
  leadTimelineBody,
  listFormLeads,
  listForms,
  mapLeadAnswers,
  type LeadQuestion,
} from "./leads.js";
import { subscribePage, PAGE_WEBHOOK_FIELDS } from "./messaging.js";
import { clearPageTokenCache } from "./accounts.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every network test stubs fetch. Tokens and people here are made up.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };
const NOW = new Date("2026-11-20T09:00:00.000Z");

const QUESTIONS: LeadQuestion[] = [
  { key: "full_name", label: "Full name", type: "FULL_NAME" },
  { key: "email", label: "Email", type: "EMAIL" },
  { key: "phone_number", label: "Phone number", type: "PHONE" },
  { key: "which_juice", label: "Which juice do you want?", type: "CUSTOM", options: [{ key: "a", value: "Pineapple" }] },
];

function metaErr(code: number | null, message = "Meta says no", status = 400): MetaApiError {
  return new MetaApiError(message, status, code === null ? null : String(code), false);
}

describe("mapLeadAnswers", () => {
  it("mapLeadAnswers maps full name, email and phone by question type", () => {
    const r = mapLeadAnswers(
      [
        { name: "phone_number", values: ["+2348030000001"] },
        { name: "email", values: [" Test.Person@Example.com "] },
        { name: "full_name", values: ["Test Person"] },
      ],
      QUESTIONS,
    );
    expect(r.fullName).toBe("Test Person");
    expect(r.email).toBe("test.person@example.com");
    expect(r.phoneRaw).toBe("+2348030000001");
    expect(r.phoneE164).toBe("+2348030000001");
    // In the form's question order, with the form's labels.
    expect(r.answers.map((a) => a.label)).toEqual(["Full name", "Email", "Phone number"]);
  });

  it("mapLeadAnswers joins first and last name when there is no full name", () => {
    const r = mapLeadAnswers(
      [
        { name: "last_name", values: ["Person"] },
        { name: "first_name", values: ["Test"] },
      ],
      [
        { key: "first_name", label: "First name", type: "FIRST_NAME" },
        { key: "last_name", label: "Last name", type: "LAST_NAME" },
      ],
    );
    expect(r.fullName).toBe("Test Person");
    expect(r.email).toBeNull();
    expect(r.phoneE164).toBeNull();
  });

  it("mapLeadAnswers normalises 0803…, 803… and +234… to the same E.164 number", () => {
    const phone = (v: string) => mapLeadAnswers([{ name: "phone_number", values: [v] }], QUESTIONS).phoneE164;
    expect(phone("08030000001")).toBe("+2348030000001");
    expect(phone("8030000001")).toBe("+2348030000001");
    expect(phone("+234 803 000 0001")).toBe("+2348030000001");
  });

  it("mapLeadAnswers keeps a custom question's label and multiple values", () => {
    const r = mapLeadAnswers(
      [
        { name: "which_juice", values: ["Pineapple", "Orange"] },
        { name: "something_new", values: ["x"] },
      ],
      QUESTIONS,
    );
    expect(r.answers).toEqual([
      { key: "which_juice", label: "Which juice do you want?", values: ["Pineapple", "Orange"] },
      // No matching question: appended with the field's own name as its label.
      { key: "something_new", label: "something_new", values: ["x"] },
    ]);
  });

  it("mapLeadAnswers finds a standard question whose key is not the standard name", () => {
    const r = mapLeadAnswers(
      [{ name: "phone_number", values: ["08030000001"] }],
      [{ key: "question_7", label: "Your phone", type: "PHONE" }],
    );
    expect(r.phoneE164).toBe("+2348030000001");
    expect(r.answers).toEqual([{ key: "question_7", label: "Your phone", values: ["08030000001"] }]);
  });

  it("mapLeadAnswers falls back to field names when the form's questions are unknown", () => {
    const r = mapLeadAnswers(
      [
        { name: "full_name", values: ["Test Person"] },
        { name: "phone_number", values: ["08030000001"] },
        { name: "email", values: ["test@example.com"] },
        { name: "which_juice", values: ["Pineapple"] },
      ],
      [],
    );
    expect(r).toMatchObject({ fullName: "Test Person", phoneE164: "+2348030000001", email: "test@example.com" });
    expect(r.answers.map((a) => a.label)).toEqual(["full_name", "phone_number", "email", "which_juice"]);
  });

  it("mapLeadAnswers drops an invalid email and an unusable phone but keeps the raw phone", () => {
    const r = mapLeadAnswers(
      [
        { name: "email", values: ["not an email"] },
        { name: "phone_number", values: ["0123"] },
      ],
      QUESTIONS,
    );
    expect(r.email).toBeNull();
    expect(r.phoneE164).toBeNull();
    expect(r.phoneRaw).toBe("0123");
  });
});

describe("buildConsent", () => {
  const form = {
    name: "Bulk orders",
    privacyPolicyUrl: "https://example.com/privacy",
    disclaimers: [
      { key: "wa_ok", text: "I agree to be contacted on WhatsApp.", is_required: false },
      { key: "news", text: "Send me offers.", is_required: false },
    ],
    whatsappConsentKey: "wa_ok" as string | null,
    consentCoversWhatsapp: false,
  };

  it('buildConsent: ticked consent key gives whatsappConsent true; unticked gives false; the string "true" counts as ticked', () => {
    const ticked = buildConsent(form, [{ checkbox_key: "wa_ok", is_checked: true }], NOW);
    expect(ticked.whatsappConsent).toBe(true);
    expect(ticked.consent).toEqual({
      form_name: "Bulk orders",
      privacy_policy_url: "https://example.com/privacy",
      disclaimers: [
        { key: "wa_ok", text: "I agree to be contacted on WhatsApp.", is_checked: true },
        { key: "news", text: "Send me offers.", is_checked: false },
      ],
      captured_at: "2026-11-20T09:00:00.000Z",
    });
    expect(buildConsent(form, [{ checkbox_key: "wa_ok", is_checked: false }], NOW).whatsappConsent).toBe(false);
    expect(buildConsent(form, [{ checkbox_key: "wa_ok", is_checked: "false" }], NOW).whatsappConsent).toBe(false);
    expect(buildConsent(form, [{ checkbox_key: "wa_ok", is_checked: "true" }], NOW).whatsappConsent).toBe(true);
    // Another box being ticked is not consent for WhatsApp.
    expect(buildConsent(form, [{ checkbox_key: "news", is_checked: true }], NOW).whatsappConsent).toBe(false);
    // No consent key chosen: a tick alone never counts.
    expect(buildConsent({ ...form, whatsappConsentKey: null }, [{ checkbox_key: "wa_ok", is_checked: true }], NOW).whatsappConsent).toBe(false);
    // No answer at all for the chosen box.
    expect(buildConsent(form, [], NOW).whatsappConsent).toBe(false);
  });

  it("buildConsent: consent_covers_whatsapp gives true with no tick-boxes", () => {
    const r = buildConsent({ ...form, disclaimers: [], whatsappConsentKey: null, consentCoversWhatsapp: true }, [], NOW);
    expect(r.whatsappConsent).toBe(true);
    expect(r.consent.disclaimers).toEqual([]);
  });
});

describe("leadTimelineBody", () => {
  it("leadTimelineBody lists name, phone, email, then at most 10 answers", () => {
    const answers = [
      { key: "full_name", label: "Full name", values: ["Test Person"] },
      { key: "phone_number", label: "Phone number", values: ["08030000001"] },
      { key: "email", label: "Email", values: ["test@example.com"] },
      ...Array.from({ length: 12 }, (_, i) => ({ key: `q${i + 1}`, label: `Question ${i + 1}`, values: [`a${i + 1}`, "b"] })),
    ];
    const body = leadTimelineBody("Bulk orders", "ig", {
      fullName: "Test Person",
      phoneRaw: "08030000001",
      email: "test@example.com",
      answers,
    });
    const lines = body.split("\n");
    expect(lines[0]).toBe("Filled in the form “Bulk orders” on Instagram.");
    expect(lines.slice(1, 4)).toEqual(["Name: Test Person", "Phone: 08030000001", "Email: test@example.com"]);
    expect(lines[4]).toBe("Question 1: a1, b");
    expect(lines[13]).toBe("Question 10: a10, b");
    expect(lines[14]).toBe("…and 2 more answers");
    expect(lines).toHaveLength(15);
  });

  it("leadTimelineBody names the place and leaves out what was not given", () => {
    expect(leadTimelineBody("F", "fb", { fullName: null, phoneRaw: null, email: null, answers: [] })).toBe(
      "Filled in the form “F” on Facebook.",
    );
    expect(leadTimelineBody("F", null, { fullName: "A", phoneRaw: null, email: null, answers: [] })).toBe(
      "Filled in the form “F” on a Meta advert.\nName: A",
    );
    const long = leadTimelineBody("F", null, { fullName: null, phoneRaw: null, email: null, answers: [{ key: "q", label: "Q", values: ["x".repeat(500)] }] });
    expect(long.split("\n")[1]!.length).toBe(200);
  });
});

describe("classifyLeadError", () => {
  it("classifyLeadError: 190/10/200/299 and 100-with-permission are config; 80005/4/17/429/5xx temporary; other 100 gone", () => {
    for (const code of [190, 10, 200, 299]) expect(classifyLeadError(metaErr(code))).toBe("config");
    expect(classifyLeadError(metaErr(100, "(#100) Requires pages_manage_ads permission to manage the object"))).toBe("config");
    expect(classifyLeadError(metaErr(100, "This endpoint requires the leads_retrieval permission"))).toBe("config");
    for (const code of [80005, 4, 17]) expect(classifyLeadError(metaErr(code))).toBe("temporary");
    expect(classifyLeadError(metaErr(null, "Too many requests", 429))).toBe("temporary");
    expect(classifyLeadError(metaErr(null, "Meta API 503", 503))).toBe("temporary");
    expect(classifyLeadError(new MetaApiError("No answer from Meta", 0, null, true, "unknown"))).toBe("temporary");
    expect(classifyLeadError(metaErr(100, "Unsupported get request. Object with ID '123' does not exist"))).toBe("gone");
    expect(classifyLeadError(metaErr(368, "Blocked"))).toBe("refusal");
    // Not a Meta error at all (our own trouble): try again later.
    expect(classifyLeadError(new Error("connection reset"))).toBe("temporary");
  });

  it("describeLeadError gives a plain sentence for each kind", () => {
    expect(describeLeadError(metaErr(190)).plain).toBe("Our connection to Meta has expired. Tell the owner.");
    expect(describeLeadError(metaErr(200)).plain).toContain("Leads Access");
    expect(describeLeadError(metaErr(80005))).toEqual({ code: "80005", plain: "Meta is busy. Try again in a few minutes." });
    expect(describeLeadError(metaErr(368, "Blocked")).plain).toBe("Meta refused: “Blocked” (code 368).");
  });

  it("leadRetryDelayMs doubles from 30 seconds and stops at an hour", () => {
    expect(leadRetryDelayMs(0)).toBe(30_000);
    expect(leadRetryDelayMs(1)).toBe(60_000);
    expect(leadRetryDelayMs(3)).toBe(240_000);
    expect(leadRetryDelayMs(7)).toBe(3_600_000);
    expect(leadRetryDelayMs(30)).toBe(3_600_000);
  });
});

describe("leadFollowUpBlock", () => {
  const ok = { phoneE164: "+2348030000001", hasLine: true, whatsappConsent: true, templateApproved: true, followupSentAt: null, again: false };
  it("checks phone, line, consent, template and already-sent in that order", () => {
    expect(leadFollowUpBlock(ok)).toBeNull();
    expect(leadFollowUpBlock({ ...ok, phoneE164: null, hasLine: false, whatsappConsent: false })).toBe("no_phone");
    expect(leadFollowUpBlock({ ...ok, hasLine: false, whatsappConsent: false })).toBe("no_line");
    expect(leadFollowUpBlock({ ...ok, whatsappConsent: false, templateApproved: false })).toBe("no_consent");
    expect(leadFollowUpBlock({ ...ok, templateApproved: false })).toBe("no_template");
    expect(leadFollowUpBlock({ ...ok, followupSentAt: NOW })).toBe("already_sent");
    expect(leadFollowUpBlock({ ...ok, followupSentAt: NOW, again: true })).toBeNull();
    // "Send again" never gets round a missing consent.
    expect(leadFollowUpBlock({ ...ok, followupSentAt: NOW, again: true, whatsappConsent: false })).toBe("no_consent");
  });
});

describe("lead Graph calls", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const calls: { url: string; method: string; auth: string }[] = [];
  function route(rest: (url: string, init: RequestInit) => Response) {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", auth: (init.headers as Record<string, string>).authorization ?? "" });
      if (url.includes("fields=access_token")) return json({ access_token: "PAGE-TOKEN-1" });
      return rest(url, init);
    });
  }
  beforeEach(() => {
    clearPageTokenCache();
    calls.length = 0;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ensureLeadgenSubscribed posts the union of the current fields and leadgen with the Page token", async () => {
    route((url, init) => (init.method === "POST" ? json({ success: "true" }) : json({ data: [{ id: "APP1", subscribed_fields: ["messages", "message_echoes"] }] })));
    const r = await ensureLeadgenSubscribed(cfg, "PAGE-TOKEN-1", "100200300400");
    expect(r).toEqual({ changed: true, fields: ["messages", "message_echoes", "leadgen"] });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://graph.facebook.com/v23.0/100200300400/subscribed_apps?subscribed_fields=messages,message_echoes,leadgen");
    expect(post.auth).toBe("Bearer PAGE-TOKEN-1");
  });

  it("ensureLeadgenSubscribed does nothing when leadgen is already there", async () => {
    route(() => json({ data: [{ id: "APP1", subscribed_fields: [{ name: "messages" }, { name: "leadgen" }] }] }));
    const r = await ensureLeadgenSubscribed(cfg, "PAGE-TOKEN-1", "100200300400");
    expect(r).toEqual({ changed: false, fields: ["messages", "leadgen"] });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("subscribePage keeps extra fields such as leadgen and never repeats one", async () => {
    route(() => json({ success: true }));
    await subscribePage(cfg, "111", ["leadgen", "messages", "not a field"]);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`https://graph.facebook.com/v23.0/111/subscribed_apps?subscribed_fields=${[...PAGE_WEBHOOK_FIELDS, "leadgen"].join(",")}`);
  });

  it("fetchLeadExtras returns {} on any error", async () => {
    route(() => json({ error: { message: "(#100) Tried accessing nonexisting field (ad_name)", code: 100 } }, 400));
    expect(await fetchLeadExtras(cfg, "PAGE-TOKEN-1", "5550001")).toEqual({});
    route(() => json({ ad_name: "Juice advert", campaign_name: "November", is_organic: false, platform: "IG" }));
    expect(await fetchLeadExtras(cfg, "PAGE-TOKEN-1", "5550001")).toEqual({
      ad_name: "Juice advert",
      campaign_name: "November",
      is_organic: false,
      platform: "ig",
    });
  });

  it("fetchForm reads the questions and ignores a failure of the optional second call", async () => {
    route((url) =>
      url.includes("fields=id,name,questions")
        ? json({ id: "7770001", name: "Bulk orders", questions: [{ key: "full_name", label: "Full name", type: "FULL_NAME" }] })
        : json({ error: { message: "Unknown field", code: 100 } }, 400),
    );
    expect(await fetchForm(cfg, "PAGE-TOKEN-1", "7770001")).toEqual({
      id: "7770001",
      name: "Bulk orders",
      questions: [{ key: "full_name", label: "Full name", type: "FULL_NAME" }],
      disclaimers: [],
    });
    route((url) =>
      url.includes("fields=id,name,questions")
        ? json({ id: "7770001", name: "Bulk orders", questions: [] })
        : json({
            status: "ACTIVE",
            locale: "en_GB",
            legal_content: {
              privacy_policy: { url: "https://example.com/privacy" },
              custom_disclaimer: { checkboxes: [{ key: "wa_ok", text: "I agree.", is_required: false }] },
            },
          }),
    );
    expect(await fetchForm(cfg, "PAGE-TOKEN-1", "7770001")).toMatchObject({
      status: "ACTIVE",
      locale: "en_GB",
      privacy_policy_url: "https://example.com/privacy",
      disclaimers: [{ key: "wa_ok", text: "I agree.", is_required: false }],
    });
  });

  it("listForms follows paging and listFormLeads sends the time filter and the cursor", async () => {
    route((url) => {
      if (url.includes("/leadgen_forms") && !url.includes("after=")) {
        return json({ data: [{ id: "7770001", name: "A" }], paging: { next: "https://graph.facebook.com/v23.0/100200300400/leadgen_forms?fields=id,name&limit=100&after=CUR" } });
      }
      if (url.includes("/leadgen_forms")) return json({ data: [{ id: "7770002", name: "B" }] });
      return json({ data: [{ id: "5550001", field_data: [] }], paging: { cursors: { after: "NEXT" }, next: "https://graph.facebook.com/next" } });
    });
    expect(await listForms(cfg, "PAGE-TOKEN-1", "100200300400")).toEqual([
      { id: "7770001", name: "A" },
      { id: "7770002", name: "B" },
    ]);
    const page = await listFormLeads(cfg, "PAGE-TOKEN-1", "7770001", { sinceUnix: 1700000000, after: "CUR1" });
    expect(page.after).toBe("NEXT");
    const url = new URL(calls.at(-1)!.url);
    expect(url.pathname).toBe("/v23.0/7770001/leads");
    expect(JSON.parse(url.searchParams.get("filtering")!)).toEqual([{ field: "time_created", operator: "GREATER_THAN", value: 1700000000 }]);
    expect(url.searchParams.get("after")).toBe("CUR1");
    // The last page has a cursor but no "next": the back-fill is finished.
    route(() => json({ data: [{ id: "5550002", field_data: [] }], paging: { cursors: { after: "LAST" } } }));
    expect((await listFormLeads(cfg, "PAGE-TOKEN-1", "7770001", { sinceUnix: 1700000000 })).after).toBeNull();
  });
});
