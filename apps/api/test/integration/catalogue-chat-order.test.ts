import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  auditLog,
  branch,
  catalogueChatOrder,
  catalogueLink,
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  outboxEvent,
  product,
  productPrice,
  productVariant,
  saleOrder,
  saleOrderItem,
  stockLedger,
  stockReservation,
  type DbClient,
} from "@ms/db";
import { checkOpenBatches, runChatOrderPrompts, runOrderUpdates, syncCatalogue, type MetaConfig } from "@ms/domain";
import { ORDER_TEMPLATE_TEXT } from "@ms/shared";
import { authOwner, makeTestApp, seedUser } from "./helpers.js";

/**
 * Selling in WhatsApp chat (suite spec 08). Neither Meta nor OPay is ever
 * called: Graph requests are answered by the stub below, and OPay's cashier is
 * the fake one every integration test gets (or, in one test, made to fail).
 * Phone numbers are made-up test numbers.
 */
const APP_SECRET = "itest-meta-app-secret";
const cfg: MetaConfig = { token: "itest-token", graphVersion: "v23.0" };
const CATALOG_ID = "123456789012345";
const WABA = "WABA1";
const PNID = "1098765432";
const OPAY_LINK = "https://sandboxcashier.opaycheckout.com/itest";
const log = { info: () => {}, warn: () => {}, error: () => {} };

type GraphCall = { url: string; body: Record<string, unknown> | null };
type Interactive = {
  type: string;
  header?: { type: string; text: string };
  body?: { text: string };
  action: {
    catalog_id?: string;
    product_retailer_id?: string;
    name?: string;
    sections?: { title: string; product_items: { product_retailer_id: string }[] }[];
    buttons?: { type: string; reply: { id: string; title: string } }[];
    parameters?: { display_text?: string; url?: string; thumbnail_product_retailer_id?: string };
  };
};
const graphCalls: GraphCall[] = [];
let messageHandler: ((call: GraphCall) => Response) | null = null;
let opayDown = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function installStubs(): void {
  const next = globalThis.fetch; // already answers OPay's cashier with a fake link
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      const call: GraphCall = { url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
      graphCalls.push(call);
      if (url.includes("/items_batch")) return json({ handles: ["h1"], validation_status: [] });
      if (url.includes("/check_batch_request_status")) return json({ data: [{ handle: "h1", status: "finished", errors_total_count: 0 }] });
      if (url.endsWith("/messages")) {
        if (messageHandler) return messageHandler(call);
        return json({ messages: [{ id: `wamid.out.${graphCalls.length}.${uuid()}` }] });
      }
      return json({ error: { message: "unexpected Graph call in test", code: 100 } }, 400);
    }
    if (opayDown && url.includes("/cashier/create")) throw new DOMException("The operation timed out", "TimeoutError");
    return next(input, init);
  }) as typeof fetch;
}

/** Messages we sent to customers (not catalogue calls). */
const sentMessages = () => graphCalls.filter((c) => c.url.endsWith(`/${PNID}/messages`) && c.body?.["messaging_product"] === "whatsapp");
const interactiveOf = (c: GraphCall) => c.body!["interactive"] as Interactive;

describe("selling in WhatsApp chat", () => {
  let container: StartedPostgreSqlContainer;
  let app: Hono;
  let db: DbClient;
  let branchId: string;
  let owner: Record<string, string>;
  let agent: Record<string, string>;
  let noOrders: Record<string, string>;
  let blind: Record<string, string>;
  // Pineapple Ginger 330ml ₦1,500 (in stock) and 650ml ₦2,800 (none in stock); Zobo 330ml ₦1,200; Party Punch 500ml ₦2,000.
  let pine330: string;
  let pine650: string;
  let zobo330: string;
  let punch500: string;
  let phoneSeq = 0;
  let wamidSeq = 0;

  const rid = (variantId: string) => `v-${variantId}`;
  const newPhone = () => `23480355${String(10000 + ++phoneSeq)}`;
  const newWamid = () => `wamid.itest.${++wamidSeq}.${uuid()}`;

  async function login(email: string): Promise<Record<string, string>> {
    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "userpassword123" }),
    });
    if (!res.ok) throw new Error(`login failed ${res.status}`);
    return { cookie: res.headers.get("set-cookie") ?? "" };
  }

  const call = (who: Record<string, string>, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method,
      headers: { ...who, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function postWebhook(message: Record<string, unknown>, from: string): Promise<void> {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "2348000000000", phone_number_id: PNID },
                contacts: [{ profile: { name: "Ada Test" }, wa_id: from }],
                messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
              },
            },
          ],
        },
      ],
    });
    const res = await app.request("/v1/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex") },
      body: raw,
    });
    expect(res.status).toBe(200);
  }

  type CartItem = { variantId: string; quantity: number; price?: number };
  const cartMessage = (wamid: string, items: CartItem[], text?: string) => ({
    id: wamid,
    type: "order",
    order: {
      catalog_id: CATALOG_ID,
      ...(text ? { text } : {}),
      product_items: items.map((i) => ({ product_retailer_id: rid(i.variantId), quantity: i.quantity, item_price: i.price ?? 1500, currency: "NGN" })),
    },
  });

  /** A customer sends a cart; returns their phone, the conversation and the cart row. */
  async function sendCart(items: CartItem[], opts: { from?: string; text?: string; wamid?: string } = {}) {
    const from = opts.from ?? newPhone();
    const wamid = opts.wamid ?? newWamid();
    await postWebhook(cartMessage(wamid, items, opts.text), from);
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, wamid));
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg!.conversationId));
    const [cart] = await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.waMessageId, wamid));
    return { from, wamid, msg: msg!, conv: conv!, cart: cart! };
  }

  const cartRow = async (id: string) => (await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, id)))[0]!;
  const cartsOf = (conversationId: string) =>
    db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.conversationId, conversationId)).orderBy(desc(catalogueChatOrder.createdAt));
  const ordersOf = (customerId: string) => db.select().from(saleOrder).where(eq(saleOrder.customerId, customerId));
  const setSwitches = (s: { ask?: boolean; updates?: boolean }) =>
    db.update(catalogueLink).set({ askFulfilmentAuto: s.ask ?? false, orderUpdatesEnabled: s.updates ?? false });
  const closeWindow = (conversationId: string) =>
    db.update(inboxConversation).set({ lastInboundWaAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(inboxConversation.id, conversationId));

  const placeBody = (items: { variant_id: string; quantity: number }[], over: Record<string, unknown> = {}) => ({
    fulfilment: "delivery",
    address: "12 Test Close, Lekki Phase 1, Lagos",
    delivery_fee_ngn: 500,
    items,
    ...over,
  });
  type Placed = { data: { order_number: string; total_ngn: number; is_preorder: boolean; payment_link: string | null; warning?: string } };

  beforeAll(async () => {
    const t = await makeTestApp();
    ({ app, db, container } = t);
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = cfg.token;
    process.env.META_GRAPH_VERSION = cfg.graphVersion;
    installStubs();

    await db.insert(inboxPhoneNumber).values({ e164: "+2348000000000", label: "Main line", channels: "both", wabaId: WABA, waPhoneNumberId: PNID });
    const [br] = await db
      .insert(branch)
      .values({ name: "Lekki Branch", code: "LEKKI", address: "1 Admiralty Way, Lekki", isOnlineDefault: true })
      .returning();
    branchId = br!.id;

    async function flavour(name: string, category: "regular" | "special" | "punch", order: number, sizes: { sizeMl: number; priceNgn: number; stock: number }[]) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const [p] = await db.insert(product).values({ name, slug, category, displayOrder: order, imageUrl: "/media/bottles/test.png", tagline: `${name}, freshly pressed.` }).returning();
      const ids: string[] = [];
      for (const s of sizes) {
        const [v] = await db.insert(productVariant).values({ productId: p!.id, sizeMl: s.sizeMl, sku: `${slug}-${s.sizeMl}` }).returning();
        await db.insert(productPrice).values({ productId: p!.id, variantId: v!.id, priceNgn: s.priceNgn });
        if (s.stock > 0) {
          await db.insert(stockLedger).values({ locationType: "branch", locationId: branchId, productId: p!.id, variantId: v!.id, delta: s.stock, sourceType: "opening_balance", sourceId: uuid() });
        }
        ids.push(v!.id);
      }
      return ids;
    }
    [pine330, pine650] = (await flavour("Pineapple Ginger", "regular", 1, [
      { sizeMl: 330, priceNgn: 1500, stock: 500 },
      { sizeMl: 650, priceNgn: 2800, stock: 0 },
    ])) as [string, string];
    [zobo330] = (await flavour("Zobo", "special", 2, [{ sizeMl: 330, priceNgn: 1200, stock: 500 }])) as [string];
    [punch500] = (await flavour("Party Punch", "punch", 3, [{ sizeMl: 500, priceNgn: 2000, stock: 500 }])) as [string];

    // The catalogue: linked, connected to WhatsApp, and every size live (through the real sync, against the stub).
    await db.insert(catalogueLink).values({ catalogId: CATALOG_ID, name: "Test Juices", wabaId: WABA, whatsappConnected: true, syncEnabled: true });
    await syncCatalogue(db, cfg, { storefrontBase: "https://www.example.test" });
    await checkOpenBatches(db, cfg);

    const staff = (email: string, granted: string[], revoked: string[] = []) =>
      seedUser(db, { email, role: "branch_staff", granted: granted as never, revoked: revoked as never });
    await staff("agent@example.com", ["inbox.view", "inbox.view_all", "inbox.reply"]);
    await staff("no-orders@example.com", ["inbox.view", "inbox.view_all", "inbox.reply"], ["orders.manage"]);
    // Sees only lines granted to them, and none is: every conversation is hidden from this person.
    await staff("blind@example.com", ["inbox.view", "inbox.reply"]);
    owner = await authOwner(app);
    agent = await login("agent@example.com");
    noOrders = await login("no-orders@example.com");
    blind = await login("blind@example.com");
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    graphCalls.length = 0;
    messageHandler = null;
    opayDown = false;
    await setSwitches({});
    await db.delete(inboxTemplate);
    // Carts and orders left by earlier tests (in this throwaway test database) are settled,
    // so the two worker steps only see the rows of the test that is running.
    await db.update(catalogueChatOrder).set({ nextPrompt: null }).where(isNotNull(catalogueChatOrder.nextPrompt));
    const placed = await db
      .select({ id: catalogueChatOrder.id, status: saleOrder.status })
      .from(catalogueChatOrder)
      .innerJoin(saleOrder, eq(saleOrder.id, catalogueChatOrder.saleOrderId));
    for (const row of placed) {
      await db.update(catalogueChatOrder).set({ lastNotifiedStatus: row.status, notifyAttempts: 0 }).where(eq(catalogueChatOrder.id, row.id));
    }
  });

  // ── A cart arrives ────────────────────────────────────────────────────────

  it("an order webhook stores an order message and one catalogue_chat_order; replaying it creates nothing", async () => {
    const first = await sendCart([{ variantId: pine330, quantity: 2 }, { variantId: zobo330, quantity: 1, price: 1200 }], { text: "No ice please" });
    expect(first.msg).toMatchObject({ direction: "in", type: "order", body: 'Sent a cart: 2 items, 3 bottles — "No ice please"' });
    expect(first.cart).toMatchObject({
      conversationId: first.conv.id,
      customerId: first.conv.customerId,
      catalogId: CATALOG_ID,
      cartNote: "No ice please",
      state: "new",
      // The owner's switch is off: nothing is queued to be sent.
      nextPrompt: null,
      saleOrderId: null,
    });
    expect(first.cart.cart).toEqual([
      { product_retailer_id: rid(pine330), quantity: 2, item_price: 1500, currency: "NGN" },
      { product_retailer_id: rid(zobo330), quantity: 1, item_price: 1200, currency: "NGN" },
    ]);
    // The cart opens the 24-hour window like any message from the customer.
    expect(first.conv.lastInboundWaAt).not.toBeNull();

    // Meta retries the webhook: still one message, one cart, and no order.
    await postWebhook(cartMessage(first.wamid, [{ variantId: pine330, quantity: 2 }]), first.from);
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, first.wamid))).toHaveLength(1);
    expect(await cartsOf(first.conv.id)).toHaveLength(1);
    expect(await ordersOf(first.conv.customerId)).toHaveLength(0);
    expect(sentMessages()).toHaveLength(0);
  });

  it("a second cart cancels the first open one", async () => {
    const a = await sendCart([{ variantId: pine330, quantity: 1 }]);
    const b = await sendCart([{ variantId: zobo330, quantity: 4 }], { from: a.from });
    expect(b.conv.id).toBe(a.conv.id);
    expect((await cartRow(a.cart.id)).state).toBe("cancelled");
    expect((await cartRow(b.cart.id)).state).toBe("new");
  });

  it("GET chat-orders reprices from the shop and flags price_differs", async () => {
    // WhatsApp showed ₦1,400 for a juice the shop sells at ₦1,500; one size has no stock; one item is not ours.
    const { conv, wamid, from } = await sendCart(
      [
        { variantId: pine330, quantity: 2, price: 1400 },
        { variantId: pine650, quantity: 1, price: 2800 },
      ],
      { text: "For Saturday" },
    );
    await db
      .update(catalogueChatOrder)
      .set({ cart: [...(await cartRow((await cartsOf(conv.id))[0]!.id)).cart, { product_retailer_id: "SKU-SOMEONE-ELSE", quantity: 1, item_price: 99, currency: "NGN" }] })
      .where(eq(catalogueChatOrder.waMessageId, wamid));

    expect((await call(blind, "GET", `/inbox/chat-orders?conversation_id=${conv.id}`)).status).toBe(404);
    const res = await call(agent, "GET", `/inbox/chat-orders?conversation_id=${conv.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { state: string; cart_note: string; subtotal_ngn: number; order: unknown; lines: Record<string, unknown>[] }[];
      online_branch: { name: string };
    };
    expect(body.online_branch.name).toBe("Lekki Branch");
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ state: "new", cart_note: "For Saturday", order: null, subtotal_ngn: 2 * 1500 + 2800 });
    expect(body.data[0]!.lines).toEqual([
      {
        retailer_id: rid(pine330),
        variant_id: pine330,
        name: "Pineapple Ginger",
        size_ml: 330,
        quantity: 2,
        shop_price_ngn: 1500,
        line_total_ngn: 3000,
        meta_price: 1400,
        price_differs: true,
        sellable: true,
        in_stock: true,
      },
      {
        retailer_id: rid(pine650),
        variant_id: pine650,
        name: "Pineapple Ginger",
        size_ml: 650,
        quantity: 1,
        shop_price_ngn: 2800,
        line_total_ngn: 2800,
        meta_price: 2800,
        price_differs: false,
        sellable: true,
        in_stock: false,
      },
      {
        retailer_id: "SKU-SOMEONE-ELSE",
        variant_id: null,
        name: "Unknown item",
        size_ml: null,
        quantity: 1,
        shop_price_ngn: null,
        line_total_ngn: null,
        meta_price: 99,
        price_differs: false,
        sellable: false,
        in_stock: false,
      },
    ]);
    expect(from).toBeTruthy();
  });

  // ── The questions ─────────────────────────────────────────────────────────

  it("with ask_fulfilment_auto on, the worker step sends the buttons once", async () => {
    // Off (the default): a cart queues nothing and the worker sends nothing.
    const quiet = await sendCart([{ variantId: pine330, quantity: 2 }]);
    expect(quiet.cart.nextPrompt).toBeNull();
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(0);

    await setSwitches({ ask: true });
    const { cart } = await sendCart([{ variantId: pine330, quantity: 2, price: 1 }, { variantId: zobo330, quantity: 1 }]);
    expect(cart.nextPrompt).toBe("fulfilment");
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(1);
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(1);
    const sent = interactiveOf(sentMessages()[0]!);
    expect(sent.type).toBe("button");
    // Shop prices, never the ₦1 WhatsApp showed.
    expect(sent.body!.text).toBe(
      "Thank you! We have your cart:\n• 2 × Pineapple Ginger 330ml — ₦3,000\n• 1 × Zobo 330ml — ₦1,200\nSubtotal: ₦4,200\n\nHow would you like to get your order?",
    );
    expect(sent.action.buttons!.map((b) => [b.reply.id, b.reply.title])).toEqual([
      [`co:${cart.id}:delivery`, "Delivery"],
      [`co:${cart.id}:pickup`, "Pickup"],
    ]);
    expect(await cartRow(cart.id)).toMatchObject({ state: "asked", nextPrompt: null, problem: null });
    // It is in the timeline as an automatic message (no staff sender), with what was sent kept for later.
    const [out] = await db.select().from(inboxMessage).where(and(eq(inboxMessage.conversationId, cart.conversationId), eq(inboxMessage.direction, "out")));
    expect(out).toMatchObject({ type: "interactive", senderUserId: null, status: "sent" });
    expect((out!.payload as { interactive: { type: string } }).interactive.type).toBe("button");
  });

  it("a question WhatsApp certainly refused is tried again; one with no answer is never repeated", async () => {
    await setSwitches({ ask: true });
    const refused = await sendCart([{ variantId: pine330, quantity: 1 }]);
    messageHandler = () => json({ error: { message: "(#131000) Something went wrong", code: 131000 } }, 400);
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(0);
    expect(await cartRow(refused.cart.id)).toMatchObject({ state: "new", nextPrompt: "fulfilment", promptAttempts: 1 });
    messageHandler = null;
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(1);
    expect((await cartRow(refused.cart.id)).state).toBe("asked");

    graphCalls.length = 0;
    const unknown = await sendCart([{ variantId: pine330, quantity: 1 }]);
    messageHandler = () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    };
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(0);
    messageHandler = null;
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(1);
    const row = await cartRow(unknown.cart.id);
    expect(row.nextPrompt).toBeNull();
    expect(row.problem).toContain("may have been sent");
  });

  it("POST ask sends the question when a person presses the button", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 2 }]);
    expect((await call(blind, "POST", `/inbox/chat-orders/${cart.id}/ask`)).status).toBe(404);
    const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/ask`);
    expect(res.status).toBe(200);
    expect(sentMessages()).toHaveLength(1);
    expect(interactiveOf(sentMessages()[0]!).action.buttons).toHaveLength(2);
    expect((await cartRow(cart.id)).state).toBe("asked");
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "chat_order.ask"), eq(auditLog.entityId, cart.id)))).toHaveLength(1);

    // Outside the 24-hour window the question cannot go.
    await closeWindow(conv.id);
    const late = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/ask`);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("window_closed");
    expect(sentMessages()).toHaveLength(1);
  });

  it("a Delivery button reply moves to awaiting_address and the next text becomes the address", async () => {
    await setSwitches({ ask: true });
    const { cart, from } = await sendCart([{ variantId: pine330, quantity: 2 }]);
    await runChatOrderPrompts(db, cfg, log);
    graphCalls.length = 0;

    await postWebhook({ id: newWamid(), type: "interactive", interactive: { type: "button_reply", button_reply: { id: `co:${cart.id}:delivery`, title: "Delivery" } } }, from);
    expect(await cartRow(cart.id)).toMatchObject({ state: "awaiting_address", fulfilment: "delivery", nextPrompt: "address" });
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(1);
    expect((sentMessages()[0]!.body!["text"] as { body: string }).body).toBe(
      "Please type your full delivery address in one message: house number, street, area and city.",
    );

    // Too short to be an address: ignored.
    await postWebhook({ id: newWamid(), type: "text", text: { body: "ok" } }, from);
    expect((await cartRow(cart.id)).state).toBe("awaiting_address");

    await postWebhook({ id: newWamid(), type: "text", text: { body: "  12 Test Close, Lekki Phase 1, Lagos  " } }, from);
    expect(await cartRow(cart.id)).toMatchObject({ state: "ready", address: "12 Test Close, Lekki Phase 1, Lagos", nextPrompt: "received" });
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(1);
    expect((sentMessages()[1]!.body!["text"] as { body: string }).body).toBe(
      "Thank you. A member of our team will confirm your order and send your payment link shortly.",
    );
    // A later message does not change the address.
    await postWebhook({ id: newWamid(), type: "text", text: { body: "Please call me when you arrive" } }, from);
    expect((await cartRow(cart.id)).address).toBe("12 Test Close, Lekki Phase 1, Lagos");
    expect(sentMessages()).toHaveLength(2);
  });

  it("with the owner's switch off, an answer is recorded but no follow-up is sent", async () => {
    const { cart, from } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await call(agent, "POST", `/inbox/chat-orders/${cart.id}/ask`);
    graphCalls.length = 0;
    await postWebhook({ id: newWamid(), type: "interactive", interactive: { type: "button_reply", button_reply: { id: `co:${cart.id}:delivery`, title: "Delivery" } } }, from);
    expect(await cartRow(cart.id)).toMatchObject({ state: "awaiting_address", fulfilment: "delivery", nextPrompt: null });
    await postWebhook({ id: newWamid(), type: "text", text: { body: "7 Example Street, Yaba, Lagos" } }, from);
    expect(await cartRow(cart.id)).toMatchObject({ state: "ready", address: "7 Example Street, Yaba, Lagos", nextPrompt: null });
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(0);
  });

  it("a Pickup button reply moves to ready", async () => {
    await setSwitches({ ask: true });
    const { cart, from } = await sendCart([{ variantId: zobo330, quantity: 3 }]);
    await runChatOrderPrompts(db, cfg, log);
    graphCalls.length = 0;
    await postWebhook({ id: newWamid(), type: "interactive", interactive: { type: "button_reply", button_reply: { id: `co:${cart.id}:pickup`, title: "Pickup" } } }, from);
    expect(await cartRow(cart.id)).toMatchObject({ state: "ready", fulfilment: "pickup", nextPrompt: "received" });
    expect(await runChatOrderPrompts(db, cfg, log)).toBe(1);
    expect((sentMessages()[0]!.body!["text"] as { body: string }).body).toBe(
      "Thank you. You can collect from Lekki Branch, 1 Admiralty Way, Lekki. A member of our team will confirm your order and send your payment link shortly.",
    );
  });

  it("a button reply carrying another conversation's id is ignored", async () => {
    const mine = await sendCart([{ variantId: pine330, quantity: 1 }]);
    const theirs = await sendCart([{ variantId: pine330, quantity: 1 }]);
    // Customer B taps a button whose id names customer A's cart.
    await postWebhook({ id: newWamid(), type: "interactive", interactive: { type: "button_reply", button_reply: { id: `co:${mine.cart.id}:pickup`, title: "Pickup" } } }, theirs.from);
    expect(await cartRow(mine.cart.id)).toMatchObject({ state: "new", fulfilment: null });
    expect(await cartRow(theirs.cart.id)).toMatchObject({ state: "new", fulfilment: null });
    // Ids that are not ours, or not even an id, change nothing and break nothing.
    for (const id of ["co:not-a-uuid-not-a-uuid-not-a-uuid-xxxx:pickup", "something-else", `co:${uuid()}:delivery`]) {
      const wamid = newWamid();
      await postWebhook({ id: wamid, type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "Pickup" } } }, theirs.from);
      expect(await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, wamid))).toHaveLength(1);
    }
    expect((await cartRow(theirs.cart.id)).state).toBe("new");
  });

  // ── Placing the order ─────────────────────────────────────────────────────

  it("POST place creates a sale_order with channel online, shop prices, reservations and a sale.online_placed event, and sends a cta_url message with the OPay link", async () => {
    const { cart, conv, from } = await sendCart([{ variantId: pine330, quantity: 2 }, { variantId: zobo330, quantity: 1, price: 1200 }]);
    const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 2 }, { variant_id: zobo330, quantity: 1 }], { notes: "Call at the gate" }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Placed;
    expect(data).toEqual({ order_number: data.order_number, total_ngn: 2 * 1500 + 1200 + 500, is_preorder: false, payment_link: OPAY_LINK });

    const [order] = await ordersOf(conv.customerId);
    expect(order).toMatchObject({
      orderNumber: data.order_number,
      branchId,
      channel: "online",
      status: "confirmed",
      paymentMethod: "card",
      paymentStatus: "pending",
      paymentProvider: "opay",
      subtotalNgn: 4200,
      deliveryFeeNgn: 500,
      totalNgn: 4700,
      isPreorder: false,
      idempotencyKey: cart.idempotencyKey,
      deliveryAddressFormatted: "12 Test Close, Lekki Phase 1, Lagos",
      deliveryQuoteRef: null,
      notes: "Ordered in WhatsApp chat. Call at the gate",
    });
    const items = await db.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, order!.id));
    expect(items.map((i) => [i.variantId, i.quantity, i.unitPriceNgn, i.lineTotalNgn]).sort()).toEqual(
      [
        [pine330, 2, 1500, 3000],
        [zobo330, 1, 1200, 1200],
      ].sort(),
    );
    const held = await db.select().from(stockReservation).where(eq(stockReservation.saleOrderId, order!.id));
    expect(held.map((h) => [h.variantId, h.quantity, h.branchId]).sort()).toEqual(
      [
        [pine330, 2, branchId],
        [zobo330, 1, branchId],
      ].sort(),
    );
    // The owner's alert, exactly as for a storefront order.
    const events = (await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "sale.online_placed"))).filter(
      (e) => e.payload["sale_order_id"] === order!.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ order_number: data.order_number, total_ngn: 4700, customer_name: "Ada Test", customer_phone: `+${from}` });

    // The customer gets one message: a link button to OPay, with the shop's lines and total.
    expect(sentMessages()).toHaveLength(1);
    const pay = interactiveOf(sentMessages()[0]!);
    expect(pay.type).toBe("cta_url");
    expect(pay.action).toEqual({ name: "cta_url", parameters: { display_text: "Pay now", url: OPAY_LINK } });
    expect(pay.body!.text).toBe(
      `Your order ${data.order_number} is ready.\n• 2 × Pineapple Ginger 330ml — ₦3,000\n• 1 × Zobo 330ml — ₦1,200\nDelivery: ₦500\nTotal: ₦4,700\n\n` +
        "Tap Pay now to pay safely with OPay. The link works for 30 minutes. If it stops working, tell us and we will send a new one.",
    );
    const [out] = await db.select().from(inboxMessage).where(and(eq(inboxMessage.conversationId, conv.id), eq(inboxMessage.direction, "out")));
    expect(out).toMatchObject({ type: "interactive", status: "sent", body: `Sent payment link for ${data.order_number} (₦4,700)` });
    expect(out!.senderUserId).not.toBeNull();

    const after = await cartRow(cart.id);
    expect(after).toMatchObject({ state: "placed", saleOrderId: order!.id, fulfilment: "delivery", lastNotifiedStatus: "confirmed", nextPrompt: null });
    expect(after.placedBy).not.toBeNull();
    expect(after.paymentLinkSentAt).not.toBeNull();

    // The click is in the audit log, with the order number and total.
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "chat_order.place"), eq(auditLog.entityId, cart.id)));
    expect(audit!.afterJson).toMatchObject({ order_number: data.order_number, total_ngn: 4700, payment_link_sent: true });
    expect(audit!.actorUserId).toBe(after.placedBy);

    // The card now shows the order.
    const card = (await (await call(agent, "GET", `/inbox/chat-orders?conversation_id=${conv.id}`)).json()) as {
      data: { state: string; order: { order_number: string; status: string; total_ngn: number; admin_url: string } }[];
    };
    expect(card.data[0]).toMatchObject({ state: "placed", order: { order_number: data.order_number, status: "confirmed", total_ngn: 4700 } });
    expect(card.data[0]!.order.admin_url).toContain(`/owner/orders/${order!.id}`);
  });

  it("POST place with a cart item_price of 1 still charges the shop price", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 3, price: 1 }]);
    const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 3 }], { delivery_fee_ngn: 0 }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Placed).data.total_ngn).toBe(4500);
    const [order] = await ordersOf(conv.customerId);
    expect(order).toMatchObject({ subtotalNgn: 4500, totalNgn: 4500 });
    expect(interactiveOf(sentMessages()[0]!).body!.text).toContain("Total: ₦4,500");
    // A request cannot smuggle a price or a total in.
    const other = await sendCart([{ variantId: pine330, quantity: 1 }]);
    const tampered = await call(agent, "POST", `/inbox/chat-orders/${other.cart.id}/place`, { ...placeBody([{ variant_id: pine330, quantity: 1 }]), total_ngn: 1 });
    expect(tampered.status).toBe(400);
    expect(await ordersOf(other.conv.customerId)).toHaveLength(0);
  });

  it("POST place twice returns the same order number and creates one order", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 2 }]);
    const body = placeBody([{ variant_id: pine330, quantity: 2 }]);
    const [a, b] = await Promise.all([
      call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, body),
      call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, body),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const first = ((await a.json()) as Placed).data;
    const second = ((await b.json()) as Placed).data;
    expect(second.order_number).toBe(first.order_number);
    const again = ((await (await call(owner, "POST", `/inbox/chat-orders/${cart.id}/place`, body)).json()) as Placed).data;
    expect(again.order_number).toBe(first.order_number);

    expect(await ordersOf(conv.customerId)).toHaveLength(1);
    // One order, one hold on the stock, and one payment message: never two links for one order.
    const [order] = await ordersOf(conv.customerId);
    expect(await db.select().from(stockReservation).where(eq(stockReservation.saleOrderId, order!.id))).toHaveLength(1);
    expect(sentMessages()).toHaveLength(1);
    expect([first.payment_link, second.payment_link].filter(Boolean)).toEqual([OPAY_LINK]);
    expect(again.payment_link).toBeNull();
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "chat_order.place"), eq(auditLog.entityId, cart.id)))).toHaveLength(1);
  });

  it("POST place for pickup has delivery fee 0 and no delivery address", async () => {
    const { cart, conv } = await sendCart([{ variantId: zobo330, quantity: 2, price: 1200 }]);
    const withFee = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, { fulfilment: "pickup", delivery_fee_ngn: 500, items: [{ variant_id: zobo330, quantity: 2 }] });
    expect(withFee.status).toBe(400);
    const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, {
      fulfilment: "pickup",
      // An address typed by mistake is not kept on a pickup order.
      address: "12 Test Close, Lekki Phase 1, Lagos",
      delivery_fee_ngn: 0,
      items: [{ variant_id: zobo330, quantity: 2 }],
    });
    expect(res.status).toBe(201);
    const [order] = await ordersOf(conv.customerId);
    expect(order).toMatchObject({ deliveryFeeNgn: 0, totalNgn: 2400, deliveryAddressFormatted: null, deliveryState: null, notes: "Ordered in WhatsApp chat" });
    expect(await cartRow(cart.id)).toMatchObject({ fulfilment: "pickup", address: null });
    expect((await db.select().from(customer).where(eq(customer.id, conv.customerId)))[0]!.defaultAddress).toBeNull();
    expect(interactiveOf(sentMessages()[0]!).body!.text).toContain("\nPickup at Lekki Branch\nTotal: ₦2,400\n");
  });

  it("POST place refuses a delivery order without a full address", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    for (const address of [undefined, "Lekki"]) {
      const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, { fulfilment: "delivery", delivery_fee_ngn: 0, items: [{ variant_id: pine330, quantity: 1 }], ...(address ? { address } : {}) });
      expect(res.status).toBe(400);
    }
    expect(await ordersOf(conv.customerId)).toHaveLength(0);
  });

  it("POST place fills default_address only when it was empty", async () => {
    const first = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await call(agent, "POST", `/inbox/chat-orders/${first.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }], { address: "1 First Street, Ikeja, Lagos" }));
    const saved = async () => (await db.select().from(customer).where(eq(customer.id, first.conv.customerId)))[0]!.defaultAddress;
    expect(await saved()).toBe("1 First Street, Ikeja, Lagos");

    const second = await sendCart([{ variantId: pine330, quantity: 1 }], { from: first.from });
    const res = await call(agent, "POST", `/inbox/chat-orders/${second.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }], { address: "99 Other Road, Surulere, Lagos" }));
    expect(res.status).toBe(201);
    // Never overwritten; the new address is on the order itself.
    expect(await saved()).toBe("1 First Street, Ikeja, Lagos");
    const orders = await ordersOf(first.conv.customerId);
    expect(orders.map((o) => o.deliveryAddressFormatted).sort()).toEqual(["1 First Street, Ikeja, Lagos", "99 Other Road, Surulere, Lagos"]);
  });

  it("POST place when OPay is down returns 201 with payment_link null and a warning; the order exists", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 2 }]);
    opayDown = true;
    const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 2 }]));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Placed;
    expect(data.payment_link).toBeNull();
    expect(data.warning).toBe("The order was created but OPay did not give a payment link. Press “Send payment link” to try again.");
    const [order] = await ordersOf(conv.customerId);
    expect(order).toMatchObject({ orderNumber: data.order_number, status: "confirmed", totalNgn: 3500 });
    expect(sentMessages()).toHaveLength(0);
    expect(await cartRow(cart.id)).toMatchObject({ state: "placed", paymentLinkSentAt: null });

    // Pressing Create again while OPay is still down: the same order, still no link, never a second order.
    const retry = ((await (await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 2 }]))).json()) as Placed).data;
    expect(retry.order_number).toBe(data.order_number);
    expect(await ordersOf(conv.customerId)).toHaveLength(1);

    // OPay is back: "Send payment link" sends it; a double click does not send a second.
    opayDown = false;
    const link = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/payment-link`);
    expect(link.status).toBe(200);
    expect(((await link.json()) as { data: { payment_link: string } }).data.payment_link).toBe(OPAY_LINK);
    expect(sentMessages()).toHaveLength(1);
    expect(interactiveOf(sentMessages()[0]!).action.parameters!.url).toBe(OPAY_LINK);
    const twice = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/payment-link`);
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("just_sent");
    expect(sentMessages()).toHaveLength(1);

    // Once the order is paid there is nothing to pay for.
    await db.update(saleOrder).set({ status: "paid", paymentStatus: "paid" }).where(eq(saleOrder.id, order!.id));
    await db.update(catalogueChatOrder).set({ paymentLinkSentAt: new Date(Date.now() - 3600_000) }).where(eq(catalogueChatOrder.id, cart.id));
    const paid = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/payment-link`);
    expect(paid.status).toBe(409);
    expect(((await paid.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("not_awaiting_payment");
  });

  it("POST place when WhatsApp refuses the payment message still returns the order, with a warning", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    messageHandler = () => json({ error: { message: "(#131026) Message undeliverable", code: 131026 } }, 400);
    const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Placed;
    expect(data.payment_link).toBe(OPAY_LINK);
    expect(data.warning).toMatch(/^The order was created but the message could not be sent: /);
    expect(await ordersOf(conv.customerId)).toHaveLength(1);
    // Certainly not sent, so "Send payment link" may try again.
    expect((await cartRow(cart.id)).paymentLinkSentAt).toBeNull();
  });

  it("POST place outside the 24-hour window sends the order_confirmed template when it is approved, else warns", async () => {
    const noTemplate = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await closeWindow(noTemplate.conv.id);
    const warned = await call(agent, "POST", `/inbox/chat-orders/${noTemplate.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    expect(warned.status).toBe(201);
    expect(((await warned.json()) as Placed).data.warning).toMatch(/^The order was created but the message could not be sent: More than 24 hours/);
    expect(sentMessages()).toHaveLength(0);
    expect(await ordersOf(noTemplate.conv.customerId)).toHaveLength(1);

    await db.insert(inboxTemplate).values({ wabaId: WABA, name: "order_confirmed", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: ORDER_TEMPLATE_TEXT.order_confirmed }] });
    const withTemplate = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await closeWindow(withTemplate.conv.id);
    const res = await call(agent, "POST", `/inbox/chat-orders/${withTemplate.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    const { data } = (await res.json()) as Placed;
    expect(data.warning).toBeUndefined();
    expect(sentMessages()).toHaveLength(1);
    const tpl = sentMessages()[0]!.body!["template"] as { name: string; components: { type: string; parameters: { text: string }[] }[] };
    expect(sentMessages()[0]!.body!["type"]).toBe("template");
    expect(tpl.name).toBe("order_confirmed");
    expect(tpl.components[0]!.parameters.map((p) => p.text)).toEqual(["Ada", data.order_number, "₦2,000", OPAY_LINK]);
  });

  it("POST place needs orders.manage (403 without)", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    const res = await call(noOrders, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    expect(res.status).toBe(403);
    expect(await ordersOf(conv.customerId)).toHaveLength(0);
    expect((await cartRow(cart.id)).state).toBe("new");
    expect(sentMessages()).toHaveLength(0);
    // They can still see the cart and ask the question.
    expect((await call(noOrders, "GET", `/inbox/chat-orders?conversation_id=${conv.id}`)).status).toBe(200);
  });

  it("POST place returns 404 for a conversation the viewer cannot see", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    const res = await call(blind, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    expect(res.status).toBe(404);
    expect((await call(blind, "POST", `/inbox/chat-orders/${cart.id}/cancel`)).status).toBe(404);
    expect((await call(blind, "POST", `/inbox/chat-orders/${cart.id}/payment-link`)).status).toBe(404);
    expect((await call(agent, "POST", `/inbox/chat-orders/${uuid()}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]))).status).toBe(404);
    expect((await call(agent, "POST", "/inbox/chat-orders/not-an-id/place", placeBody([{ variant_id: pine330, quantity: 1 }]))).status).toBe(404);
    expect(await ordersOf(conv.customerId)).toHaveLength(0);
    expect((await cartRow(cart.id)).state).toBe("new");
  });

  it("POST place adds the label order to the conversation", async () => {
    const { cart, conv, from } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await db.update(inboxConversation).set({ labels: ["vip"] }).where(eq(inboxConversation.id, conv.id));
    await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    const labels = async () => (await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv.id)))[0]!.labels;
    expect(await labels()).toEqual(["vip", "order"]);
    // A second order in the same chat does not add it twice.
    const next = await sendCart([{ variantId: zobo330, quantity: 1 }], { from });
    await call(agent, "POST", `/inbox/chat-orders/${next.cart.id}/place`, placeBody([{ variant_id: zobo330, quantity: 1 }]));
    expect(await labels()).toEqual(["vip", "order"]);
  });

  it("an out-of-stock size makes the order a preorder, exactly as on the storefront", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine650, quantity: 1, price: 2800 }]);
    const res = await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine650, quantity: 1 }], { delivery_fee_ngn: 0 }));
    expect(((await res.json()) as Placed).data).toMatchObject({ is_preorder: true, total_ngn: 2800 });
    const [order] = await ordersOf(conv.customerId);
    expect(order!.isPreorder).toBe(true);
    expect(await db.select().from(stockReservation).where(eq(stockReservation.saleOrderId, order!.id))).toHaveLength(0);
  });

  it("POST place refuses a size the shop no longer sells, a dismissed cart, and a shop with no online branch; nothing is written", async () => {
    const hidden = await sendCart([{ variantId: punch500, quantity: 1, price: 2000 }]);
    await db.update(productVariant).set({ isActive: false }).where(eq(productVariant.id, punch500));
    const gone = await call(agent, "POST", `/inbox/chat-orders/${hidden.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }, { variant_id: punch500, quantity: 1 }]));
    expect(gone.status).toBe(422);
    expect(((await gone.json()) as { error: { message: string; details: { reason: string } } }).error).toMatchObject({
      message: "One of these juices can no longer be ordered. Remove it and try again.",
      details: { reason: "item_not_sellable" },
    });
    const unknown = await call(agent, "POST", `/inbox/chat-orders/${hidden.cart.id}/place`, placeBody([{ variant_id: uuid(), quantity: 1 }]));
    expect(unknown.status).toBe(422);
    await db.update(productVariant).set({ isActive: true }).where(eq(productVariant.id, punch500));
    expect(await ordersOf(hidden.conv.customerId)).toHaveLength(0);
    expect((await cartRow(hidden.cart.id)).state).toBe("new");

    // Dismissed: the customer is not told, and the cart can no longer become an order.
    const dismissed = await sendCart([{ variantId: pine330, quantity: 1 }]);
    expect((await call(agent, "POST", `/inbox/chat-orders/${dismissed.cart.id}/cancel`)).status).toBe(200);
    expect((await cartRow(dismissed.cart.id)).state).toBe("cancelled");
    const late = await call(agent, "POST", `/inbox/chat-orders/${dismissed.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("cart_cancelled");
    expect(await ordersOf(dismissed.conv.customerId)).toHaveLength(0);

    const stranded = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await db.update(branch).set({ isOnlineDefault: false }).where(eq(branch.id, branchId));
    try {
      const res = await call(agent, "POST", `/inbox/chat-orders/${stranded.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
        "No branch is set to take online orders. Ask the owner to choose one in the shop admin.",
      );
    } finally {
      await db.update(branch).set({ isOnlineDefault: true }).where(eq(branch.id, branchId));
    }
    expect(await ordersOf(stranded.conv.customerId)).toHaveLength(0);
    expect(sentMessages()).toHaveLength(0);
  });

  it("a placed cart cannot be dismissed, and a new cart leaves a placed one alone", async () => {
    const { cart, from } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await call(agent, "POST", `/inbox/chat-orders/${cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    expect((await call(agent, "POST", `/inbox/chat-orders/${cart.id}/cancel`)).status).toBe(409);
    await sendCart([{ variantId: zobo330, quantity: 1 }], { from });
    expect((await cartRow(cart.id)).state).toBe("placed");
  });

  // ── Sending products ──────────────────────────────────────────────────────

  it("product send: one id builds a product message, three build a product_list, and a non-live id is refused", async () => {
    const { conv } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    graphCalls.length = 0;
    const send = (who: Record<string, string>, body: unknown) => call(who, "POST", `/inbox/conversations/${conv.id}/messages`, body);

    const one = await send(agent, { type: "product", retailer_ids: [rid(zobo330)], text: "Try this one" });
    expect(one.status).toBe(201);
    expect(sentMessages()[0]!.body!["type"]).toBe("interactive");
    expect(interactiveOf(sentMessages()[0]!)).toEqual({
      type: "product",
      body: { text: "Try this one" },
      action: { catalog_id: CATALOG_ID, product_retailer_id: rid(zobo330) },
    });
    expect(((await one.json()) as { data: { type: string; body: string } }).data).toMatchObject({ type: "interactive", body: "Product: Zobo 330ml\nTry this one" });

    const three = await send(agent, { type: "product", retailer_ids: [rid(punch500), rid(zobo330), rid(pine330)] });
    expect(three.status).toBe(201);
    const list = interactiveOf(sentMessages()[1]!);
    expect(list.type).toBe("product_list");
    expect(list.header).toEqual({ type: "text", text: "Mrs. Samuel Fruit Juice" });
    expect(list.body!.text).toBe("Here are the juices we talked about. Tap one to see it or add it to your cart.");
    expect(list.action.catalog_id).toBe(CATALOG_ID);
    expect(list.action.sections).toEqual([
      { title: "Juices", product_items: [{ product_retailer_id: rid(pine330) }] },
      { title: "Specials", product_items: [{ product_retailer_id: rid(zobo330) }] },
      { title: "Punch", product_items: [{ product_retailer_id: rid(punch500) }] },
    ]);

    const menu = await send(agent, { type: "catalogue" });
    expect(menu.status).toBe(201);
    expect(interactiveOf(sentMessages()[2]!)).toEqual({
      type: "catalog_message",
      body: { text: "Tap below to see our full menu and order right here in WhatsApp." },
      action: { name: "catalog_message", parameters: { thumbnail_product_retailer_id: rid(pine330) } },
    });
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "inbox.send_product"));
    expect(audits.filter((a) => (a.afterJson as { conversation_id: string }).conversation_id === conv.id)).toHaveLength(3);

    // Not in the catalogue (unknown), or held but not live: refused, and nothing is sent.
    await db.update(productVariant).set({ isActive: false }).where(eq(productVariant.id, punch500));
    await syncCatalogue(db, cfg, { storefrontBase: "https://www.example.test" });
    const before = sentMessages().length;
    try {
      for (const ids of [[`v-${uuid()}`], [rid(pine330), rid(punch500)]]) {
        const res = await send(agent, { type: "product", retailer_ids: ids });
        expect(res.status).toBe(422);
        expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("item_not_in_catalogue");
      }
      expect(sentMessages()).toHaveLength(before);
    } finally {
      await db.update(productVariant).set({ isActive: true }).where(eq(productVariant.id, punch500));
      await checkOpenBatches(db, cfg);
      await syncCatalogue(db, cfg, { storefrontBase: "https://www.example.test" });
      await checkOpenBatches(db, cfg);
    }

    // Without a connected catalogue there is nothing to send from.
    await db.update(catalogueLink).set({ whatsappConnected: false });
    try {
      const res = await send(agent, { type: "catalogue" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { message: string; details: { reason: string } } }).error).toMatchObject({
        message: "The catalogue is not connected to WhatsApp yet.",
        details: { reason: "catalogue_not_connected" },
      });
    } finally {
      await db.update(catalogueLink).set({ whatsappConnected: true });
    }
    expect((await send(blind, { type: "catalogue" })).status).toBe(404);
  });

  it("product send outside the 24-hour window is refused with window_closed", async () => {
    const { conv } = await sendCart([{ variantId: pine330, quantity: 1 }]);
    await closeWindow(conv.id);
    graphCalls.length = 0;
    for (const body of [{ type: "product", retailer_ids: [rid(pine330)] }, { type: "product", retailer_ids: [rid(pine330), rid(zobo330)] }, { type: "catalogue" }]) {
      const res = await call(agent, "POST", `/inbox/conversations/${conv.id}/messages`, body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("window_closed");
    }
    expect(sentMessages()).toHaveLength(0);
    expect(await db.select().from(inboxMessage).where(and(eq(inboxMessage.conversationId, conv.id), eq(inboxMessage.direction, "out")))).toHaveLength(0);
  });

  // ── Order updates ─────────────────────────────────────────────────────────

  async function placedOrder() {
    const sent = await sendCart([{ variantId: pine330, quantity: 2 }]);
    const res = await call(agent, "POST", `/inbox/chat-orders/${sent.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 2 }]));
    const { data } = (await res.json()) as Placed;
    const [order] = await ordersOf(sent.conv.customerId);
    graphCalls.length = 0;
    return { ...sent, order: order!, orderNumber: data.order_number };
  }
  const setStatus = (orderId: string, status: "paid" | "out_for_delivery" | "delivered" | "handed_over" | "cancelled") =>
    db.update(saleOrder).set({ status }).where(eq(saleOrder.id, orderId));
  const approve = (name: keyof typeof ORDER_TEMPLATE_TEXT) =>
    db.insert(inboxTemplate).values({ wabaId: WABA, name, language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: ORDER_TEMPLATE_TEXT[name] }] });

  it("runOrderUpdates sends order_paid once when the order becomes paid, and nothing when order_updates_enabled is off", async () => {
    await approve("order_paid");
    const { cart, order, orderNumber } = await placedOrder();
    // Nothing to say while the order is only waiting for payment.
    await setSwitches({ updates: true });
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    await setSwitches({});

    await setStatus(order.id, "paid");
    // The owner's switch is off: the customer is not told.
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(0);
    expect((await cartRow(cart.id)).lastNotifiedStatus).toBe("confirmed");

    await setSwitches({ updates: true });
    expect(await runOrderUpdates(db, cfg, log)).toBe(1);
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(1);
    const body = sentMessages()[0]!.body!;
    expect(body["type"]).toBe("template");
    const tpl = body["template"] as { name: string; language: { code: string }; components: { type: string; parameters: { text: string }[] }[] };
    expect(tpl).toMatchObject({ name: "order_paid", language: { code: "en" } });
    expect(tpl.components[0]!.parameters.map((p) => p.text)).toEqual(["Ada", orderNumber, "₦3,500"]);
    expect(await cartRow(cart.id)).toMatchObject({ lastNotifiedStatus: "paid", notifyAttempts: 0, problem: null });

    // A status with no message is only recorded; the next one with a message still goes out.
    await setStatus(order.id, "handed_over");
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect((await cartRow(cart.id)).lastNotifiedStatus).toBe("handed_over");
    expect(sentMessages()).toHaveLength(1);
  });

  it("runOrderUpdates with an unapproved template and an open window sends plain text; with a closed window sends nothing and records the problem", async () => {
    await setSwitches({ updates: true });
    const open = await placedOrder();
    await setStatus(open.order.id, "out_for_delivery");
    expect(await runOrderUpdates(db, cfg, log)).toBe(1);
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0]!.body!["type"]).toBe("text");
    expect((sentMessages()[0]!.body!["text"] as { body: string }).body).toBe(`Hello Ada, your Mrs. Samuel order ${open.orderNumber} is on its way to you.`);
    expect(await cartRow(open.cart.id)).toMatchObject({ lastNotifiedStatus: "out_for_delivery", problem: null });

    const closed = await placedOrder();
    await closeWindow(closed.conv.id);
    await setStatus(closed.order.id, "delivered");
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(0);
    expect(await cartRow(closed.cart.id)).toMatchObject({ lastNotifiedStatus: "delivered", problem: "Template order_delivered is not approved" });
  });

  it("an order update WhatsApp refuses is tried three times, then given up; one with no answer is never repeated", async () => {
    await setSwitches({ updates: true });
    const refused = await placedOrder();
    await setStatus(refused.order.id, "paid");
    messageHandler = () => json({ error: { message: "(#131000) Something went wrong", code: 131000 } }, 400);
    for (const attempts of [1, 2]) {
      expect(await runOrderUpdates(db, cfg, log)).toBe(0);
      expect(await cartRow(refused.cart.id)).toMatchObject({ lastNotifiedStatus: "confirmed", notifyAttempts: attempts });
    }
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect(await cartRow(refused.cart.id)).toMatchObject({ lastNotifiedStatus: "paid", notifyAttempts: 0 });
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(3);

    graphCalls.length = 0;
    const unknown = await placedOrder();
    await setStatus(unknown.order.id, "paid");
    messageHandler = () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    };
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    messageHandler = null;
    expect(await runOrderUpdates(db, cfg, log)).toBe(0);
    expect(sentMessages()).toHaveLength(1);
    expect((await cartRow(unknown.cart.id)).problem).toContain("may have been sent");
  });

  it("a chat order is an ordinary online order waiting for payment, so the unpaid-order expiry covers it", async () => {
    const { order } = await placedOrder();
    // These are exactly the columns the expiry, the payment sweep, the reminder and the queue filter on.
    expect(order).toMatchObject({ channel: "online", status: "confirmed", paymentStatus: "pending" });
    expect(order.createdAtLocal).toBeInstanceOf(Date);
  });

  // ── Erase and merge ───────────────────────────────────────────────────────

  it("erasing a customer's inbox history removes their cart rows and leaves the sale order", async () => {
    const { cart, conv, from, order } = await placedOrder();
    const open = await sendCart([{ variantId: zobo330, quantity: 1 }], { from });
    const res = await call(owner, "POST", `/inbox/contacts/${conv.customerId}/erase`, { confirm: `+${from}` });
    expect(res.status).toBe(200);
    expect(await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.customerId, conv.customerId))).toHaveLength(0);
    expect(await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, cart.id))).toHaveLength(0);
    expect(await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, open.cart.id))).toHaveLength(0);
    expect(await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv.id))).toHaveLength(0);
    // The shop's own records stay.
    expect(await db.select().from(saleOrder).where(eq(saleOrder.id, order.id))).toHaveLength(1);
    expect(await db.select().from(customer).where(eq(customer.id, conv.customerId))).toHaveLength(1);
  });

  it("merging two contacts moves cart rows to the kept customer", async () => {
    // Both contacts have a live chat on the same line: the duplicate's thread is folded into the kept one and deleted.
    const dupe = await sendCart([{ variantId: pine330, quantity: 1 }]);
    const kept = await sendCart([{ variantId: zobo330, quantity: 1 }]);
    const placed = await call(agent, "POST", `/inbox/chat-orders/${dupe.cart.id}/place`, placeBody([{ variant_id: pine330, quantity: 1 }]));
    expect(placed.status).toBe(201);

    const res = await call(owner, "POST", `/inbox/contacts/${dupe.conv.customerId}/merge`, { into_customer_id: kept.conv.customerId });
    expect(res.status).toBe(200);
    expect(await db.select().from(inboxConversation).where(eq(inboxConversation.id, dupe.conv.id))).toHaveLength(0);
    expect(await cartRow(dupe.cart.id)).toMatchObject({ conversationId: kept.conv.id, customerId: kept.conv.customerId, state: "placed" });
    expect(await cartRow(kept.cart.id)).toMatchObject({ conversationId: kept.conv.id, customerId: kept.conv.customerId });

    // No clash (the kept contact has no live chat on that line): the thread itself moves, and its cart with it.
    const lone = await sendCart([{ variantId: pine330, quantity: 1 }]);
    const [target] = await db.insert(customer).values({ name: "Kept Contact", source: "online" }).returning();
    const moved = await call(owner, "POST", `/inbox/contacts/${lone.conv.customerId}/merge`, { into_customer_id: target!.id });
    expect(moved.status).toBe(200);
    expect(await cartRow(lone.cart.id)).toMatchObject({ conversationId: lone.conv.id, customerId: target!.id });
  });

  it("a cart whose row was not written when it arrived is recorded when the card is opened", async () => {
    const { cart, conv } = await sendCart([{ variantId: pine330, quantity: 2 }]);
    await db.delete(catalogueChatOrder).where(eq(catalogueChatOrder.id, cart.id));
    const res = await call(agent, "GET", `/inbox/chat-orders?conversation_id=${conv.id}`);
    const body = (await res.json()) as { data: { state: string; lines: { quantity: number }[] }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ state: "new", lines: [{ quantity: 2 }] });
    // Opening it again does not make a second one.
    await call(agent, "GET", `/inbox/chat-orders?conversation_id=${conv.id}`);
    expect(await cartsOf(conv.id)).toHaveLength(1);
  });
});
