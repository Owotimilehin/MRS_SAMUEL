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
  // "Updated inbox team Sales", or just "Updated inbox team" when the row has no name.
  const withName = (text: string, v: unknown, quoted = false): string => {
    const n = s(v);
    if (n === "—") return text;
    return quoted ? `${text} "${n}"` : `${text} ${n}`;
  };

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
    case "business_expense.branch_create":
      return `Logged shop spending — ${s(pick(after, "description"))} (${ngn(pick(after, "amount_ngn"))})`;
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
    case "sale.edit_delivery_address":
      return `Edited delivery address for order ${orderNum()}`;
    case "sale.cancel":
      return `Cancelled sale ${orderNum()}`;
    case "sale.packaging_set":
      return `Recorded packaging for ${orderNum()}`;
    case "sale_order.record_offline_payment":
      return `Recorded offline payment for ${orderNum()}`;
    case "sale_order.cancel_unpaid":
      return `Cancelled ${orderNum()} — unpaid`;

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

    // ── Inbox: conversations ──
    case "inbox.message_send": {
      const failed = s(pick(after, "status")) === "failed";
      const what = s(pick(after, "type")) === "template" ? "a WhatsApp template message" : "a WhatsApp message";
      return failed ? `Tried to send ${what} (it failed)` : `Sent ${what}`;
    }
    case "inbox.note_add":
      return "Added an internal note to a conversation";
    case "inbox.conversation_update": {
      const status = pick(after, "status");
      if (status === "closed") return "Closed a conversation";
      if (status === "open") return "Reopened a conversation";
      if (after && "assignee_id" in after) {
        return after["assignee_id"] ? "Assigned a conversation" : "Unassigned a conversation";
      }
      if (after && "team_id" in after) return "Moved a conversation to another team";
      if (after && "labels" in after) return "Changed a conversation's labels";
      return "Updated a conversation";
    }

    // ── Inbox: calls ──
    case "inbox.call_transfer": {
      const team = s(pick(after, "team"));
      return team !== "—" ? `Transferred a call to ${team}` : "Transferred a call";
    }
    case "inbox.recording_play":
      return "Listened to a call recording";
    case "inbox.recording_download":
      return "Downloaded a call recording";
    case "inbox.recording_delete":
      return "Deleted a call recording";

    // ── Inbox: contacts ──
    case "inbox.contact_update":
      return "Edited a contact's name or notes";
    case "inbox.contact_merge": {
      const moved = pick(after, "moved_conversations");
      return typeof moved === "number"
        ? `Merged two contacts (${moved} conversation${moved === 1 ? "" : "s"} moved)`
        : "Merged two contacts";
    }
    case "inbox.contact_erase":
      return "Erased a contact's messages and calls";
    case "inbox.contacts_export": {
      const n = pick(after, "rows");
      return typeof n === "number"
        ? `Downloaded the contact list (${n} contact${n === 1 ? "" : "s"})`
        : "Downloaded the contact list";
    }

    // ── Inbox: quick replies & templates ──
    case "inbox.quick_reply_create":
      return withName("Added quick reply", pick(after, "title"), true);
    case "inbox.quick_reply_update":
      return withName("Edited quick reply", pick(after, "title") ?? pick(before, "title"), true);
    case "inbox.quick_reply_delete":
      return withName("Deleted quick reply", pick(before, "title") ?? pick(after, "title"), true);
    case "inbox.templates_sync": {
      const n = pick(after, "count");
      return typeof n === "number"
        ? `Refreshed WhatsApp templates (${n} found)`
        : "Refreshed WhatsApp templates";
    }

    // ── Inbox: settings ──
    case "inbox.number_create":
      return withName("Added phone number", pick(after, "label", "e164"));
    case "inbox.number_update":
      return withName("Updated phone number", pick(after, "label") ?? pick(before, "label", "e164"));
    case "inbox.number_register":
      return `Registered ${withName("phone number", pick(after, "label"))} on WhatsApp`;
    case "inbox.number_access_set":
      return "Changed which phone numbers a staff member can use";
    case "inbox.team_create":
      return withName("Created inbox team", pick(after, "name"));
    case "inbox.team_update":
      return withName("Updated inbox team", pick(after, "name") ?? pick(before, "name"));
    case "inbox.team_members_set":
      return "Changed an inbox team's members";
    case "inbox.hours_create":
      return withName("Added opening hours", pick(after, "name"), true);
    case "inbox.hours_update":
      return withName("Updated opening hours", pick(after, "name") ?? pick(before, "name"), true);
    case "inbox.holiday_create":
      return withName("Added holiday", pick(after, "name"));
    case "inbox.holiday_delete":
      return withName("Removed holiday", pick(before, "name") ?? pick(after, "name"));
    case "inbox.ivr_create":
      return withName("Created phone menu", pick(after, "name"), true);
    case "inbox.ivr_update":
      return withName("Updated phone menu", pick(after, "name") ?? pick(before, "name"), true);

    default: {
      // Last-resort fallback: turn "some_thing.did_action" into
      // "Some thing: did action" so even an unmapped row is readable.
      const words = tidy(row.action.replace(".", ": "));
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/**
 * Filter-dropdown label for an action key, e.g. "inbox.contacts_export" →
 * "Inbox: contact list downloads". Unknown keys are tidied, never shown raw.
 */
const ACTION_LABEL: Record<string, string> = {
  "auth.login_success": "Sign-ins",
  "admin_user.invite": "User invites",
  "admin_user.update": "User updates",
  "admin_user.reset_password": "Password resets",
  "branch.create": "Branches created",
  "branch.update": "Branches updated",
  "branch.delete": "Branches deleted",
  "product.create": "Products created",
  "product.update": "Products updated",
  "product.delete": "Products deleted",
  "product_price.publish": "Prices published",
  "blog_post.create": "Posts drafted",
  "blog_post.update": "Posts updated",
  "blog_post.delete": "Posts deleted",
  "vendor.create": "Vendors added",
  "vendor.update": "Vendors updated",
  "vendor.delete": "Vendors removed",
  "recurring_expense.create": "Recurring expenses added",
  "recurring_expense.update": "Recurring expenses updated",
  "recurring_expense.delete": "Recurring expenses deleted",
  "business_expense.create": "Expenses recorded",
  "business_expense.branch_create": "Shop spending logged",
  "business_expense.update": "Expenses updated",
  "business_expense.delete": "Expenses deleted",
  "packaging_material.create": "Packaging materials added",
  "packaging_material.update": "Packaging materials updated",
  "packaging_purchase.create": "Packaging purchases",
  "packaging_stock.adjust": "Packaging stock adjustments",
  "bundle.create": "Bundles created",
  "bundle.update": "Bundles updated",
  "bundle.delete": "Bundles deleted",
  "media_asset.create": "Images uploaded",
  "stock_adjustment.create": "Stock adjustments",
  "production_run.create_draft": "Production runs started",
  "production_run.complete": "Production runs completed",
  "production_run.append_items": "Production items added",
  "production_run.update_item": "Production items edited",
  "production_run.delete_item": "Production items removed",
  "stock_transfer.create_draft": "Transfers drafted",
  "stock_transfer.dispatch": "Transfers sent",
  "stock_transfer.arrive": "Transfers arrived",
  "stock_transfer.receive": "Transfers received",
  "stock_transfer.approve_variance": "Variances approved",
  "stock_transfer.reject": "Transfers rejected",
  "stock_transfer.adjust_count": "Transfer counts corrected",
  "sale.create_draft": "Sales started",
  "sale.confirm": "Sales confirmed",
  "sale.pay": "Sales paid",
  "sale.hand_over": "Sales handed over",
  "sale.mark_delivered": "Sales delivered",
  "sale.advance": "Orders advanced",
  "sale.edit_delivery_address": "Delivery addresses edited",
  "sale.cancel": "Sales cancelled",
  "sale.packaging_set": "Sale packaging recorded",
  "sale_order.record_offline_payment": "Offline payments recorded",
  "sale_order.cancel_unpaid": "Unpaid orders cancelled",
  "sale_return.create": "Returns created",
  "sale_return.approve": "Returns approved",
  "preorder.fulfil": "Preorders fulfilled",
  "daily_close.submit": "Shift-end reports filed",
  "daily_close.approve": "Shift-end reports approved",
  "shift_open.submit": "Opening stock counts filed",
  "inbox.message_send": "Inbox: messages sent",
  "inbox.note_add": "Inbox: internal notes added",
  "inbox.conversation_update": "Inbox: conversations updated",
  "inbox.call_transfer": "Inbox: calls transferred",
  "inbox.recording_play": "Inbox: recordings played",
  "inbox.recording_download": "Inbox: recordings downloaded",
  "inbox.recording_delete": "Inbox: recordings deleted",
  "inbox.contact_update": "Inbox: contacts edited",
  "inbox.contact_merge": "Inbox: contacts merged",
  "inbox.contact_erase": "Inbox: contacts erased",
  "inbox.contacts_export": "Inbox: contact list downloads",
  "inbox.quick_reply_create": "Inbox: quick replies added",
  "inbox.quick_reply_update": "Inbox: quick replies edited",
  "inbox.quick_reply_delete": "Inbox: quick replies deleted",
  "inbox.templates_sync": "Inbox: templates refreshed",
  "inbox.number_create": "Inbox: phone numbers added",
  "inbox.number_update": "Inbox: phone numbers updated",
  "inbox.number_register": "Inbox: numbers registered on WhatsApp",
  "inbox.number_access_set": "Inbox: number access changed",
  "inbox.team_create": "Inbox: teams created",
  "inbox.team_update": "Inbox: teams updated",
  "inbox.team_members_set": "Inbox: team members changed",
  "inbox.hours_create": "Inbox: opening hours added",
  "inbox.hours_update": "Inbox: opening hours updated",
  "inbox.holiday_create": "Inbox: holidays added",
  "inbox.holiday_delete": "Inbox: holidays removed",
  "inbox.ivr_create": "Inbox: phone menus created",
  "inbox.ivr_update": "Inbox: phone menus updated",
};

export function actionFilterLabel(action: string): string {
  const known = ACTION_LABEL[action];
  if (known) return known;
  const [area, verb] = action.split(".");
  const a = entityTypeLabel(area ?? action);
  return verb ? `${a}: ${tidy(verb)}` : a;
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
    // ── Inbox ── (these rows carry no customer name, so say what the thing is
    // and give a short reference instead of a wrong or raw label)
    case "customer":
      if (row.entityId === "export") return "All contacts";
      if (row.action === "inbox.contact_merge") return `Contact ref ${id8} (merged into another)`;
      return str("name") ?? `${row.action.startsWith("inbox.") ? "Contact" : "Customer"} ref ${id8}`;
    case "inbox_conversation":
      return `Conversation ref ${id8}`;
    case "inbox_message":
    case "inbox_note": {
      const conv = str("conversation_id");
      return conv ? `In conversation ref ${conv.slice(0, 8)}` : `${entityTypeLabel(row.entityType)} ref ${id8}`;
    }
    case "inbox_call":
      return `Call ref ${id8}`;
    case "inbox_recording":
      return `Recording ref ${id8}`;
    case "inbox_template":
      return row.entityId === "all" ? "All WhatsApp templates" : str("name") ?? `Template ref ${id8}`;
    case "inbox_phone_number":
      return str("label") ?? str("e164") ?? `Phone number ref ${id8}`;
    case "inbox_quick_reply":
      return str("title") ?? `Quick reply ref ${id8}`;
    case "inbox_team":
    case "inbox_hours_profile":
    case "inbox_holiday":
    case "inbox_ivr_menu":
      return str("name") ?? `${entityTypeLabel(row.entityType)} ref ${id8}`;
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
    bundle: "Bundle",
    media_asset: "Image",
    customer: "Customer",
    inbox_conversation: "Conversation",
    inbox_message: "Message",
    inbox_note: "Internal note",
    inbox_call: "Call",
    inbox_recording: "Call recording",
    inbox_template: "WhatsApp template",
    inbox_quick_reply: "Quick reply",
    inbox_phone_number: "Phone number",
    inbox_team: "Inbox team",
    inbox_hours_profile: "Opening hours",
    inbox_holiday: "Holiday",
    inbox_ivr_menu: "Phone menu",
    inbox: "Inbox",
    auth: "Sign-in",
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
