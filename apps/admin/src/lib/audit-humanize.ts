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

/**
 * Read the first present key from an object, trying each name in order.
 * Audit `afterJson` payloads are inconsistent: some call sites pass the full
 * Drizzle row (camelCase, e.g. `orderNumber`) while others pass a hand-built
 * snake_case object (e.g. `amount_ngn`). This lets one humanizer cover both.
 */
function pick(obj: Json, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** "12500" → "₦12,500". Leaves non-numeric values as a plain string. */
function ngn(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return String(v ?? "—");
  return `₦${n.toLocaleString()}`;
}

/** "other_with_note" → "other with note" — tidy a snake_case code for display. */
function tidy(v: unknown): string {
  if (typeof v !== "string") return String(v ?? "—");
  return v.replace(/_/g, " ");
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  branch_staff: "Branch staff",
  factory_dispatcher: "Factory (legacy)",
  branch_manager: "Manager (legacy)",
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

  const s = (v: unknown): string => (typeof v === "string" ? v : "—");
  const transferNum = () => s(pick(after, "transferNumber", "transfer_number")) || "a transfer";
  const orderNum = () => s(pick(after, "orderNumber", "order_number", "saleNumber")) || "a sale";

  switch (row.action) {
    case "auth.login_success":
      return "Signed in";

    // ── Users ──
    case "admin_user.invite": {
      const email = s(pick(after, "email")) || "a user";
      const role = roleLabel(s(pick(after, "role")));
      return `Invited ${role} — ${email}`;
    }
    case "admin_user.update":
      return `Updated user ${s(pick(after, "email")) || ""}`.trim();
    case "admin_user.reset_password":
      return "Reset a user's password";

    // ── Branches ──
    case "branch.create":
      return `Created branch ${s(pick(after, "name"))}`;
    case "branch.update":
      return `Updated branch ${s(pick(after, "name") ?? pick(before, "name"))}`;
    case "branch.delete":
      return `Deleted branch ${s(pick(before, "name") ?? pick(after, "name"))}`;

    // ── Products & pricing ──
    case "product.create":
      return `Created product ${s(pick(after, "name"))}`;
    case "product.update":
      return `Updated product ${s(pick(after, "name") ?? pick(before, "name"))}`;
    case "product.delete":
      return `Deleted product ${s(pick(before, "name") ?? pick(after, "name"))}`;
    case "product_price.publish": {
      const size = pick(after, "size_ml", "sizeMl");
      const price = pick(after, "price_ngn", "priceNgn");
      return `Set price to ${ngn(price)}${size ? ` for the ${size}ml size` : ""}`;
    }

    // ── Blog ──
    case "blog_post.create":
      return `Drafted post "${s(pick(after, "title"))}"`;
    case "blog_post.update":
      return `Updated post "${s(pick(after, "title") ?? pick(before, "title"))}"`;
    case "blog_post.delete":
      return `Deleted post "${s(pick(before, "title") ?? pick(after, "title"))}"`;

    // ── Vendors ──
    case "vendor.create":
      return `Added vendor ${s(pick(after, "name"))}`;
    case "vendor.update":
      return `Updated vendor ${s(pick(after, "name") ?? pick(before, "name"))}`;
    case "vendor.delete":
      return `Removed vendor ${s(pick(before, "name") ?? pick(after, "name"))}`;

    // ── Expenses ──
    case "recurring_expense.create":
      return `Added recurring expense — ${tidy(pick(after, "category_code"))} (${ngn(pick(after, "amount_ngn"))}/mo)`;
    case "recurring_expense.update":
      return `Updated a recurring expense`;
    case "recurring_expense.delete":
      return `Deleted a recurring expense`;
    case "business_expense.create":
      return `Recorded expense — ${tidy(pick(after, "category_code"))} (${ngn(pick(after, "amount_ngn"))})`;
    case "business_expense.update":
      return `Updated an expense`;
    case "business_expense.delete":
      return `Deleted an expense`;

    // ── Packaging ──
    case "packaging_material.create":
      return `Added packaging material ${s(pick(after, "name"))}`;
    case "packaging_material.update":
      return `Updated packaging material ${s(pick(after, "name") ?? pick(before, "name"))}`;
    case "packaging_purchase.create": {
      const qty = pick(after, "quantity");
      return `Recorded packaging purchase — ${qty ? `${qty} units, ` : ""}${ngn(pick(after, "total_cost_ngn"))}`;
    }
    case "packaging_stock.adjust": {
      const name = s(pick(after, "name"));
      const oldC = pick(after, "old_count");
      const newC = pick(after, "new_count");
      const reason = pick(after, "reason");
      return `Adjusted packaging stock — ${name} ${oldC} → ${newC}${reason ? ` (${reason})` : ""}`;
    }

    // ── Marketing ──
    case "subscription_plan.create":
      return `Created subscription plan ${s(pick(after, "name"))}`;
    case "subscription_plan.update":
      return `Updated subscription plan ${s(pick(after, "name") ?? pick(before, "name"))}`;
    case "subscription_plan.delete":
      return `Deleted subscription plan ${s(pick(before, "name") ?? pick(after, "name"))}`;
    case "bundle.create":
      return `Created bundle ${s(pick(after, "name"))}`;
    case "bundle.update":
      return `Updated bundle ${s(pick(after, "name") ?? pick(before, "name"))}`;
    case "bundle.delete":
      return `Deleted bundle ${s(pick(before, "name") ?? pick(after, "name"))}`;

    // ── Media ──
    case "media_asset.create":
      return "Uploaded an image";

    // ── Inventory ──
    case "stock_adjustment.create": {
      const reason = tidy(pick(after, "reason_code"));
      const count = pick(after, "item_count");
      return `Adjusted stock — ${reason}${count ? ` (${count} item${count === 1 ? "" : "s"})` : ""}`;
    }

    // ── Production ──
    case "production_run.create_draft":
      return `Started production run for ${s(pick(after, "runDate", "run_date"))}`;
    case "production_run.complete":
      return `Completed production run for ${s(pick(after, "runDate", "run_date"))}`;
    case "production_run.append_items": {
      const added = pick(after, "added");
      return `Added ${added ?? "items"} to a production run`;
    }
    case "production_run.update_item":
      return "Edited a production run item";
    case "production_run.delete_item":
      return "Removed a production run item";

    // ── Transfers ──
    case "stock_transfer.create_draft":
      return `Drafted ${transferNum()} for ${branchName(pick(after, "branchId", "branch_id"))}`;
    case "stock_transfer.dispatch":
      return `Sent ${transferNum()} to ${branchName(pick(after, "branchId", "branch_id"))}`;
    case "stock_transfer.arrive":
      return `Marked ${transferNum()} as arrived`;
    case "stock_transfer.receive": {
      const variance = s(pick(after, "status")) === "received_with_variance";
      return variance ? `Received ${transferNum()} with a mismatch` : `Received ${transferNum()}`;
    }
    case "stock_transfer.approve_variance":
      return `Approved variance on ${transferNum()}`;
    case "stock_transfer.reject": {
      const reason = s(pick(after, "rejectReason", "reject_reason"));
      return reason !== "—" ? `Rejected ${transferNum()} — ${reason}` : `Rejected ${transferNum()}`;
    }
    case "stock_transfer.adjust_count": {
      const side = s(pick(after, "side"));
      const qty = pick(after, "new_quantity");
      return `Corrected ${side === "sent" ? "dispatched" : "received"} count to ${qty ?? "?"}`;
    }

    // ── Sales ──
    case "sale.create_draft":
      return `Started sale ${orderNum()}`;
    case "sale.confirm":
      return `Confirmed sale ${orderNum()}`;
    case "sale.pay":
      return `Took payment for sale ${orderNum()}`;
    case "sale.hand_over":
      return `Handed over sale ${orderNum()}`;
    case "sale.mark_delivered":
      return `Marked sale ${orderNum()} as delivered`;
    case "sale.advance":
      return `Advanced order ${orderNum()}`;
    case "sale.cancel":
      return `Cancelled sale ${orderNum()}`;

    // ── Returns ──
    case "sale_return.create":
      return `Started return ${s(pick(after, "returnNumber", "return_number"))}`;
    case "sale_return.approve":
      return `Approved return ${s(pick(after, "returnNumber", "return_number"))}`;

    // ── Preorders ──
    case "preorder.fulfil":
      return "Fulfilled a preorder";

    // ── Shift end (formerly "daily close") ──
    case "daily_close.submit":
      return `Filed shift-end report for ${branchName(pick(after, "branchId", "branch_id"))} (${s(pick(after, "businessDate", "business_date"))})`;
    case "daily_close.approve":
      return `Approved shift-end report for ${branchName(pick(after, "branchId", "branch_id"))} (${s(pick(after, "businessDate", "business_date"))})`;

    // ── Shift start (opening count) ──
    case "shift_open.submit":
      return "Filed opening stock count";

    default:
      // Last-resort fallback — turn "some_thing.did_action" into
      // "Some thing — did action" so even an unmapped row is readable.
      return tidy(row.action.replace(".", " — "));
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

  const id8 = row.entityId.slice(0, 8);
  const str = (key: string): string | undefined => {
    const v = fromEither(key);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  switch (row.entityType) {
    case "stock_transfer":
    case "stock_transfer_item":
      return str("transferNumber") ?? str("transfer_number") ?? id8;
    case "admin_user":
      return str("email") ?? id8;
    case "branch":
      return str("name") ?? id8;
    case "product":
    case "packaging_material":
    case "vendor":
    case "subscription_plan":
    case "bundle":
      return str("name") ?? id8;
    case "sale_order":
      return str("orderNumber") ?? str("order_number") ?? id8;
    case "sale_return":
      return str("returnNumber") ?? str("return_number") ?? id8;
    case "production_run":
      return str("runDate") ?? str("run_date") ?? id8;
    case "daily_close":
      return str("businessDate") ?? str("business_date") ?? id8;
    case "blog_post":
      return str("title") ?? id8;
    case "business_expense":
    case "recurring_expense":
      return str("category_code") ? tidy(str("category_code")) : id8;
    default: {
      const after = j(row.afterJson);
      const before = j(row.beforeJson);
      const named = pick(after, "name", "title", "label", "email", "code", "number", "orderNumber") ??
        pick(before, "name", "title", "label", "email", "code", "number", "orderNumber");
      if (typeof named === "string" && named.trim()) return named;
      return `${entityTypeLabel(row.entityType)} #${id8}`;
    }
  }
}

/** "admin_user" → "User", "stock_transfer" → "Transfer", etc. */
export function entityTypeLabel(entityType: string): string {
  const map: Record<string, string> = {
    admin_user: "User",
    branch: "Branch",
    product: "Product",
    stock_transfer: "Transfer",
    stock_transfer_item: "Transfer",
    stock_adjustment: "Stock adjustment",
    sale_order: "Sale",
    sale_return: "Return",
    production_run: "Production run",
    daily_close: "Shift end",
    blog_post: "Blog post",
    vendor: "Vendor",
    packaging_material: "Packaging",
    packaging_purchase: "Packaging purchase",
    business_expense: "Expense",
    recurring_expense: "Recurring expense",
    subscription_plan: "Subscription plan",
    bundle: "Bundle",
    media_asset: "Image",
  };
  if (map[entityType]) return map[entityType];
  const words = entityType.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : entityType;
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

/** Fields that carry no human meaning: UUIDs, foreign-key ids, timestamps, secrets. */
const NOISE_FIELD = /(^id$|Id$|_id$|At$|_at$|^createdAt|^updatedAt|json$|Json$|hash|token|secret)/;

/** "weirdInternalId" / "reject_reason" → "Weird internal id" / "Reject reason". */
function tidyLabel(field: string): string {
  const words = field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

/**
 * Generic diff for entity types that don't have a curated FIELD_LABELS entry.
 * Skips noise (ids, timestamps, secrets) and nested objects/arrays.
 */
function genericDiff(b: Record<string, unknown>, a: Record<string, unknown>): DiffLine[] {
  const fields = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: DiffLine[] = [];
  for (const field of fields) {
    if (NOISE_FIELD.test(field)) continue;
    const bv = b[field];
    const av = a[field];
    if (typeof bv === "object" && bv !== null) continue; // skip nested objects/arrays in the generic view
    if (typeof av === "object" && av !== null) continue;
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    out.push({ field, label: tidyLabel(field), before: fmtValue(field, bv), after: fmtValue(field, av) });
  }
  return out;
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
  if (!labels) return genericDiff(b as Record<string, unknown>, a as Record<string, unknown>);

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
