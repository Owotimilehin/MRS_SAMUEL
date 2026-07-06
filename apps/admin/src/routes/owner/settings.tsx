import { useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, humanizeError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { StatHero } from "../../components/StatHero.js";
import {
  getReceiptStyle,
  setReceiptStyle,
  RECEIPT_STYLES,
} from "../../lib/receipt-settings.js";
import { buildReceiptFromCart, type ReceiptData, type ReceiptStyle } from "../../lib/receipt-data.js";
import { renderReceiptHtml } from "../../lib/receipt-html.js";
import { printReceipt } from "../../lib/print-receipt.js";

/** A representative sale used to preview/test the receipt without a real order. */
function sampleReceipt(style: ReceiptStyle): ReceiptData {
  return buildReceiptFromCart({
    style,
    receiptNo: "SAMPLE-0001",
    whenIso: "2026-06-23T13:45:00.000Z",
    branch: {
      name: "Ajao Estate",
      address: "30 Asa-Afariogun St, Ajao Estate, Lagos",
      phone: "0901 951 2246",
    },
    servedBy: "Mrs. Samuel",
    channel: "walkup",
    payment: "transfer",
    items: [
      { name: "Zobo Blast", sizeMl: 500, qty: 2, unitNgn: 1500 },
      { name: "Pineapple Ginger", sizeMl: 330, qty: 1, unitNgn: 1200 },
    ],
  });
}

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
      setError(humanizeError(err));
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
      setError(humanizeError(err));
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
          <PaymentProviderCard />
          <BannerCard />
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
              <ReadRow label="Delivery partner" value="Shipbubble · live" />
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
  const [style, setStyle] = useState<ReceiptStyle>(getReceiptStyle());
  const [printing, setPrinting] = useState(false);
  const [printMsg, setPrintMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const previewHtml = useMemo(() => renderReceiptHtml(sampleReceipt(style)), [style]);

  async function testPrint(): Promise<void> {
    setPrinting(true);
    setPrintMsg(null);
    try {
      const res = await printReceipt(sampleReceipt(style), { promptIfNeeded: true });
      setPrintMsg({ ok: res.ok, text: res.message });
    } catch (err) {
      setPrintMsg({ ok: false, text: humanizeError(err) });
    } finally {
      setPrinting(false);
    }
  }

  return (
    <section className="card">
      <h2 className="t-h2" style={{ marginBottom: 4 }}>
        Receipt style
      </h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 12 }}>
        Choose how printed receipts look. The preview shows a sample sale at 80mm — exactly
        as it prints. Applies to every till and reprint on this device.
      </p>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 20,
          alignItems: "flex-start",
        }}
      >
        {/* Style picker */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: "1 1 240px" }}>
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
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            disabled={printing}
            onClick={() => void testPrint()}
            style={{ marginTop: 4, alignSelf: "flex-start" }}
          >
            {printing ? "Printing…" : "Print test receipt"}
          </button>
          {printMsg && (
            <div
              role="status"
              style={{
                fontSize: 12,
                color: printMsg.ok ? "var(--success)" : "var(--danger)",
              }}
            >
              {printMsg.text}
            </div>
          )}
        </div>

        {/* Live preview */}
        <div style={{ flex: "0 0 auto" }}>
          <div style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 }}>Preview</div>
          <div
            style={{
              width: 302,
              background: "#fff",
              borderRadius: 6,
              boxShadow: "0 6px 24px rgba(0,0,0,0.12)",
              border: "1px solid var(--line)",
              overflow: "hidden",
            }}
          >
            <iframe
              title="Receipt preview"
              srcDoc={previewHtml}
              style={{ width: 302, height: 520, border: 0, display: "block" }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function BannerCard(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await api<{ enabled: boolean; message: string }>("/settings/banner");
        if (alive) {
          setEnabled(Boolean(cfg.enabled));
          setMessage(cfg.message ?? "");
        }
      } catch {
        /* leave defaults */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setMsg(null);
    try {
      await api("/settings/banner", {
        method: "PATCH",
        body: JSON.stringify({ enabled, message }),
      });
      setMsg({ ok: true, text: "Saved." });
      window.setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setMsg({ ok: false, text: humanizeError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="t-h2" style={{ marginBottom: 4 }}>
        Homepage banner
      </h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 14 }}>
        A message across the top of the homepage. When off (or empty), the site shows the
        automatic in-stock / preorder banner instead.
      </p>
      {loading ? (
        <InlineLoader />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            Show banner
          </label>
          <label className="field">
            <span className="field__label">Message</span>
            <textarea
              className="input"
              rows={3}
              maxLength={280}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="330ml is for bulk preorder only. 650ml still available for same-day delivery."
            />
            <span style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>
              {message.length}/280
            </span>
          </label>
          {enabled && message.trim() && (
            <div>
              <div style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 }}>Preview</div>
              <div
                style={{
                  background: "var(--brand, #0b3d2e)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 500,
                  textAlign: "center",
                  padding: "10px 14px",
                  borderRadius: 8,
                  whiteSpace: "pre-line",
                }}
              >
                {message}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={saving}
              onClick={() => void save()}
              style={{ alignSelf: "flex-start" }}
            >
              {saving ? "Saving…" : "Save banner"}
            </button>
            {msg && (
              <span
                role="status"
                style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--danger)" }}
              >
                {msg.text}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PaymentProviderCard(): JSX.Element {
  const [provider, setProvider] = useState<"opay" | "payaza">("opay");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await api<{ provider: "opay" | "payaza" }>("/settings/payment-provider");
        if (alive) setProvider(cfg.provider === "payaza" ? "payaza" : "opay");
      } catch {
        /* leave default */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function choose(next: "opay" | "payaza"): Promise<void> {
    if (next === provider) return;
    const prev = provider;
    setProvider(next); // optimistic
    setSaving(true);
    setMsg(null);
    try {
      await api("/settings/payment-provider", {
        method: "PATCH",
        body: JSON.stringify({ provider: next }),
      });
      setMsg({ ok: true, text: "Saved. New orders use this immediately." });
      window.setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setProvider(prev); // roll back on failure
      setMsg({ ok: false, text: humanizeError(err) });
    } finally {
      setSaving(false);
    }
  }

  const options: Array<{ value: "opay" | "payaza"; title: string; hint: string }> = [
    {
      value: "opay",
      title: "OPay (redirect — recommended)",
      hint: "Sends the customer to OPay's own secure payment page, then back to their order. No popup to fail.",
    },
    {
      value: "payaza",
      title: "Payaza (popup — fallback)",
      hint: "Card payment in a popup on the checkout page. Use only if OPay is unavailable.",
    },
  ];

  return (
    <section className="card">
      <h2 className="t-h2" style={{ marginBottom: 4 }}>
        Online payment provider
      </h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 14 }}>
        Which provider new online orders use to collect payment. Switching takes effect
        immediately for the next order — no app update needed.
      </p>
      {loading ? (
        <InlineLoader />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {options.map((o) => (
            <label
              key={o.value}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                padding: "12px 14px",
                border: "1px solid var(--line, #e2e2e2)",
                borderRadius: 8,
                background: provider === o.value ? "var(--brand-tint, #eef6f2)" : "transparent",
                cursor: saving ? "default" : "pointer",
                opacity: saving ? 0.7 : 1,
              }}
            >
              <input
                type="radio"
                name="payment-provider"
                checked={provider === o.value}
                disabled={saving}
                onChange={() => void choose(o.value)}
                style={{ width: 18, height: 18, marginTop: 2 }}
              />
              <span>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{o.title}</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--ink-soft)", marginTop: 2 }}>
                  {o.hint}
                </span>
              </span>
            </label>
          ))}
          {msg && (
            <span
              role="status"
              style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--danger)" }}
            >
              {msg.text}
            </span>
          )}
        </div>
      )}
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
