import { describe, expect, it } from "vitest";
import {
  BudgetUnitError,
  ENABLED_DESTINATIONS,
  adDraftSpecSchema,
  budgetToMetaUnits,
  confirmTextFor,
  costPerConversation,
  destinationOf,
  draftProblems,
  evaluateCap,
  extractAdReferrals,
  fromUnits,
  maxSpend,
  metaUnitsToNaira,
  money,
  nameTag,
  normaliseTyped,
  remainingMaxSpend,
  runDays,
  summariseActions,
  toUnits,
} from "./ads.js";

describe("summariseActions", () => {
  it("reads conversations started and first replies", () => {
    const r = summariseActions(
      [
        { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "14" },
        { action_type: "onsite_conversion.messaging_first_reply", value: "9" },
        { action_type: "link_click", value: "40" },
      ],
      undefined,
    );
    expect(r).toEqual({ conversationsStarted: 14, firstReplies: 9, metaPurchases: 0, metaPurchaseValue: 0 });
  });
  it("prefers omni_purchase and never adds the purchase types together", () => {
    const r = summariseActions(
      [
        { action_type: "omni_purchase", value: "3" },
        { action_type: "onsite_conversion.purchase", value: "2" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "1" },
      ],
      [
        { action_type: "omni_purchase", value: "45000.50" },
        { action_type: "onsite_conversion.purchase", value: "30000" },
      ],
    );
    expect(r.metaPurchases).toBe(3);
    expect(r.metaPurchaseValue).toBe(45000.5);
    const onsiteOnly = summariseActions([{ action_type: "onsite_conversion.purchase", value: "2" }], [
      { action_type: "onsite_conversion.purchase", value: "30000" },
    ]);
    expect(onsiteOnly.metaPurchases).toBe(2);
    expect(onsiteOnly.metaPurchaseValue).toBe(30000);
  });
  it("missing lists give zeros", () => {
    expect(summariseActions(undefined, undefined)).toEqual({
      conversationsStarted: 0,
      firstReplies: 0,
      metaPurchases: 0,
      metaPurchaseValue: 0,
    });
  });
});

describe("units", () => {
  it("toUnits / fromUnits: ₦5,000 at factor 100 is 500000; at factor 1 is 5000", () => {
    expect(toUnits(5000, 100)).toBe(500000);
    expect(toUnits(5000, 1)).toBe(5000);
    expect(fromUnits(500000, 100)).toBe(5000);
    expect(fromUnits(5000, 1)).toBe(5000);
  });
});

describe("budgetToMetaUnits: the one conversion from whole naira to what Meta takes", () => {
  const kobo = { currency: "NGN", budgetFactor: 100 };
  const naira = { currency: "NGN", budgetFactor: 1 };
  it("₦5,000 is 500000 when Meta works in kobo and 5000 when it works in naira", () => {
    expect(budgetToMetaUnits(5000, kobo)).toBe(500000);
    expect(budgetToMetaUnits(5000, naira)).toBe(5000);
    expect(budgetToMetaUnits(1, kobo)).toBe(100);
  });
  it("refuses an ad account that is not in naira, never converting", () => {
    for (const currency of ["USD", "GBP", "", "ngn"]) {
      expect(() => budgetToMetaUnits(5000, { currency, budgetFactor: 100 })).toThrow(BudgetUnitError);
    }
    try {
      budgetToMetaUnits(5000, { currency: "USD", budgetFactor: 100 });
    } catch (e) {
      expect((e as BudgetUnitError).reason).toBe("currency");
      expect((e as Error).message).toContain("not naira");
    }
  });
  it("refuses while the unit has not been checked, or is anything but exactly 1 or 100", () => {
    for (const budgetFactor of [null, 0, 10, 1000, 99.5, -1]) {
      expect(() => budgetToMetaUnits(5000, { currency: "NGN", budgetFactor })).toThrow(/has not been checked/);
    }
  });
  it("refuses a fraction of a naira, zero, a negative, and not-a-number", () => {
    for (const amount of [0, -5, 12.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(() => budgetToMetaUnits(amount, kobo)).toThrow(BudgetUnitError);
    }
  });
  it("metaUnitsToNaira reads a budget back, and gives null rather than a rounded guess", () => {
    expect(metaUnitsToNaira(500000, kobo)).toBe(5000);
    expect(metaUnitsToNaira(5000, naira)).toBe(5000);
    expect(metaUnitsToNaira(500050, kobo)).toBeNull();
    expect(metaUnitsToNaira(500000, { currency: "USD", budgetFactor: 100 })).toBeNull();
    expect(metaUnitsToNaira(500000, { currency: "NGN", budgetFactor: null })).toBeNull();
  });
  it("a round trip never changes the amount", () => {
    for (const amount of [1, 999, 2000, 35000, 1_000_000]) {
      for (const acc of [kobo, naira]) expect(metaUnitsToNaira(budgetToMetaUnits(amount, acc), acc)).toBe(amount);
    }
  });
});

describe("runDays / maxSpend", () => {
  const start = new Date("2026-11-23T08:00:00Z");
  it("7 days at ₦5,000 is ₦35,000; 25 hours counts as 2 days", () => {
    expect(runDays(start, new Date("2026-11-30T08:00:00Z"))).toBe(7);
    expect(maxSpend(5000, start, new Date("2026-11-30T08:00:00Z"))).toBe(35000);
    expect(runDays(start, new Date(start.getTime() + 25 * 3600_000))).toBe(2);
  });
  it("is never less than one day", () => {
    expect(runDays(start, start)).toBe(1);
    expect(runDays(start, new Date(start.getTime() - 1000))).toBe(1);
    expect(remainingMaxSpend(2000, new Date("2026-11-29T20:00:00Z"), new Date("2026-11-30T08:00:00Z"))).toBe(2000);
    expect(remainingMaxSpend(2000, new Date("2026-11-28T07:00:00Z"), new Date("2026-11-30T08:00:00Z"))).toBe(6000);
  });
});

describe("evaluateCap", () => {
  it("refuses when cap is 0; refuses when others + requested exceeds cap; allows exactly at the cap", () => {
    expect(evaluateCap({ cap: 0, othersActiveDaily: [], requestedDaily: 0 }).ok).toBe(false);
    expect(evaluateCap({ cap: 0, othersActiveDaily: [], requestedDaily: 100 }).ok).toBe(false);
    const over = evaluateCap({ cap: 3000, othersActiveDaily: [2000], requestedDaily: 2000 });
    expect(over).toEqual({ ok: false, cap: 3000, alreadyCommitted: 2000, requested: 2000, room: 1000 });
    expect(evaluateCap({ cap: 4000, othersActiveDaily: [1500, 500], requestedDaily: 2000 }).ok).toBe(true);
    expect(evaluateCap({ cap: 4000, othersActiveDaily: [1500, 500], requestedDaily: 2001 }).ok).toBe(false);
  });
  it("refuses when any figure is not a number", () => {
    expect(evaluateCap({ cap: 5000, othersActiveDaily: [Number.NaN], requestedDaily: 10 }).ok).toBe(false);
    expect(evaluateCap({ cap: 5000, othersActiveDaily: [], requestedDaily: Number.NaN }).ok).toBe(false);
    expect(evaluateCap({ cap: Number.NaN, othersActiveDaily: [], requestedDaily: 10 }).ok).toBe(false);
    expect(evaluateCap({ cap: 5000, othersActiveDaily: [], requestedDaily: -10 }).ok).toBe(false);
  });
});

describe("small helpers", () => {
  it("costPerConversation: null when either is zero", () => {
    expect(costPerConversation(0, 5)).toBeNull();
    expect(costPerConversation(500, 0)).toBeNull();
    expect(costPerConversation(4000, 5)).toBe(800);
  });
  it("money", () => {
    expect(money(12500, "NGN")).toBe("₦12,500");
    expect(money(1234.5, "NGN")).toBe("₦1,234.50");
    expect(money(12.5, "USD")).toBe("$12.50");
    expect(money(12.5, "XYZ")).toBe("12.50 XYZ");
  });
  it("nameTag: stable 8 hex characters", () => {
    const id = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    expect(nameTag(id)).toBe(" [ms-1a2b3c4d]");
    expect(nameTag(id)).toBe(nameTag(id.toUpperCase()));
    expect(nameTag(id)).toMatch(/^ \[ms-[0-9a-f]{8}\]$/);
  });
  it("destinationOf: maps the three destination types, other otherwise", () => {
    expect(destinationOf("WHATSAPP")).toBe("whatsapp");
    expect(destinationOf("MESSENGER")).toBe("messenger");
    expect(destinationOf("INSTAGRAM_DIRECT")).toBe("instagram");
    expect(destinationOf("MESSAGING_MESSENGER_WHATSAPP")).toBe("other");
    expect(destinationOf(null)).toBe("other");
    expect(destinationOf(undefined)).toBe("other");
  });
  it("normaliseTyped: \"₦35,000\" and \" 35 000 \" both give \"35000\"", () => {
    expect(normaliseTyped("₦35,000")).toBe("35000");
    expect(normaliseTyped(" 35 000 ")).toBe("35000");
    expect(normaliseTyped("NGN 35,000")).toBe("35000");
    expect(normaliseTyped("35001")).toBe("35001");
    expect(normaliseTyped(35000)).toBe("");
    expect(normaliseTyped(undefined)).toBe("");
    expect(confirmTextFor(35000)).toBe("35000");
  });
});

describe("extractAdReferrals", () => {
  const igEntry = {
    id: "17841400000000001",
    time: 1763550000000,
    messaging: [
      {
        sender: { id: "900000000000001" },
        recipient: { id: "17841400000000001" },
        timestamp: 1763550000123,
        message: {
          mid: "mid.test-1",
          text: "Hello",
          referral: { ref: "promo", ad_id: "120200000000000001", source: "ADS", type: "OPEN_THREAD", ads_context_data: { ad_title: "Fresh juice, delivered today", photo_url: "https://example.invalid/p.jpg" } },
        },
      },
    ],
  };
  it("finds message.referral on an Instagram message with source ADS", () => {
    const r = extractAdReferrals("instagram.messages", { object: "instagram", entry: [igEntry] });
    expect(r).toEqual([
      {
        index: 0,
        accountExternalId: "17841400000000001",
        senderId: "900000000000001",
        adId: "120200000000000001",
        headline: "Fresh juice, delivered today",
        ref: "promo",
        at: new Date(1763550000123),
      },
    ]);
  });
  it("finds a messaging_referrals item on a Page event", () => {
    const r = extractAdReferrals("page.messaging_referrals", {
      object: "page",
      entry: [
        {
          id: "100000000000001",
          messaging: [
            { sender: { id: "5550001" }, recipient: { id: "100000000000001" }, timestamp: 1763550000000, read: { watermark: 1 } },
            { sender: { id: "5550001" }, recipient: { id: "100000000000001" }, timestamp: 1763550001000, referral: { source: "ADS", type: "OPEN_THREAD", ad_id: 445566 } },
          ],
        },
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ index: 1, senderId: "5550001", adId: "445566", headline: null, ref: null });
  });
  it("finds a referral on a postback (a brand-new Messenger thread)", () => {
    const r = extractAdReferrals("page.messaging_postbacks", {
      id: "100000000000001",
      messaging: [{ sender: { id: "5550002" }, timestamp: 1763550002000, postback: { title: "Get started", payload: "GET_STARTED", referral: { source: "ADS", ad_id: "77", ads_context_data: { ad_title: "Zobo" } } } }],
    });
    expect(r).toEqual([expect.objectContaining({ senderId: "5550002", adId: "77", headline: "Zobo" })]);
  });
  it("ignores referrals whose source is not ADS", () => {
    const entry = { id: "100000000000001", messaging: [{ sender: { id: "5550003" }, timestamp: 1, referral: { source: "SHORTLINK", ref: "menu" } }] };
    expect(extractAdReferrals("page.messaging_referrals", entry)).toEqual([]);
  });
  it("ignores echoes and events from the account itself", () => {
    const entry = {
      id: "100000000000001",
      messaging: [
        { sender: { id: "100000000000001" }, recipient: { id: "5550003" }, timestamp: 1, message: { is_echo: true, referral: { source: "ADS", ad_id: "1" } } },
        { sender: { id: "100000000000001" }, timestamp: 1, referral: { source: "ADS", ad_id: "1" } },
      ],
    };
    expect(extractAdReferrals("page.messages", entry)).toEqual([]);
  });
  it("accepts a whole body and a single entry", () => {
    const whole = extractAdReferrals("instagram.messages", { object: "instagram", entry: [igEntry] });
    const single = extractAdReferrals("instagram.messages", igEntry);
    expect(single).toEqual(whole);
    expect(extractAdReferrals("x", null)).toEqual([]);
    expect(extractAdReferrals("x", "nonsense")).toEqual([]);
    expect(extractAdReferrals("x", { entry: [null, { id: "1" }] })).toEqual([]);
  });
});

describe("the advert form", () => {
  const now = new Date("2026-11-20T08:00:00Z");
  const good = {
    destination: "whatsapp" as const,
    account_id: "0b0e5f0a-0000-4000-8000-000000000001",
    name: "November juice",
    headline: "Fresh juice, delivered today",
    primary_text: "Cold-pressed in Lagos this morning.",
    description: null,
    image_key: "ads/images/2026/11/0b0e5f0a-0000-4000-8000-000000000002.jpg",
    greeting: "Hello! How can we help?",
    prefilled_message: null,
    audience: { area: "nigeria" as const, radius_km: null, age_min: 18, age_max: 65 },
    daily_budget: 5000,
    start_at: "2026-11-23T08:00:00.000Z",
    end_at: "2026-11-30T08:00:00.000Z",
    special_category: false as const,
  };
  it("accepts the example draft", () => {
    expect(adDraftSpecSchema.safeParse(good).success).toBe(true);
    expect(draftProblems(good, now)).toEqual([]);
  });
  it("special_category must be the literal false", () => {
    expect(adDraftSpecSchema.safeParse({ ...good, special_category: true }).success).toBe(false);
    expect(adDraftSpecSchema.safeParse({ ...good, special_category: "false" }).success).toBe(false);
    const { special_category: _omit, ...without } = good;
    expect(adDraftSpecSchema.safeParse(without).success).toBe(false);
  });
  it("refuses a fraction of a naira, a zero budget, unknown keys and an image outside our folder", () => {
    expect(adDraftSpecSchema.safeParse({ ...good, daily_budget: 12.5 }).success).toBe(false);
    expect(adDraftSpecSchema.safeParse({ ...good, daily_budget: 0 }).success).toBe(false);
    expect(adDraftSpecSchema.safeParse({ ...good, lifetime_budget: 9 }).success).toBe(false);
    expect(adDraftSpecSchema.safeParse({ ...good, status: "ACTIVE" }).success).toBe(false);
    expect(adDraftSpecSchema.safeParse({ ...good, image_key: "inbox/other.png" }).success).toBe(false);
  });
  it("an end date is required, more than a day after the start and within 30 days", () => {
    expect(draftProblems({ ...good, end_at: "2026-11-24T08:00:00.000Z" }, now)).toHaveLength(1);
    expect(draftProblems({ ...good, end_at: "2026-12-24T08:00:00.000Z" }, now)).toHaveLength(1);
    expect(draftProblems({ ...good, start_at: "2026-11-19T08:00:00.000Z", end_at: "2026-11-25T08:00:00.000Z" }, now)).toHaveLength(1);
    const { end_at: _omit, ...noEnd } = good;
    expect(adDraftSpecSchema.safeParse(noEnd).success).toBe(false);
  });
  it("only WhatsApp adverts can be created until the others are checked with Meta", () => {
    expect(ENABLED_DESTINATIONS).toEqual(["whatsapp"]);
    expect(draftProblems({ ...good, destination: "messenger" }, now)[0]).toContain("only create adverts that open a WhatsApp chat");
    expect(draftProblems({ ...good, destination: "instagram" }, now)).toHaveLength(1);
  });
  it("ages and the distance from the shop", () => {
    expect(draftProblems({ ...good, audience: { ...good.audience, age_min: 40, age_max: 30 } }, now)).toHaveLength(1);
    expect(draftProblems({ ...good, audience: { ...good.audience, area: "near_shop" } }, now)).toHaveLength(1);
    expect(adDraftSpecSchema.safeParse({ ...good, audience: { ...good.audience, age_min: 16 } }).success).toBe(false);
  });
});
