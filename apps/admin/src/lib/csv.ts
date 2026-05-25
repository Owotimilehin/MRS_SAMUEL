/**
 * Convert an array of plain objects to a CSV string + trigger a browser
 * download. Headers come from the first object's keys (in declared order),
 * or a caller-supplied header list. Values are JSON-stringified if not
 * primitives and quote-escaped per RFC 4180.
 */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  headers?: Array<keyof T>,
): void {
  if (rows.length === 0) return;
  const cols = (headers ?? (Object.keys(rows[0] as Record<string, unknown>) as Array<keyof T>)) as Array<keyof T>;

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const headerLine = cols.map((c) => escape(String(c))).join(",");
  const lines = rows.map((r) => cols.map((c) => escape(r[c])).join(","));
  const csv = [headerLine, ...lines].join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
