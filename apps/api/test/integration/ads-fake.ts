/**
 * A pretend Meta ad account for the ads tests (suite spec 12). It answers the
 * Graph API addresses the suite uses, from memory, so NO test ever reaches
 * Meta. Everything in it is made up: IDs, names, the click ID, the token.
 */
import { randomUUID } from "node:crypto";
import {
  adminUser,
  branch,
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  payment,
  saleOrder,
  type AdDraftSpec,
  type DbClient,
} from "@ms/db";
import { eq } from "drizzle-orm";

export const ACT = "act_1234500001";
export const ACT_NUM = "1234500001";
export const WABA = "100200300400500";
export const PAGE_ID = "100000000000001";
/** An obviously made-up click ID, long like a real one. */
export const CLID = "TESTCLIDaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001";
export const FAKE_TOKEN = "itest-token";

export interface GraphCall {
  method: string;
  path: string;
  /** The path without "/v23.0/". */
  edge: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  auth: string | null;
}

type Obj = Record<string, unknown>;

export class FakeAds {
  calls: GraphCall[] = [];
  account: Obj = {};
  listed: Obj[] = [];
  campaigns = new Map<string, Obj>();
  adsets = new Map<string, Obj>();
  ads = new Map<string, Obj>();
  creatives = new Map<string, Obj>();
  insights: { account: Obj[]; ad: Obj[] } = { account: [], ad: [] };
  campaignInsights = new Map<string, Obj>();
  todaySpend = 0;
  events: Obj[] = [];
  headers: Record<string, string> = {};
  /** Answer a call differently (a refusal, a timeout). Return null to fall through to the normal answer. */
  override: ((call: GraphCall) => Response | Promise<Response> | null) | null = null;
  /** After a successful write, do something to the pretend account (for example save a different budget). */
  afterWrite: ((call: GraphCall) => void) | null = null;
  private seq = 120000000000000;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.calls = [];
    this.account = {
      id: ACT,
      account_id: ACT_NUM,
      name: "Test Ads",
      currency: "NGN",
      timezone_name: "Africa/Lagos",
      timezone_offset_hours_utc: 1,
      account_status: 1,
      min_daily_budget: 50000,
      funding_source: "999",
    };
    this.listed = [this.account];
    this.campaigns.clear();
    this.adsets.clear();
    this.ads.clear();
    this.creatives.clear();
    this.insights = { account: [], ad: [] };
    this.campaignInsights.clear();
    this.todaySpend = 0;
    this.events = [];
    this.headers = {};
    this.override = null;
    this.afterWrite = null;
  }

  nextId(): string {
    return String(++this.seq);
  }

  /** Every call that could change something at Meta. */
  writes(): GraphCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  /** Writes to ad objects (not the purchase-report dataset). */
  adWrites(): GraphCall[] {
    return this.writes().filter((c) => !c.edge.endsWith("/dataset") && !c.edge.endsWith("/events"));
  }

  addCampaign(o: Obj): string {
    const id = String(o.id ?? this.nextId());
    this.campaigns.set(id, { id, name: `Campaign ${id}`, status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_ENGAGEMENT", ...o });
    return id;
  }
  addAdset(o: Obj): string {
    const id = String(o.id ?? this.nextId());
    this.adsets.set(id, { id, name: `Ad set ${id}`, status: "PAUSED", effective_status: "PAUSED", destination_type: "WHATSAPP", ...o });
    return id;
  }
  addAd(o: Obj): string {
    const id = String(o.id ?? this.nextId());
    this.ads.set(id, { id, name: `Ad ${id}`, status: "PAUSED", effective_status: "PAUSED", ...o });
    return id;
  }

  private find(id: string): Obj | undefined {
    return this.campaigns.get(id) ?? this.adsets.get(id) ?? this.ads.get(id) ?? this.creatives.get(id);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...this.headers } });
  }

  refuse(code: number, message: string, status = 400, subcode?: number): Response {
    return this.json({ error: { message, code, ...(subcode ? { error_subcode: subcode } : {}) } }, status);
  }

  private async answer(call: GraphCall): Promise<Response> {
    const over = this.override ? await this.override(call) : null;
    if (over) return over;
    const { method, edge } = call;
    const parts = edge.split("/");
    if (method === "GET") {
      if (edge === "me/adaccounts") return this.json({ data: this.listed });
      if (edge === ACT) return this.json(this.account);
      if (edge === `${ACT}/campaigns`) return this.json({ data: [...this.campaigns.values()] });
      if (edge === `${ACT}/adsets`) return this.json({ data: [...this.adsets.values()] });
      if (edge === `${ACT}/ads`) return this.json({ data: [...this.ads.values()] });
      if (edge === `${ACT}/adcreatives`) return this.json({ data: [...this.creatives.values()] });
      if (edge === `${ACT}/insights`) {
        if (call.query.get("date_preset") === "today") return this.json({ data: this.todaySpend > 0 ? [{ spend: this.todaySpend.toFixed(2) }] : [] });
        return this.json({ data: call.query.get("level") === "ad" ? this.insights.ad : this.insights.account });
      }
      if (parts.length === 2 && parts[1] === "insights") {
        const row = this.campaignInsights.get(parts[0]!);
        return this.json({ data: row ? [row] : [] });
      }
      if (parts.length === 1) {
        const o = this.find(parts[0]!);
        if (o) return this.json({ ...o, account_id: ACT_NUM });
      }
      return this.refuse(100, "Unsupported get request");
    }
    if (method === "POST") {
      const body = call.body ?? {};
      let res: Response | null = null;
      if (edge === `${ACT}/adimages`) res = this.json({ images: { bytes: { hash: "testhash0001", url: "https://example.invalid/i.jpg" } } });
      else if (edge === `${ACT}/campaigns`) res = this.json({ id: this.addCampaign({ ...body, effective_status: body.status }) });
      else if (edge === `${ACT}/adsets`) {
        res = this.json({ id: this.addAdset({ ...body, daily_budget: String(body.daily_budget), effective_status: body.status }) });
      } else if (edge === `${ACT}/adcreatives`) {
        const id = this.nextId();
        this.creatives.set(id, { id, ...body });
        res = this.json({ id });
      } else if (edge === `${ACT}/ads`) {
        const campaignId = this.adsets.get(String(body.adset_id))?.campaign_id;
        res = this.json({ id: this.addAd({ ...body, campaign_id: campaignId, effective_status: body.status }) });
      }
      else if (edge === `${WABA}/dataset`) res = this.json({ id: "900000000000001" });
      else if (edge === "900000000000001/events") {
        this.events.push(body);
        res = this.json({ events_received: 1 });
      } else if (parts.length === 1) {
        const o = this.find(parts[0]!);
        if (o) {
          if (body.status !== undefined) {
            o.status = body.status;
            o.effective_status = body.status;
          }
          if (body.daily_budget !== undefined) o.daily_budget = String(body.daily_budget);
          res = this.json({ success: true });
        }
      }
      if (res) {
        this.afterWrite?.(call);
        return res;
      }
    }
    return this.refuse(100, "Unsupported request");
  }

  /** Replace fetch for graph.facebook.com. Anything else goes to the fetch that was there before. */
  install(): void {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
      const url = new URL(href);
      let body: Record<string, unknown> | null = null;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body)) as Record<string, unknown>;
        } catch {
          body = { raw: String(init.body) };
        }
      }
      const call: GraphCall = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        edge: url.pathname.replace(/^\/v\d+\.\d+\//, ""),
        query: url.searchParams,
        body,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
      };
      this.calls.push(call);
      return this.answer(call);
    }) as typeof fetch;
  }
}

/** A network failure with no answer: fetch itself rejects, as a timeout does. */
export function noAnswer(): Promise<Response> {
  return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
}

// ── Seeding ──────────────────────────────────────────────────────────────────

export async function seedWaLine(db: DbClient, label = "Main line"): Promise<string> {
  const [row] = await db
    .insert(inboxPhoneNumber)
    .values({ e164: `+23480${Math.floor(10000000 + Math.random() * 89999999)}`, label, channels: "both", wabaId: WABA, waPhoneNumberId: String(Math.floor(Math.random() * 1e12)) })
    .returning();
  return row!.id;
}

export async function seedPage(db: DbClient, pageId = PAGE_ID): Promise<string> {
  const [row] = await db
    .insert(inboxPhoneNumber)
    .values({ kind: "messenger", externalId: pageId, pageExternalId: pageId, label: "Test Page" })
    .returning();
  return row!.id;
}

export async function seedCustomer(db: DbClient, name = "Ada Test"): Promise<string> {
  const [c] = await db
    .insert(customer)
    .values({ name, phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}`, source: "whatsapp" })
    .returning();
  return c!.id;
}

export async function seedConversation(db: DbClient, customerId: string, lineId: string, channel = "whatsapp"): Promise<string> {
  const [c] = await db.insert(inboxConversation).values({ customerId, phoneNumberId: lineId, channel }).returning();
  return c!.id;
}

/** A WhatsApp first message that arrived through a click-to-WhatsApp advert. */
export async function seedAdMessage(
  db: DbClient,
  conversationId: string,
  opts: { at?: Date; adId?: string; clid?: string | null; headline?: string; sourceType?: string } = {},
): Promise<string> {
  const referral: Record<string, unknown> = {
    source_url: "https://fb.me/test",
    source_id: opts.adId ?? "120000000000900",
    source_type: opts.sourceType ?? "ad",
    headline: opts.headline ?? "Fresh juice, delivered today",
    body: "Cold-pressed this morning",
    media_type: "image",
  };
  if (opts.clid !== null) referral.ctwa_clid = opts.clid ?? CLID;
  const [m] = await db
    .insert(inboxMessage)
    .values({
      conversationId,
      direction: "in",
      type: "text",
      body: "Hello",
      waMessageId: `wamid.test-${randomUUID()}`,
      status: "received",
      payload: { from: "2348030000000", id: "wamid.test", type: "text", text: { body: "Hello" }, referral },
      createdAt: opts.at ?? new Date(),
    })
    .returning();
  return m!.id;
}

let branchId: string | null = null;
let orderSeq = 0;

export async function seedOrder(
  db: DbClient,
  customerId: string | null,
  opts: { at?: Date; subtotal?: number; delivery?: number; paymentStatus?: "paid" | "pending" | "refunded"; status?: "paid" | "confirmed" | "cancelled" | "draft"; paidAt?: Date } = {},
): Promise<{ id: string; orderNumber: string }> {
  if (!branchId) {
    const [b] = await db.insert(branch).values({ name: "Ads Test Branch", code: `ADS${Date.now() % 100000}` }).returning();
    branchId = b!.id;
  }
  const at = opts.at ?? new Date();
  const subtotal = opts.subtotal ?? 12500;
  const delivery = opts.delivery ?? 1500;
  const orderNumber = `ADS-${Date.now()}-${++orderSeq}`;
  const [o] = await db
    .insert(saleOrder)
    .values({
      orderNumber,
      branchId,
      channel: "online",
      customerId,
      status: opts.status ?? "paid",
      subtotalNgn: subtotal,
      deliveryFeeNgn: delivery,
      totalNgn: subtotal + delivery,
      paymentMethod: "transfer",
      paymentStatus: opts.paymentStatus ?? "paid",
      createdAtLocal: at,
      createdAt: at,
      idempotencyKey: randomUUID(),
    })
    .returning();
  if ((opts.paymentStatus ?? "paid") === "paid") {
    await db.insert(payment).values({ saleOrderId: o!.id, method: "transfer", amountNgn: subtotal + delivery, status: "paid", paidAt: opts.paidAt ?? at });
  }
  return { id: o!.id, orderNumber };
}

/** Forget the cached branch (each test file has its own database). */
export function resetSeedState(): void {
  branchId = null;
}

export async function ownerId(db: DbClient): Promise<string> {
  const [o] = await db.select({ id: adminUser.id }).from(adminUser).where(eq(adminUser.email, "owner@example.com"));
  return o!.id;
}

export function exampleSpec(accountId: string, over: Partial<AdDraftSpec> = {}): AdDraftSpec {
  const start = new Date(Date.now() + 2 * 3600_000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 2 * 24 * 3600_000 + 3600_000);
  return {
    destination: "whatsapp",
    account_id: accountId,
    name: "November juice",
    headline: "Fresh juice, delivered today",
    primary_text: "Cold-pressed in Lagos this morning.",
    description: null,
    image_key: `ads/images/2026/11/${randomUUID()}.jpg`,
    greeting: "Hello! How can we help?",
    prefilled_message: null,
    audience: { area: "nigeria", radius_km: null, age_min: 18, age_max: 65 },
    daily_budget: 2000,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    special_category: false,
    ...over,
  };
}
