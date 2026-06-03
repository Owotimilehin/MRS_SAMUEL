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
  "reports.view",
  "audit.view",
  "devices.view",
  "customers.view",
  "orders.view",
  "production.manage",
  "transfers.create",
  "transfers.receive",
  "orders.manage",
  "pos.sell",
  "sales.view",
  "daily_close.submit",
  "returns.create",
  "stock.adjust",
  "stock.read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ADMIN_CAPS: Capability[] = [
  "products.manage",
  "prices.manage",
  "branches.manage",
  "zones.manage",
  "settings.manage",
  "blog.manage",
  "reports.view",
  "audit.view",
  "devices.view",
  "customers.view",
  "orders.view",
];

const MANAGER_CAPS: Capability[] = [
  "reports.view",
  "audit.view",
  "devices.view",
  "customers.view",
  "orders.view",
  "production.manage",
  "transfers.create",
  "transfers.receive",
  "orders.manage",
  "pos.sell",
  "sales.view",
  "daily_close.submit",
  "returns.create",
  "stock.read",
];

const BRANCH_STAFF_CAPS: Capability[] = ["pos.sell", "sales.view", "transfers.receive"];

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
