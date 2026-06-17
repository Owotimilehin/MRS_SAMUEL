import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { adminUser, branch, outboxEvent, type DbClient } from "@ms/db";

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
  // Pin the locale so grouping (₦1,800) is stable regardless of the host
  // process locale — a C/POSIX-locale CI runner would otherwise drop the comma.
  if (typeof v === "number" && /ngn$/i.test(key)) return `₦${v.toLocaleString("en-NG")}`;
  if (typeof v === "number") return v.toLocaleString("en-NG");
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

export function displayName(u: { name?: string | null; email: string }): string {
  return u.name?.trim() || u.email.split("@")[0] || u.email;
}

type Exec = Pick<DbClient, "insert" | "select">;

export interface ActorBlock {
  actor_name: string | null;
  actor_role: string | null;
  actor_branch_name: string | null;
}

/** Resolve the acting admin into the fields every notification needs. */
export async function resolveActor(db: Exec, c: Context): Promise<ActorBlock> {
  const auth = c.get("auth") as { userId: string; role: string; branchId: string | null } | undefined;
  if (!auth) return { actor_name: null, actor_role: null, actor_branch_name: null };
  const [u] = await db.select({ name: adminUser.name, email: adminUser.email })
    .from(adminUser).where(eq(adminUser.id, auth.userId)).limit(1);
  let branchName: string | null = null;
  if (auth.branchId) {
    const [b] = await db.select({ name: branch.name }).from(branch).where(eq(branch.id, auth.branchId)).limit(1);
    branchName = b?.name ?? null;
  }
  return {
    actor_name: u ? displayName(u) : null,
    actor_role: auth.role,
    actor_branch_name: branchName,
  };
}

/** Insert an outbox event with the acting admin stamped onto the payload. */
export async function enqueueOutbox(
  exec: Exec,
  c: Context,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const actor = await resolveActor(exec, c);
  await exec.insert(outboxEvent).values({ eventType, payload: { ...payload, ...actor } });
}
