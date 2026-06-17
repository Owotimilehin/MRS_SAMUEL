/** Subscription billing periods and their length in days. */
export const SUBSCRIPTION_PERIOD_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

/** Days in a billing period; defaults to monthly for unknown labels. */
export function periodDays(period: string): number {
  return SUBSCRIPTION_PERIOD_DAYS[period.toLowerCase().trim()] ?? 30;
}

/** The next charge timestamp = `from` + one period. */
export function nextChargeAfter(period: string, from: Date): Date {
  return new Date(from.getTime() + periodDays(period) * 24 * 60 * 60 * 1000);
}

/** How many days a past_due subscription is given before auto-cancel. */
export const PAST_DUE_GRACE_DAYS = 7;
