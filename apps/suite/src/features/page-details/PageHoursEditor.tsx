import { PAGE_DAYS, PAGE_DAY_NAMES, emptyWeek, type PageHoursRange, type PageWeek } from "@ms/shared";

/** Opening hours: one row per day, up to two time ranges (suite spec 10, section 7). Times are Lagos time. */
export function PageHoursEditor({
  week,
  onChange,
  disabled,
}: {
  week: PageWeek | null;
  onChange: (w: PageWeek) => void;
  disabled: boolean;
}): JSX.Element {
  const w = week ?? emptyWeek();
  const setRanges = (day: (typeof PAGE_DAYS)[number], ranges: PageHoursRange[]): void => onChange({ ...w, [day]: ranges });
  return (
    <div className="pd-hours">
      {PAGE_DAYS.map((day) => {
        const ranges = w[day] ?? [];
        const open = ranges.length > 0;
        return (
          <div key={day} className="pd-day">
            <label className="pd-switch">
              <input
                type="checkbox"
                checked={open}
                disabled={disabled}
                onChange={(e) => setRanges(day, e.target.checked ? [{ open: "09:00", close: "17:00" }] : [])}
              />
              <span>
                {PAGE_DAY_NAMES[day]} <span className="pd-fine">{open ? "Open" : "Closed"}</span>
              </span>
            </label>
            {ranges.map((r, i) => (
              <div key={i} className="pd-range">
                <input
                  className="input pd-time"
                  aria-label={`${PAGE_DAY_NAMES[day]} opens`}
                  inputMode="numeric"
                  maxLength={5}
                  placeholder="08:00"
                  value={r.open}
                  disabled={disabled}
                  onChange={(e) => setRanges(day, ranges.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))}
                />
                <span>to</span>
                <input
                  className="input pd-time"
                  aria-label={`${PAGE_DAY_NAMES[day]} closes`}
                  inputMode="numeric"
                  maxLength={5}
                  placeholder="18:00"
                  value={r.close}
                  disabled={disabled}
                  onChange={(e) => setRanges(day, ranges.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))}
                />
                {i === 1 && (
                  <button type="button" className="pd-link" disabled={disabled} onClick={() => setRanges(day, ranges.slice(0, 1))}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            {ranges.length === 1 && (
              <button
                type="button"
                className="pd-link"
                disabled={disabled}
                onClick={() => setRanges(day, [...ranges, { open: "14:00", close: "18:00" }])}
              >
                Add a second opening time
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
