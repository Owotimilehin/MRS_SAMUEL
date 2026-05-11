const ngnFormatter = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
});

export function ngn(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return ngnFormatter.format(amount);
}

export function formatDate(s: string | Date | null | undefined): string {
  if (!s) return "—";
  const d = typeof s === "string" ? new Date(s) : s;
  return d.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(s: string | Date | null | undefined): string {
  if (!s) return "—";
  const d = typeof s === "string" ? new Date(s) : s;
  return d.toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" });
}
