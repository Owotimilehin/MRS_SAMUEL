/** Today's Lagos (UTC+1, no DST) business date as yyyy-mm-dd. */
export function lagosToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}
