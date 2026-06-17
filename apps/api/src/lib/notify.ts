/** Fields that are noise in a change log — never surfaced to the owner. */
const SKIP_FIELDS = new Set([
  "id", "createdAt", "updatedAt", "created_at", "updated_at",
  "passwordHash", "password_hash", "mfaSecret", "mfa_secret",
  "deletedAt", "deleted_at", "permissionOverrides", "permission_overrides",
  "failedLoginCount", "failed_login_count", "lockedUntil", "locked_until",
]);

/** Friendly labels for common fields; unknown keys are humanized from the key. */
const LABELS: Record<string, string> = {
  priceNgn: "Price", price_ngn: "Price",
  totalNgn: "Total", total_ngn: "Total",
  amountNgn: "Amount", amount_ngn: "Amount",
  name: "Name", email: "Email", phone: "Phone", role: "Role",
  isActive: "Active", is_active: "Active",
  status: "Status", quantity: "Quantity", sizeMl: "Size (ml)",
  branchId: "Branch", branch_id: "Branch",
};

function humanizeKey(k: string): string {
  return k
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function fmt(key: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" && /ngn$/i.test(key)) return `₦${v.toLocaleString()}`;
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

export function diffChanges(
  before: unknown,
  after: unknown,
): Array<{ label: string; from: string; to: string }> {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const out: Array<{ label: string; from: string; to: string }> = [];
  for (const key of Object.keys(a)) {
    if (SKIP_FIELDS.has(key)) continue;
    const bv = b[key];
    const av = a[key];
    if (bv === av) continue;
    // Only diff scalars; skip objects/arrays (too noisy for a chat line).
    if (av !== null && typeof av === "object") continue;
    if (bv !== null && bv !== undefined && typeof bv === "object") continue;
    if (!(key in b)) continue; // only report fields that existed before (true edits)
    out.push({ label: LABELS[key] ?? humanizeKey(key), from: fmt(key, bv), to: fmt(key, av) });
  }
  return out.slice(0, 6);
}
