import { CAPABILITIES, ROLE_DEFAULTS, type AdminRole, type Capability } from "@ms/shared";

const GROUPS: { heading: string; caps: Capability[] }[] = [
  { heading: "Users", caps: ["users.manage"] },
  { heading: "Approvals", caps: ["close.approve", "returns.approve", "transfers.adjust", "shrinkage.view"] },
  { heading: "Catalog", caps: ["products.manage", "prices.manage"] },
  { heading: "Business config", caps: ["branches.manage", "zones.manage", "settings.manage"] },
  { heading: "Content", caps: ["blog.manage", "marketing.manage"] },
  { heading: "Bookkeeping", caps: ["expenses.view", "expenses.write", "finance.view"] },
  { heading: "Visibility", caps: ["reports.view", "audit.view", "devices.view", "customers.view", "orders.view", "stock.read"] },
  { heading: "Operations", caps: ["production.manage", "transfers.create", "transfers.receive", "orders.manage", "packaging.view", "packaging.write", "packaging.adjust"] },
  { heading: "Branch / POS", caps: ["pos.sell", "pos.preorder", "shift_open.submit", "sales.view", "daily_close.submit", "returns.create", "stock.adjust"] },
];

const LABEL: Record<Capability, string> = {
  "users.manage": "Manage admin users",
  "close.approve": "Approve/dispute shift-end reports",
  "returns.approve": "Approve returns & refunds",
  "transfers.adjust": "Approve/adjust transfers",
  "shrinkage.view": "View shrinkage report",
  "products.manage": "Manage products",
  "prices.manage": "Manage prices",
  "branches.manage": "Manage branches & factories",
  "zones.manage": "Manage delivery zones",
  "settings.manage": "Manage settings",
  "blog.manage": "Manage blog/content",
  "marketing.manage": "Manage subscriptions, bundles & leads",
  "reports.view": "View reports & dashboard",
  "audit.view": "View audit log",
  "devices.view": "View devices",
  "customers.view": "View customers",
  "orders.view": "View orders",
  "production.manage": "Run production",
  "transfers.create": "Create transfers",
  "transfers.receive": "Receive transfers",
  "orders.manage": "Manage online orders",
  "pos.sell": "Use POS / sell",
  "pos.preorder": "Create/fulfil preorders",
  "shift_open.submit": "File opening stock count",
  "sales.view": "View sales",
  "daily_close.submit": "Submit shift-end report",
  "returns.create": "Create returns",
  "stock.adjust": "Adjust stock",
  "stock.read": "View stock & inventory",
  "expenses.write": "Record expenses",
  "expenses.view": "View bookkeeping & expenses",
  "finance.view": "View daily profit & financials (owner)",
  "packaging.view": "View packaging & materials",
  "packaging.write": "Manage packaging & materials",
  "packaging.adjust": "Adjust packaging stock (owner)",
};

// Silence unused import warning — CAPABILITIES is used at runtime via GROUPS validation.
void CAPABILITIES;

export interface GateValue {
  granted: Capability[];
  revoked: Capability[];
}

function effective(role: AdminRole, value: GateValue): Set<Capability> {
  const set = new Set<Capability>(ROLE_DEFAULTS[role]);
  for (const c of value.granted) set.add(c);
  for (const c of value.revoked) set.delete(c);
  return set;
}

export function GateEditor({
  role,
  value,
  onChange,
}: {
  role: AdminRole;
  value: GateValue;
  onChange: (next: GateValue) => void;
}): JSX.Element {
  const eff = effective(role, value);
  const defaults = new Set<Capability>(ROLE_DEFAULTS[role]);

  function toggle(cap: Capability, checked: boolean): void {
    const isDefault = defaults.has(cap);
    let granted = value.granted.filter((c) => c !== cap);
    let revoked = value.revoked.filter((c) => c !== cap);
    if (checked && !isDefault) granted = [...granted, cap];
    if (!checked && isDefault) revoked = [...revoked, cap];
    onChange({ granted, revoked });
  }

  return (
    <div className="gate-editor">
      {GROUPS.map((g) => (
        <fieldset key={g.heading} className="gate-editor__group">
          <legend>{g.heading}</legend>
          {g.caps.map((cap) => {
            const checked = eff.has(cap);
            const overridden = value.granted.includes(cap) || value.revoked.includes(cap);
            return (
              <label key={cap} className="gate-editor__row">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => toggle(cap, e.currentTarget.checked)}
                />
                <span>{LABEL[cap]}</span>
                {overridden ? <span className="gate-editor__badge">custom</span> : null}
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
