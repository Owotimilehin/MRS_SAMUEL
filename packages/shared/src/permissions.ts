export const ADMIN_ROLES = ["owner", "admin", "manager", "branch_staff"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const CAPABILITIES = [
  "users.manage",
  "close.approve",
  "returns.approve",
  "transfers.adjust",
  "shrinkage.view",
  "products.manage",
  "prices.manage",
  "branches.manage",
  "zones.manage",
  "settings.manage",
  "blog.manage",
  "marketing.manage",
  "reports.view",
  // Owner-only by default: the deep financial views — monthly P&L (GET
  // /reports/pnl) and settled variance losses. Deliberately NOT in
  // ADMIN_CAPS/MANAGER_CAPS. Grantable per-user via overrides.
  "finance.view",
  // The day/range financial breakdown (GET /reports/daily). Split out of
  // finance.view so managers can see what a trading day earned — including the
  // online orders they fulfil — without unlocking company P&L, cost structure
  // or variance-loss settlements.
  //
  // Owner and manager only. Admins are deliberately excluded, preserving the
  // existing policy asserted in reports-daily.test.ts: daily takings are a
  // branch-operations concern (managers run the close), while the admin role
  // covers catalog, config and content. Grantable per-user via overrides.
  "finance.daily",
  "audit.view",
  "devices.view",
  "customers.view",
  "orders.view",
  "production.manage",
  "transfers.create",
  "transfers.receive",
  "orders.manage",
  "pos.sell",
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "daily_close.submit",
  "returns.create",
  "stock.adjust",
  "stock.read",
  "expenses.write",
  "expenses.view",
  "packaging.view",
  "packaging.write",
  // Owner-only by default: manual stock corrections (set new on-hand count).
  // Deliberately NOT in ADMIN_CAPS/MANAGER_CAPS — admins keep packaging.write
  // (purchases + materials) but cannot adjust counts unless granted per-user.
  "packaging.adjust",
  // Owner-only: accept a mismatched/partial payment as-is and mark an order
  // paid, or mark a previously-owed refund as settled. Gated owner-only because
  // these override our normal amount-equality guard.
  "orders.accept_payment",
  // Owner-only: settle a transfer variance to factory/branch/loss (corrects
  // stock across two locations and writes off genuine losses). Deliberately NOT
  // in ADMIN_CAPS/MANAGER_CAPS — managers may hold transfers.adjust but cannot
  // decide where variance lands.
  "variance.settle",
  // ── Unified inbox (WhatsApp + calls) ──
  // Scope: inbox.view_all = every conversation; inbox.view_team = conversations
  // of the teams the user belongs to; neither = only their own + unassigned in
  // their teams. Users without inbox.view_all are further limited to the
  // business numbers granted to them (inbox_user_number_access).
  "inbox.view",
  "inbox.view_team",
  "inbox.view_all",
  "inbox.reply",
  "inbox.assign",
  "inbox.close",
  "inbox.notes",
  // Send approved templates (the only thing WhatsApp allows outside 24h).
  "inbox.templates",
  "inbox.export",
  "calls.answer",
  "calls.outbound",
  "recordings.listen",
  "recordings.download",
  // Permanently delete a call recording (audio, transcript, summary).
  "recordings.delete",
  "transcripts.view",
  // Owner-only by default: erase a customer's inbox history on request, and
  // merge duplicate contacts' threads.
  "inbox.erase",
  // Numbers, teams, hours, phone menu, quick replies, template sync.
  "inbox.settings",
  "inbox.reports",
  // ── Suite: comments on Facebook and Instagram posts ──
  // See and answer comments (suite spec 03). Which accounts a person sees follows
  // the same per-line access as the inbox (inbox_user_number_access).
  "social.comments",
  // Catalogue: connect, sync and repair the Meta catalogue (spec 08).
  "catalogue.manage",
  // Connect and configure channel accounts (Facebook Page, Instagram); later:
  // chat set-up, WhatsApp profile, Page details. Admins, not managers.
  "channels.manage",
  // Write, submit and delete WhatsApp message templates (and later Flows). Admins, not managers
  // (managers keep inbox.templates: send only).
  "templates.manage",
  // Create, schedule and publish posts to Facebook and Instagram (suite spec 09).
  "social.publish",
  // See statistics from Facebook, Instagram and WhatsApp (suite spec 11).
  "insights.view",
  // Leads from Meta lead forms: see, work and report on them (spec 13).
  "leads.view",
  // See ad spend and results (suite spec 12).
  "ads.view",
  // Owner-only by default: create, switch on, pause and change adverts — this spends money.
  // Deliberately NOT in ADMIN_CAPS/MANAGER_CAPS. Grantable per-user via overrides.
  "ads.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ADMIN_CAPS: Capability[] = [
  "products.manage",
  "prices.manage",
  "branches.manage",
  "zones.manage",
  "settings.manage",
  "blog.manage",
  "marketing.manage",
  "reports.view",
  "audit.view",
  "devices.view",
  "customers.view",
  "orders.view",
  "expenses.view",
  "packaging.view",
  "packaging.write",
  // Branch / POS: admins oversee the till — they create/fulfil preorders and
  // view sales, but DO NOT ring up stock-consuming walk-up sales (pos.sell is
  // branch_staff/owner only). They never deplete stock, so they're never gated
  // by the opening count.
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "daily_close.submit",
  "returns.create",
  "stock.adjust",
  "orders.manage",
  "inbox.view",
  "inbox.view_all",
  "inbox.reply",
  "inbox.assign",
  "inbox.close",
  "inbox.notes",
  "inbox.templates",
  "inbox.export",
  "calls.answer",
  "calls.outbound",
  "recordings.listen",
  "recordings.download",
  "recordings.delete",
  "transcripts.view",
  "inbox.settings",
  "inbox.reports",
  "social.comments",
  "channels.manage",
  "templates.manage",
  "catalogue.manage",
  "social.publish",
  "insights.view",
  "leads.view",
  "ads.view",
];

const MANAGER_CAPS: Capability[] = [
  "reports.view",
  "finance.daily",
  "audit.view",
  "devices.view",
  "customers.view",
  "orders.view",
  "production.manage",
  "transfers.create",
  "transfers.receive",
  "orders.manage",
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "daily_close.submit",
  "returns.create",
  "stock.read",
  "stock.adjust",
  "packaging.view",
  // Supervisor in the inbox: their teams' conversations.
  "inbox.view",
  "inbox.view_team",
  "inbox.reply",
  "inbox.assign",
  "inbox.close",
  "inbox.notes",
  "inbox.templates",
  "calls.answer",
  "calls.outbound",
  "recordings.listen",
  "transcripts.view",
  "inbox.reports",
  "social.comments",
  "insights.view",
  "leads.view",
];

const BRANCH_STAFF_CAPS: Capability[] = [
  "pos.sell",
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "transfers.receive",
  // The till attends to online orders directly, so it needs the same order
  // visibility + follow-up powers admins/managers hold: see every order state
  // and re-check OPay / record an offline (transfer/cash) payment. Force-
  // accepting a MISMATCHED OPay amount stays owner-only (orders.accept_payment).
  "orders.view",
  "orders.manage",
];

export const ROLE_DEFAULTS: Record<AdminRole, readonly Capability[]> = {
  owner: [...CAPABILITIES],
  admin: ADMIN_CAPS,
  manager: MANAGER_CAPS,
  branch_staff: BRANCH_STAFF_CAPS,
};

export interface PermissionOverrides {
  granted: Capability[];
  revoked: Capability[];
}

export const EMPTY_OVERRIDES: PermissionOverrides = { granted: [], revoked: [] };

/** Effective capabilities = (role defaults ∪ granted) − revoked, in catalog order. */
export function resolveCapabilities(
  role: AdminRole,
  overrides: PermissionOverrides = EMPTY_OVERRIDES,
): Capability[] {
  const granted = Array.isArray(overrides?.granted) ? overrides.granted : [];
  const revoked = Array.isArray(overrides?.revoked) ? overrides.revoked : [];
  const set = new Set<Capability>(ROLE_DEFAULTS[role]);
  for (const c of granted) set.add(c);
  for (const c of revoked) set.delete(c);
  return CAPABILITIES.filter((c) => set.has(c));
}

export function hasCapability(caps: readonly Capability[], cap: Capability): boolean {
  return caps.includes(cap);
}
