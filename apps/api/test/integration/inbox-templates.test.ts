import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { inboxMessage, inboxPhoneNumber, inboxTemplate } from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";

/**
 * Templates that need more than body text: the exact JSON handed to Meta for
 * each supported shape, and a clean refusal (no call to Meta) for the rest.
 */

const APP_SECRET = "itest-meta-app-secret";
const WA_NUMBER_ID = "5550001111";
const CUSTOMER = "2347012340001";

const graphCalls: { url: string; body: unknown }[] = [];
let wamidSeq = 0;
function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      graphCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.tpl.out.${++wamidSeq}` }] }), { status: 200 });
    }
    return real(input, init);
  }) as typeof fetch;
}

// Meta's sample templates, as synced.
const TEMPLATES: { name: string; category: string; components: unknown[] }[] = [
  {
    name: "hello_world",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: "Hello World" },
      { type: "BODY", text: "Welcome and congratulations!!" },
      { type: "FOOTER", text: "WhatsApp Business Platform sample message" },
    ],
  },
  {
    name: "jaspers_market_plain_text_v1",
    category: "MARKETING",
    components: [{ type: "BODY", text: "Great news! Your next order at Jasper's Market is 20% off." }],
  },
  {
    name: "jaspers_market_image_cta_v1",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/sample.jpg"] } },
      { type: "BODY", text: "Free delivery for all online orders with Jasper's Market" },
      { type: "FOOTER", text: "Free delivery on orders over $20" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop now", url: "https://www.jaspersmarket.com/" }] },
    ],
  },
  {
    name: "jaspers_market_media_carousel_v1",
    category: "MARKETING",
    components: [
      { type: "BODY", text: "Rare succulents for sale!" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Unsubscribe" }] },
      {
        type: "CAROUSEL",
        cards: [
          {
            components: [
              { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/card1.jpg"] } },
              { type: "BODY", text: "Aloe 'Blue Elf'" },
              { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop", url: "https://www.jaspersmarket.com/blue-elf" }] },
            ],
          },
        ],
      },
    ],
  },
  // Ours: every kind of blank the inbox supports.
  { name: "order_ready", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready." }] },
  {
    name: "order_update",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["A123"] } },
      { type: "BODY", text: "Hi {{1}}, there is news about your order." },
    ],
  },
  {
    name: "track_order",
    category: "UTILITY",
    components: [
      { type: "BODY", text: "Hi {{1}}, follow your delivery here." },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Stop updates" },
          { type: "URL", text: "Track order", url: "https://shop.example/track/{{1}}", example: ["https://shop.example/track/abc"] },
        ],
      },
    ],
  },
];

describe("unified inbox — templates with headings, files and link buttons", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let messagesUrl: string;

  const envelope = (template: Record<string, unknown>) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: CUSTOMER,
    type: "template",
    template,
  });

  async function sendTemplate(body: Record<string, unknown>): Promise<Response> {
    return fetch(messagesUrl, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ type: "template", language: "en", ...body }),
    });
  }

  async function upload(filename: string, contentType: string): Promise<{ object_key: string; media_token: string }> {
    const res = await fetch(`${baseUrl}/v1/inbox/uploads`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ filename, content_type: contentType, size_bytes: 2048 }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { object_key: string; media_token: string } }).data;
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = "itest-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    // Made-up storage settings: links are signed locally, nothing is uploaded or fetched.
    process.env.R2_ACCOUNT_ID = "itestaccount";
    process.env.R2_ACCESS_KEY_ID = "itest-access-key-id";
    process.env.R2_SECRET_ACCESS_KEY = "itest-secret-access-key";
    process.env.R2_BUCKET = "itest-bucket";
    installGraphStub();
    await seedOwner(db);
    await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000100", label: "Main line", channels: "whatsapp", wabaId: "WABA1", waPhoneNumberId: WA_NUMBER_ID });
    await db
      .insert(inboxTemplate)
      .values(TEMPLATES.map((t) => ({ wabaId: "WABA1", language: "en", status: "APPROVED", ...t })));

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    // A customer writes in, which opens the conversation we reply to.
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "2348000000100", phone_number_id: WA_NUMBER_ID },
                contacts: [{ profile: { name: "Ada" }, wa_id: CUSTOMER }],
                messages: [{ from: CUSTOMER, id: "wamid.tpl.in", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hi" } }],
              },
            },
          ],
        },
      ],
    });
    const hook = await fetch(`${baseUrl}/v1/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex"),
      },
      body: raw,
    });
    expect(hook.status).toBe(200);
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.tpl.in"));
    messagesUrl = `${baseUrl}/v1/inbox/conversations/${msg!.conversationId}/messages`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  beforeEach(() => {
    graphCalls.length = 0;
  });

  it("tells the apps what each template needs", async () => {
    const res = await fetch(`${baseUrl}/v1/inbox/templates`, { headers: { cookie: owner } });
    type Row = { name: string; sendable: boolean; unsendable_reason: string | null; header_media: string | null; header_param_count: number; url_buttons: unknown[]; param_count: number };
    const rows = ((await res.json()) as { data: Row[] }).data;
    const by = (name: string): Row => rows.find((r) => r.name === name)!;
    expect(by("hello_world")).toMatchObject({ sendable: true, unsendable_reason: null, header_media: null, header_param_count: 0, url_buttons: [] });
    expect(by("jaspers_market_image_cta_v1")).toMatchObject({ sendable: true, header_media: "image", url_buttons: [] });
    expect(by("jaspers_market_media_carousel_v1")).toMatchObject({
      sendable: false,
      unsendable_reason: "This template has a carousel, which the inbox can't send yet",
    });
    expect(by("order_update")).toMatchObject({ sendable: true, header_param_count: 1, param_count: 1 });
    expect(by("track_order").url_buttons).toEqual([{ index: 1, text: "Track order", url: "https://shop.example/track/{{1}}" }]);
  });

  it("body-only template: no components at all", async () => {
    const res = await sendTemplate({ name: "jaspers_market_plain_text_v1" });
    expect(res.status).toBe(201);
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.url).toBe(`https://graph.facebook.com/v23.0/${WA_NUMBER_ID}/messages`);
    expect(graphCalls[0]!.body).toEqual(envelope({ name: "jaspers_market_plain_text_v1", language: { code: "en" } }));
  });

  it("fixed text heading (hello_world): nothing to fill, no components", async () => {
    const res = await sendTemplate({ name: "hello_world" });
    expect(res.status).toBe(201);
    expect(graphCalls[0]!.body).toEqual(envelope({ name: "hello_world", language: { code: "en" } }));
  });

  it("body blanks", async () => {
    const res = await sendTemplate({ name: "order_ready", params: ["Ada", "A123"] });
    expect(res.status).toBe(201);
    expect(graphCalls[0]!.body).toEqual(
      envelope({
        name: "order_ready",
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }, { type: "text", text: "A123" }] }],
      }),
    );
    expect(((await res.json()) as { data: { body: string } }).data.body).toBe("Hi Ada, your order A123 is ready.");
  });

  it("text heading with a blank: header parameter, then body", async () => {
    const res = await sendTemplate({ name: "order_update", params: ["Ada"], header_param: "A123" });
    expect(res.status).toBe(201);
    expect(graphCalls[0]!.body).toEqual(
      envelope({
        name: "order_update",
        language: { code: "en" },
        components: [
          { type: "header", parameters: [{ type: "text", text: "A123" }] },
          { type: "body", parameters: [{ type: "text", text: "Ada" }] },
        ],
      }),
    );
  });

  it("picture heading: the uploaded picture goes to Meta by link and shows in the timeline", async () => {
    const up = await upload("promo.jpg", "image/jpeg");
    const res = await sendTemplate({
      name: "jaspers_market_image_cta_v1",
      header_media: { media_key: up.object_key, media_token: up.media_token, mime: "image/jpeg", filename: "promo.jpg" },
    });
    expect(res.status).toBe(201);
    expect(graphCalls).toHaveLength(1);
    const sent = graphCalls[0]!.body as { template: { components: { parameters: { image: { link: string } }[] }[] } };
    const link = sent.template.components[0]!.parameters[0]!.image.link;
    expect(link).toContain(up.object_key);
    expect(link.startsWith("https://")).toBe(true);
    // Exactly this and nothing else: one header component, no body or button parameters.
    expect(graphCalls[0]!.body).toEqual(
      envelope({
        name: "jaspers_market_image_cta_v1",
        language: { code: "en" },
        components: [{ type: "header", parameters: [{ type: "image", image: { link } }] }],
      }),
    );

    const { data } = (await res.json()) as { data: { id: string; conversationId: string } };
    const [row] = await db.select().from(inboxMessage).where(eq(inboxMessage.id, data.id));
    expect(row).toMatchObject({ type: "template", status: "sent", mediaKey: up.object_key, mediaMime: "image/jpeg", templateName: "jaspers_market_image_cta_v1" });
    const timeline = (await (await fetch(`${baseUrl}/v1/inbox/conversations/${data.conversationId}/timeline`, { headers: { cookie: owner } })).json()) as {
      data: { data: { id: string; has_media: boolean; media_mime: string | null; auto: string | null } }[];
    };
    const item = timeline.data.find((d) => d.data.id === data.id)!;
    expect(item.data).toMatchObject({ has_media: true, media_mime: "image/jpeg", auto: null });
  });

  it("picture heading: refused in plain words without the picture, or with the wrong kind of file", async () => {
    const none = await sendTemplate({ name: "jaspers_market_image_cta_v1" });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { message: string } }).error.message).toBe("This template needs a picture. Add one, then send");

    const pdf = await upload("menu.pdf", "application/pdf");
    const wrong = await sendTemplate({
      name: "jaspers_market_image_cta_v1",
      header_media: { media_key: pdf.object_key, media_token: pdf.media_token, mime: "application/pdf" },
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toBe("This template needs a picture, not a document");

    const forged = await sendTemplate({
      name: "jaspers_market_image_cta_v1",
      header_media: { media_key: pdf.object_key, media_token: "forged-token-forged-token", mime: "image/jpeg" },
    });
    expect(forged.status).toBe(403);
    expect(graphCalls).toHaveLength(0);
  });

  it("link button with a blank: sub_type url and the button's position", async () => {
    const res = await sendTemplate({ name: "track_order", params: ["Ada"], button_params: [{ index: 1, text: "ORD-778" }] });
    expect(res.status).toBe(201);
    expect(graphCalls[0]!.body).toEqual(
      envelope({
        name: "track_order",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Ada" }] },
          { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "ORD-778" }] },
        ],
      }),
    );
  });

  it("missing blanks are refused before Meta is called", async () => {
    expect((await sendTemplate({ name: "order_ready", params: ["Ada"] })).status).toBe(400);
    expect((await sendTemplate({ name: "order_update", params: ["Ada"] })).status).toBe(400);
    expect((await sendTemplate({ name: "track_order", params: ["Ada"] })).status).toBe(400);
    expect(graphCalls).toHaveLength(0);
  });

  it("a carousel template is refused with a clear reason, with no call to Meta and nothing saved", async () => {
    const before = await db.select().from(inboxMessage);
    const res = await sendTemplate({ name: "jaspers_market_media_carousel_v1" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string; details?: { reason?: string } } };
    expect(body.error.message).toBe("This template has a carousel, which the inbox can't send yet");
    expect(JSON.stringify(body)).toContain("template_unsupported");
    expect(graphCalls).toHaveLength(0);
    expect(await db.select().from(inboxMessage)).toHaveLength(before.length);
  });
});
