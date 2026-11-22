/**
 * Reply-time target (suite spec 15): the owner's setting and each line's
 * opening hours, so a chat's waiting time counts only minutes the business
 * was open. Shared by the conversation list and the Overview summary.
 */
import { eq } from "drizzle-orm";
import { appSetting, inboxHoliday, inboxHoursProfile, inboxHoursRule, inboxPhoneNumber, type DbClient } from "@ms/db";
import { REPLY_TARGET_KEY, businessMinutesBetween, readReplyTarget, type HoursRule } from "@ms/shared";

export interface LineHours {
  rules: HoursRule[];
  holidays: string[];
  timeZone: string;
}

/** The target in minutes, or null when it is off. */
export async function loadReplyTarget(db: DbClient): Promise<number | null> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, REPLY_TARGET_KEY));
  return readReplyTarget(row?.value);
}

/** Every line's schedule; a line without one maps to null (always open). */
export async function loadLineHours(db: DbClient): Promise<Map<string, LineHours | null>> {
  const lines = await db.select({ id: inboxPhoneNumber.id, profileId: inboxPhoneNumber.hoursProfileId }).from(inboxPhoneNumber);
  const profiles = await db.select().from(inboxHoursProfile);
  const rules = await db.select().from(inboxHoursRule);
  const holidays = await db.select().from(inboxHoliday);
  const byProfile = new Map<string, LineHours>();
  for (const p of profiles) {
    byProfile.set(p.id, {
      rules: rules.filter((r) => r.profileId === p.id).map((r) => ({ weekday: r.weekday, openTime: r.openTime, closeTime: r.closeTime })),
      // A holiday with no profile applies to every profile.
      holidays: holidays.filter((h) => h.profileId === null || h.profileId === p.id).map((h) => String(h.date)),
      timeZone: p.timeZone,
    });
  }
  const out = new Map<string, LineHours | null>();
  for (const l of lines) out.set(l.id, (l.profileId && byProfile.get(l.profileId)) || null);
  return out;
}

/**
 * Minutes the customer has waited during opening hours, or null when nothing
 * is waiting or the chat is not open work (pending, closed or snoozed).
 */
export function waitingMinutes(
  row: { status: string; waitingSince: Date | string | null; snoozedUntil?: Date | string | null; lineId: string },
  hours: Map<string, LineHours | null>,
  now: Date = new Date(),
): number | null {
  if (row.status !== "open" || !row.waitingSince) return null;
  if (row.snoozedUntil && new Date(row.snoozedUntil).getTime() > now.getTime()) return null;
  return businessMinutesBetween(new Date(row.waitingSince), now, hours.get(row.lineId) ?? null);
}
