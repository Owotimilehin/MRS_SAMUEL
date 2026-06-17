import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, ApiError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { StatHero } from "../../components/StatHero.js";
import {
  getReceiptStyle,
  setReceiptStyle,
  RECEIPT_STYLES,
} from "../../lib/receipt-settings.js";

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
      <StatHero
        eyebrow="Admin"
        title="Settings"
        sub="Branch operating hours, contacts, and integrations."
      />

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
          <ReceiptStyleCard />
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
              Refunds above this amount need your approval before they're processed at the
              branch.
            </p>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <input
                className="input"
                type="number"
                value={5000}
                disabled
                style={{ maxWidth: 160 }}
              />
              <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                Naira · contact support to change this threshold
              </span>
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Payments & delivery
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              Active integrations for accepting payments and dispatching riders.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
              <ReadRow label="Card payments" value="Payaza · live" />
              <ReadRow label="Delivery partner" value="Bolt · live" />
              <ReadRow
                label="Bank transfer"
                value="Account details shown to customers at checkout"
              />
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Notifications
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              Order alerts go to the owner channel; branch alerts go to each branch's channel.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
              <ReadRow label="Owner Telegram channel" value="Configured" />
              <ReadRow label="Branch Telegram channels" value="Configured" />
              <ReadRow label="Order receipts (email)" value="Sent automatically" />
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Brand
            </h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 16 }}>
              Contact details shown to customers on the public site.
            </p>
            <ReadRow label="WhatsApp Business number" value="+234 706 722 0914" />
            <ReadRow label="Phone (calls)" value="+234 706 722 0914" />
            <ReadRow label="Instagram" value="@mrs_samuelfruitjuice" />
          </section>
        </div>
      )}
    </Shell>
  );
}

function ReceiptStyleCard(): JSX.Element {
  const [style, setStyle] = useState(getReceiptStyle());
  return (
    <section className="card">
      <h2 className="t-h2" style={{ marginBottom: 4 }}>
        Receipt style
      </h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 12 }}>
        Choose how printed receipts look. Applies to every till and reprint on this device.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {RECEIPT_STYLES.map((s) => (
          <label
            key={s.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 12px",
              borderRadius: 12,
              cursor: "pointer",
              border: `1px solid ${style === s.id ? "var(--accent, #0b6b3a)" : "var(--line)"}`,
              background: style === s.id ? "rgba(11,107,58,0.05)" : "transparent",
            }}
          >
            <input
              type="radio"
              name="receipt-style"
              checked={style === s.id}
              onChange={() => {
                setReceiptStyle(s.id);
                setStyle(s.id);
              }}
              style={{ width: 18, height: 18, accentColor: "var(--accent, #0b6b3a)" }}
            />
            <span>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{s.label}</span>
              <span style={{ display: "block", color: "var(--ink-soft)", fontSize: 12 }}>{s.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function ReadRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gap: 12,
        alignItems: "center",
        padding: "6px 0",
      }}
    >
      <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 14, color: "var(--ink)" }}>{value}</span>
    </div>
  );
}
