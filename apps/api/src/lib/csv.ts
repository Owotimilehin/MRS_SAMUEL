/**
 * Minimal RFC 4180 CSV serialiser. Avoids pulling in a dependency for
 * what's effectively two helpers.
 */

/** Escape a single value per RFC 4180. Wraps in quotes if the value contains
 *  a comma, quote, CR, or LF; doubles internal quotes. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join a row of values into a CSV line. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",");
}

/** Serialise a header + rows array into a full CSV document with CRLF endings. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const lines = [csvRow(header), ...rows.map((r) => csvRow(r))];
  return lines.join("\r\n") + "\r\n";
}
