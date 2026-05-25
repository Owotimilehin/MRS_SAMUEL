import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, ApiError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Branch {
  id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  opensAt: string | null;
  closesAt: string | null;
}

export function SettingsPage(): JSX.Element {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Partial<Branch>>>({});
  const [saving, setSaving] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Branch[] }>("/branches");
      setBranches(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function patch(branchId: string, patch: Partial<Branch>): void {
    setEdits((e) => ({ ...e, [branchId]: { ...(e[branchId] ?? {}), ...patch } }));
  }

  async function save(branchId: string): Promise<void> {
    const body = edits[branchId];
    if (!body) return;
    setSaving(branchId);
    try {
      await api(`/branches/${branchId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setEdits((e) => {
        const next = { ...e };
        delete next[branchId];
        return next;
      });
      setFlash("Saved.");
      await load();
      window.setTimeout(() => setFlash(null), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Shell title="Settings">
      {flash && (
        <div
          role="status"
          style={{
            background: "var(--success)",
            color: "#fff",
            padding: "10px 14px",
            borderRadius: 12,
            marginBottom: 14,
            fontSize: 14,
          }}
        >
          {flash}
        </div>
      )}
      {error && (
        <div role="alert" className="empty" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Operating hours & contact
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              Per-branch hours, address, and phone. The customer site reads these for the
              checkout cut-off and the contact block.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {branches.map((b) => {
                const e = edits[b.id] ?? {};
                const current = { ...b, ...e };
                const dirty = Object.keys(e).length > 0;
                return (
                  <div
                    key={b.id}
                    style={{
                      borderTop: "1px solid var(--line)",
                      paddingTop: 14,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        justifyContent: "space-between",
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        <h3 style={{ fontSize: 16, fontWeight: 700 }}>{b.name}</h3>
                        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{b.code}</div>
                      </div>
                      {dirty && (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={saving === b.id}
                          onClick={() => save(b.id)}
                        >
                          {saving === b.id ? "Saving…" : "Save"}
                        </button>
                      )}
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 12,
                      }}
                    >
                      <label className="field">
                        <span className="field__label">Opens at</span>
                        <input
                          type="time"
                          className="input"
                          value={current.opensAt ?? ""}
                          onChange={(ev) => patch(b.id, { opensAt: ev.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span className="field__label">Closes at</span>
                        <input
                          type="time"
                          className="input"
                          value={current.closesAt ?? ""}
                          onChange={(ev) => patch(b.id, { closesAt: ev.target.value })}
                        />
                      </label>
                      <label className="field" style={{ gridColumn: "1 / -1" }}>
                        <span className="field__label">Address</span>
                        <input
                          className="input"
                          value={current.address ?? ""}
                          onChange={(ev) => patch(b.id, { address: ev.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span className="field__label">Phone</span>
                        <input
                          className="input"
                          value={current.phone ?? ""}
                          onChange={(ev) => patch(b.id, { phone: ev.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Refunds & approvals
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              Refunds above this amount are flagged for your approval before they're processed.
            </p>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <input
                className="input"
                type="number"
                value={5000}
                disabled
                style={{ maxWidth: 160 }}
              />
              <span
                className="pill"
                style={{
                  background: "var(--surface-soft)",
                  color: "var(--ink-soft)",
                  fontSize: 11,
                }}
              >
                Hard-coded · DB migration to make editable
              </span>
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Payments & delivery
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              Set via environment variables. Reach out to dev to rotate keys.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
              <ReadRow label="Payaza secret" value="PAYAZA_SECRET_KEY (env)" />
              <ReadRow label="Bolt API key" value="BOLT_API_KEY (env)" />
              <ReadRow label="Bank transfer details" value="Configured on /checkout" />
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Notifications
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              Owner + branch Telegram channels and Resend "from" address.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
              <ReadRow
                label="Owner Telegram channel"
                value="TELEGRAM_OWNER_CHAT_ID (env)"
              />
              <ReadRow label="Branch Telegram channel" value="TELEGRAM_BRANCH_CHAT_ID (env)" />
              <ReadRow label="Email from" value="RESEND_FROM (env)" />
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Brand
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              WhatsApp number shown to customers across the site.
            </p>
            <ReadRow
              label="WhatsApp Business number"
              value="2347067220914 (hard-coded in apps/customer/src/data/menu.ts → BRAND.whatsapp)"
            />
          </section>
        </div>
      )}
    </Shell>
  );
}

function ReadRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>{label}</span>
      <code
        style={{
          background: "var(--surface-soft)",
          padding: "6px 10px",
          borderRadius: 8,
          fontSize: 12,
          color: "var(--ink)",
        }}
      >
        {value}
      </code>
    </div>
  );
}
