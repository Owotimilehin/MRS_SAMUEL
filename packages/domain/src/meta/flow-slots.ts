/**
 * Phase B of WhatsApp forms (suite spec 07, section 5.10): the live delivery-time picker. WhatsApp
 * asks our data endpoint which days and times to show; this file answers from the line's opening
 * hours, the holidays and the bookings already made through the form.
 *
 * Nothing here writes anything. A booking becomes real only when the customer's completed form
 * arrives on the messages webhook and is stored as a wa_flow_response row.
 *
 * The capacity numbers are placeholders agreed in the spec (section 14, item 4): only bookings made
 * through this form are counted, not real orders.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { inboxConversation, inboxHoliday, inboxHoursProfile, inboxHoursRule, inboxPhoneNumber, waFlowResponse, type DbExecutor } from "@ms/db";
import { localParts } from "@ms/shared";

export const SLOT_WINDOWS = ["09:00-11:00", "11:00-13:00", "13:00-15:00", "15:00-17:00", "17:00-19:00"] as const;
/** Bookings per window. */
export const SLOT_CAPACITY = 4;
/** A window must start at least 3 hours from now. */
export const SLOT_LEAD_MS = 3 * 3600_000;
/** Offer the next 5 days that have any room. */
export const SLOT_DAYS_AHEAD = 5;
/** How far ahead we look for those days. */
const SLOT_LOOKAHEAD_DAYS = 14;

export interface SlotOption {
  id: string;
  title: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** "2026-11-20" -> "Fri 20 Nov". */
export function slotDayTitle(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function hourTitle(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/** "11:00-13:00" -> "11am to 1pm". */
export function slotTitle(id: string): string {
  const [from, to] = id.split("-") as [string, string];
  return `${hourTitle(minutesOf(from))} to ${hourTitle(minutesOf(to))}`;
}

export interface SlotContext {
  /** Opening periods; null = the line has no hours profile (all five windows, Monday to Saturday). */
  rules: { weekday: number; open: number; close: number }[] | null;
  holidays: Set<string>;
  today: string;
  nowMinutes: number;
  booked: Map<string, number>;
}

async function loadContext(db: DbExecutor, phoneNumberRowId: string, now: Date, days: string[]): Promise<SlotContext> {
  const [line] = await db
    .select({ profileId: inboxPhoneNumber.hoursProfileId, timeZone: inboxHoursProfile.timeZone })
    .from(inboxPhoneNumber)
    .leftJoin(inboxHoursProfile, eq(inboxHoursProfile.id, inboxPhoneNumber.hoursProfileId))
    .where(eq(inboxPhoneNumber.id, phoneNumberRowId));
  const profileId = line?.profileId ?? null;
  const { date: today, minutes: nowMinutes } = localParts(now, line?.timeZone ?? "Africa/Lagos");
  const wanted = days.length ? days : Array.from({ length: SLOT_LOOKAHEAD_DAYS + 1 }, (_, i) => shiftDay(today, i));

  const rules = profileId
    ? (await db.select().from(inboxHoursRule).where(eq(inboxHoursRule.profileId, profileId))).map((r) => ({
        weekday: r.weekday,
        open: minutesOf(r.openTime),
        close: minutesOf(r.closeTime),
      }))
    : null;
  const holidayRows = await db
    .select({ date: inboxHoliday.date })
    .from(inboxHoliday)
    .where(and(inArray(inboxHoliday.date, wanted), profileId ? or(isNull(inboxHoliday.profileId), eq(inboxHoliday.profileId, profileId)) : isNull(inboxHoliday.profileId)));
  // One indexed lookup (idx_wa_flow_response_slot) for every day we may offer.
  const counts = await db
    .select({ day: sql<string>`${waFlowResponse.data}->>'day'`, slot: sql<string>`${waFlowResponse.data}->>'slot'`, n: sql<number>`count(*)::int` })
    .from(waFlowResponse)
    .where(and(eq(waFlowResponse.flowKey, "delivery_slot"), inArray(sql`${waFlowResponse.data}->>'day'`, wanted)))
    .groupBy(sql`${waFlowResponse.data}->>'day'`, sql`${waFlowResponse.data}->>'slot'`);
  return {
    rules,
    holidays: new Set(holidayRows.map((h) => String(h.date).slice(0, 10))),
    today,
    nowMinutes,
    booked: new Map(counts.map((c) => [`${c.day}|${c.slot}`, Number(c.n)])),
  };
}

/** The windows still on offer for one day: open, not a holiday, far enough ahead, and not full. Pure. */
export function slotsFor(ctx: SlotContext, day: string): SlotOption[] {
  if (!DAY_RE.test(day) || ctx.holidays.has(day)) return [];
  const daysAhead = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${ctx.today}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(daysAhead) || daysAhead < 0 || daysAhead > SLOT_LOOKAHEAD_DAYS) return [];
  const weekday = weekdayOf(day);
  const out: SlotOption[] = [];
  for (const id of SLOT_WINDOWS) {
    const [from, to] = id.split("-") as [string, string];
    const start = minutesOf(from);
    const end = minutesOf(to);
    const open = ctx.rules === null ? weekday !== 0 : ctx.rules.some((r) => r.weekday === weekday && r.close > r.open && r.open <= start && r.close >= end);
    if (!open) continue;
    // Minutes from now to the start of the window, on the business's own clock.
    const untilStart = daysAhead * 1440 + start - ctx.nowMinutes;
    if (untilStart * 60_000 < SLOT_LEAD_MS) continue;
    if ((ctx.booked.get(`${day}|${id}`) ?? 0) >= SLOT_CAPACITY) continue;
    out.push({ id, title: slotTitle(id) });
  }
  return out;
}

/** The next days (at most SLOT_DAYS_AHEAD) that still have any room. */
export async function openDays(db: DbExecutor, phoneNumberRowId: string, now: Date): Promise<SlotOption[]> {
  const ctx = await loadContext(db, phoneNumberRowId, now, []);
  const out: SlotOption[] = [];
  for (let i = 0; i <= SLOT_LOOKAHEAD_DAYS && out.length < SLOT_DAYS_AHEAD; i++) {
    const day = shiftDay(ctx.today, i);
    if (slotsFor(ctx, day).length > 0) out.push({ id: day, title: slotDayTitle(day) });
  }
  return out;
}

/** The windows still free on one day. */
export async function openSlots(db: DbExecutor, phoneNumberRowId: string, day: string, now: Date): Promise<SlotOption[]> {
  if (!DAY_RE.test(day)) return [];
  return slotsFor(await loadContext(db, phoneNumberRowId, now, [day]), day);
}

export const SLOT_MESSAGES = {
  none: "We have no delivery times free in the next few days. Please message us and we will help.",
  dayFull: "That day is now full. Please choose another.",
  slotTaken: "That time has just been taken. Please choose another.",
} as const;

/** Thrown when the token's conversation no longer exists (the route answers 427). */
export class SlotConversationGoneError extends Error {
  constructor() {
    super("the conversation for this form no longer exists");
    this.name = "SlotConversationGoneError";
  }
}

/**
 * Answer one call from the form (already decrypted and its token checked). Returns the object
 * WhatsApp expects: the next screen and its data, or the SUCCESS screen with what to send back.
 */
export async function handleSlotFlow(
  db: DbExecutor,
  req: { action: string; screen?: string; data?: Record<string, unknown>; conversationId: string; token: string },
  now: Date,
): Promise<Record<string, unknown>> {
  const [conv] = await db.select({ line: inboxConversation.phoneNumberId }).from(inboxConversation).where(eq(inboxConversation.id, req.conversationId));
  if (!conv) throw new SlotConversationGoneError();
  const line = conv.line;

  const pickDay = async (error?: string): Promise<Record<string, unknown>> => {
    const days = await openDays(db, line, now);
    if (days.length === 0) {
      return { screen: "PICK_DAY", data: { days: [{ id: "none", title: "No times available" }], error_message: SLOT_MESSAGES.none } };
    }
    return { screen: "PICK_DAY", data: { days, ...(error ? { error_message: error } : {}) } };
  };

  const data = req.data ?? {};
  const day = typeof data.day === "string" ? data.day : "";
  const slot = typeof data.slot === "string" ? data.slot : "";

  if (req.action === "data_exchange" && req.screen === "PICK_DAY") {
    const slots = DAY_RE.test(day) ? await openSlots(db, line, day, now) : [];
    if (slots.length === 0) return pickDay(SLOT_MESSAGES.dayFull);
    return { screen: "PICK_TIME", data: { day, day_label: slotDayTitle(day), slots } };
  }
  if (req.action === "data_exchange" && req.screen === "PICK_TIME") {
    // Checked again at the moment of booking: someone else may have taken the last place.
    const slots = DAY_RE.test(day) ? await openSlots(db, line, day, now) : [];
    if (slots.length === 0) return pickDay(SLOT_MESSAGES.dayFull);
    const chosen = slots.find((s) => s.id === slot);
    if (!chosen) return { screen: "PICK_TIME", data: { day, day_label: slotDayTitle(day), slots, error_message: SLOT_MESSAGES.slotTaken } };
    return {
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: { flow_token: req.token, flow_key: "delivery_slot", day, slot, slot_label: `${slotDayTitle(day)}, ${chosen.title}` },
        },
      },
    };
  }
  // INIT, BACK to the first screen, and anything we do not recognise.
  return pickDay();
}

/**
 * Was this booking over the limit when it arrived? True when more than SLOT_CAPACITY answers exist
 * for its day and time and this one is not among the first SLOT_CAPACITY by arrival.
 */
export async function slotOverbooked(db: DbExecutor, response: { id: string; data: Record<string, unknown> }): Promise<boolean> {
  const day = typeof response.data.day === "string" ? response.data.day : "";
  const slot = typeof response.data.slot === "string" ? response.data.slot : "";
  if (!day || !slot) return false;
  const rows = await db
    .select({ id: waFlowResponse.id })
    .from(waFlowResponse)
    .where(and(eq(waFlowResponse.flowKey, "delivery_slot"), sql`${waFlowResponse.data}->>'day' = ${day}`, sql`${waFlowResponse.data}->>'slot' = ${slot}`))
    .orderBy(waFlowResponse.createdAt, waFlowResponse.id)
    .limit(SLOT_CAPACITY + 50);
  const at = rows.findIndex((r) => r.id === response.id);
  return rows.length > SLOT_CAPACITY && at >= SLOT_CAPACITY;
}

export const SLOT_OVERBOOKED_TEXT = "This time was already full when it arrived";
