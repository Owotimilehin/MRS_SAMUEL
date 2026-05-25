/**
 * Turn raw audit_log rows into plain-language English.
 *
 * The audit row's `afterJson` (and `beforeJson` for updates) already carries
 * the friendly identifiers we need — transfer number, email, branch name —
 * because every `writeAudit` call site passes the full entity row. So this
 * file is pure presentation; no extra API calls.
 */

export interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  actorBranchId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: string;
}

export interface UserLookup {
  id: string;
  email: string;
}

export interface BranchLookup {
  id: string;
  name: string;
}

type Json = Record<string, unknown> | null | undefined;
const j = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : null);

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  factory_dispatcher: "Factory",
  branch_manager: "Branch manager",
  branch_staff: "Branch staff",
};

/** Friendly role label or the raw value if unknown. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "—";
  return ROLE_LABEL[role] ?? role;
}

/**
 * Actor cell: "Owner — owner@example.com".
 * For older login rows where the actor was null, fall back to the row's
 * entity_id (the user who logged in is the subject).
 */
export function humanizeActor(row: AuditRow, users: UserLookup[]): string {
  let userId = row.actorUserId;
  if (!userId && row.action === "auth.login_success") userId = row.entityId;
  if (!userId) return "System";
  const email = users.find((u) => u.id === userId)?.email ?? userId.slice(0, 8);
  const role = row.actorRole;
  if (row.action === "auth.login_success" && !role) {
    const after = j(row.afterJson);
    const roleFromAfter = typeof after?.["role"] === "string" ? (after["role"] as string) : null;
    return `${roleLabel(roleFromAfter)} — ${email}`;
  }
  return `${roleLabel(role)} — ${email}`;
}

/**
 * One sentence describing what happened, e.g. "Sent transfer TRF-2026-00012
 * to Ajao Estate". Reads any identifiers it needs from afterJson/beforeJson.
 */
export function humanizeAction(row: AuditRow, branches: BranchLookup[]): string {
  const after = j(row.afterJson);
  const before = j(row.beforeJson);

  const branchName = (id: unknown): string => {
    if (typeof id !== "string") return "—";
    return branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);
  };

  switch (row.action) {
    case "auth.login_success":
      return "Signed in";

    case "admin_user.invite": {
      const email = (after?.["email"] as string | undefined) ?? "a user";
      const role = roleLabel((after?.["role"] as string | undefined) ?? null);
      return `Invited ${role} — ${email}`;
    }
    case "admin_user.update": {
      const email = (after?.["email"] as string | undefined) ?? "user";
      return `Updated ${email}`;
    }
    case "admin_user.reset_password":
      return "Reset a user's password";

    case "branch.create":
      return `Created branch ${(after?.["name"] as string | undefined) ?? "—"}`;
    case "branch.update":
      return `Updated branch ${(after?.["name"] as string | undefined) ?? (before?.["name"] as string | undefined) ?? "—"}`;

    case "product.create":
      return `Created product ${(after?.["name"] as string | undefined) ?? "—"}`;
    case "product.update":
      return `Updated product ${(after?.["name"] as string | undefined) ?? (before?.["name"] as string | undefined) ?? "—"}`;

    case "blog.create":
      return `Drafted post "${(after?.["title"] as string | undefined) ?? "—"}"`;
    case "blog.update":
      return `Updated post "${(after?.["title"] as string | undefined) ?? "—"}"`;
    case "blog.publish":
      return `Published post "${(after?.["title"] as string | undefined) ?? "—"}"`;

    case "production_run.create_draft":
      return `Started production run for ${(after?.["runDate"] as string | undefined) ?? (after?.["run_date"] as string | undefined) ?? "—"}`;
    case "production_run.complete":
      return `Completed production run for ${(after?.["runDate"] as string | undefined) ?? (after?.["run_date"] as string | undefined) ?? "—"}`;

    case "stock_transfer.create_draft":
    case "stock_transfer.dispatch": {
      const num = (after?.["transferNumber"] as string | undefined) ?? "transfer";
      return `Sent ${num} to ${branchName(after?.["branchId"])}`;
    }
    case "stock_transfer.arrive":
      return `Marked ${(after?.["transferNumber"] as string | undefined) ?? "a transfer"} as arrived`;
    case "stock_transfer.receive": {
      const num = (after?.["transferNumber"] as string | undefined) ?? "a transfer";
      const variance = (after?.["status"] as string | undefined) === "received_with_variance";
      return variance ? `Received ${num} with a mismatch` : `Received ${num}`;
    }
    case "stock_transfer.approve_variance":
      return `Approved variance on ${(after?.["transferNumber"] as string | undefined) ?? "a transfer"}`;
    case "stock_transfer.reject": {
      const num = (after?.["transferNumber"] as string | undefined) ?? "a transfer";
      const reason = (after?.["rejectReason"] as string | undefined) ?? "";
      return reason ? `Rejected ${num} — ${reason}` : `Rejected ${num}`;
    }

    case "sale.create_draft":
      return `Started sale ${(after?.["saleNumber"] as string | undefined) ?? "—"}`;
    case "sale.confirm":
      return `Confirmed sale ${(after?.["saleNumber"] as string | undefined) ?? "—"}`;
    case "sale.mark_paid":
      return `Marked sale ${(after?.["saleNumber"] as string | undefined) ?? "—"} as paid`;
    case "sale.hand_over":
      return `Handed over sale ${(after?.["saleNumber"] as string | undefined) ?? "—"}`;
    case "sale.cancel":
      return `Cancelled sale ${(after?.["saleNumber"] as string | undefined) ?? "—"}`;

    case "return.create":
      return `Created return ${(after?.["returnNumber"] as string | undefined) ?? "—"}`;
    case "return.approve":
      return `Approved return ${(after?.["returnNumber"] as string | undefined) ?? "—"}`;

    case "daily_close.submit":
      return `Submitted daily close for ${branchName(after?.["branchId"])} (${(after?.["closeDate"] as string | undefined) ?? "—"})`;
    case "daily_close.approve":
      return `Approved daily close for ${branchName(after?.["branchId"])} (${(after?.["closeDate"] as string | undefined) ?? "—"})`;

    default:
      return row.action;
  }
}

/**
 * Secondary "details" cell. The row's friendly identifier when one exists.
 * Falls back to the first 8 characters of the entity UUID.
 */
export function humanizeEntity(row: AuditRow): string {
  const after = j(row.afterJson);
  const before = j(row.beforeJson);
  const fromEither = (key: string): unknown => after?.[key] ?? before?.[key];

  switch (row.entityType) {
    case "stock_transfer":
      return (fromEither("transferNumber") as string | undefined) ?? row.entityId.slice(0, 8);
    case "admin_user":
      return (fromEither("email") as string | undefined) ?? row.entityId.slice(0, 8);
    case "branch":
      return (fromEither("name") as string | undefined) ?? row.entityId.slice(0, 8);
    case "product":
      return (fromEither("name") as string | undefined) ?? row.entityId.slice(0, 8);
    case "sale_order":
      return (fromEither("saleNumber") as string | undefined) ?? row.entityId.slice(0, 8);
    case "sale_return":
      return (fromEither("returnNumber") as string | undefined) ?? row.entityId.slice(0, 8);
    case "production_run":
      return (fromEither("runDate") as string | undefined) ?? row.entityId.slice(0, 8);
    case "daily_close":
      return (fromEither("closeDate") as string | undefined) ?? row.entityId.slice(0, 8);
    case "blog_post":
      return (fromEither("title") as string | undefined) ?? row.entityId.slice(0, 8);
    default:
      return row.entityId.slice(0, 8);
  }
}

/** "admin_user" → "User", "stock_transfer" → "Transfer", etc. */
export function entityTypeLabel(entityType: string): string {
  const map: Record<string, string> = {
    admin_user: "User",
    branch: "Branch",
    product: "Product",
    stock_transfer: "Transfer",
    sale_order: "Sale",
    sale_return: "Return",
    production_run: "Production run",
    daily_close: "Daily close",
    blog_post: "Blog post",
  };
  return map[entityType] ?? entityType;
}

/**
 * Per-entity field-label maps. Fields not listed here are filtered out of
 * the diff (uuids, timestamps, internal flags — noise to humans).
 */
const FIELD_LABELS: Record<string, Record<string, string>> = {
  admin_user: {
    email: "Email",
    role: "Role",
    branchId: "Branch",
    isActive: "Active",
    phone: "Phone",
    lockedUntil: "Locked until",
    failedLoginCount: "Failed login attempts",
  },
  branch: {
    name: "Name",
    code: "Code",
    address: "Address",
    phone: "Phone",
    managerUserId: "Manager",
    deliveryZones: "Delivery zones",
    opensAt: "Opens at",
    closesAt: "Closes at",
  },
  product: {
    name: "Name",
    slug: "Slug",
    category: "Category",
    ingredients: "Ingredients",
    description: "Description",
    isActive: "Active",
  },
  stock_transfer: {
    status: "Status",
    driverName: "Driver",
    vehicleInfo: "Vehicle",
    rejectReason: "Reject reason",
    notes: "Notes",
  },
  sale_order: {
    status: "Status",
    paymentMethod: "Payment method",
    channel: "Channel",
    totalNgn: "Total",
    notes: "Notes",
  },
  sale_return: {
    status: "Status",
    refundMethod: "Refund method",
    notes: "Notes",
  },
  daily_close: {
    status: "Status",
    expectedCashNgn: "Expected cash",
    countedCashNgn: "Counted cash",
    varianceNgn: "Variance",
    notes: "Notes",
  },
};

const VALUE_FORMATTERS: Record<string, (v: unknown) => string> = {
  role: (v) => roleLabel(typeof v === "string" ? v : null),
  isActive: (v) => (v ? "Active" : "Disabled"),
  status: (v) => (typeof v === "string" ? v.replace(/_/g, " ") : String(v ?? "—")),
};

function fmtValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const f = VALUE_FORMATTERS[field];
  if (f) return f(v);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export interface DiffLine {
  field: string;
  label: string;
  before: string;
  after: string;
}

/**
 * Plain-language change list. Returns an empty array when there's nothing
 * worth showing (creates/deletes use the entity dump instead).
 */
export function humanizeDiff(
  before: unknown,
  after: unknown,
  entityType: string,
): DiffLine[] {
  const b = j(before) ?? {};
  const a = j(after) ?? {};
  const labels = FIELD_LABELS[entityType];
  if (!labels) return [];

  const out: DiffLine[] = [];
  for (const [field, label] of Object.entries(labels)) {
    const bv = (b as Record<string, unknown>)[field];
    const av = (a as Record<string, unknown>)[field];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    out.push({
      field,
      label,
      before: fmtValue(field, bv),
      after: fmtValue(field, av),
    });
  }
  return out;
}
