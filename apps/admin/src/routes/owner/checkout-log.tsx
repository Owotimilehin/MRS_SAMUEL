import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, humanizeError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { ngn } from "../../lib/format.js";

interface StageRow {
  stage: string;
  status: string;
  error_message: string | null;
  order_number: string | null;
  response: unknown;
  created_at: string;
}
interface Attempt {
  attempt_id: string;
  started_at: string;
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    state: string | null;
  };
  items: Array<{ name?: string; size?: string; qty?: number }>;
  total_ngn: number | null;
  stages: StageRow[];
}

const STATUS_COLOR: Record<string, string> = {
  ok: "#16a34a",
  error: "#dc2626",
  abandoned: "#d97706",
  info: "#6b7280",
};

function lagos(ts: string, opts: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleString("en-NG", { timeZone: "Africa/Lagos", ...opts });
}

export function CheckoutLogPage(): JSX.Element {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ attempts: Attempt[] }>("/reports/checkout-log")
      .then((r) => setAttempts(r.attempts))
      .catch((e) => setError(humanizeError(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Shell title="Checkout log">
      <div style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
        <p style={{ color: "var(--muted, #6b7280)", marginBottom: 20, fontSize: 14 }}>
          Every "Place order" press in the last 30 days — delivery details, errors, and what happened.
        </p>

        {loading && <InlineLoader />}
        {error && <div style={{ color: "#dc2626" }}>{error}</div>}
        {!loading && !error && attempts.length === 0 && (
          <p style={{ color: "#6b7280" }}>No checkout attempts recorded yet.</p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {attempts.map((a) => (
            <div
              key={a.attempt_id}
              style={{ border: "1px solid rgba(0,0,0,0.1)", borderRadius: 14, padding: 16, background: "#fff" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
                <span style={{ fontWeight: 700 }}>
                  {a.customer.name ?? "—"}
                  {a.customer.phone ? ` · ${a.customer.phone}` : ""}
                </span>
                <span style={{ color: "#6b7280" }}>
                  {lagos(a.started_at, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </div>
              {a.customer.address && (
                <div style={{ fontSize: 13, color: "#4b5563", marginTop: 2 }}>
                  {a.customer.address}
                  {a.customer.state ? `, ${a.customer.state}` : ""}
                </div>
              )}
              {a.items?.length > 0 && (
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                  {a.items.map((it, i) => (
                    <span key={i}>
                      {it.qty}× {it.name} {it.size}
                      {i < a.items.length - 1 ? ", " : ""}
                    </span>
                  ))}
                  {a.total_ngn != null && <span> · {ngn(a.total_ngn)}</span>}
                </div>
              )}
              <ol style={{ marginTop: 12, listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                {a.stages.map((s, i) => (
                  <li key={i} style={{ fontSize: 13, display: "flex", gap: 10, alignItems: "baseline" }}>
                    <span style={{ color: "#9ca3af", width: 80, flexShrink: 0 }}>
                      {lagos(s.created_at, { timeStyle: "medium" })}
                    </span>
                    <span style={{ fontWeight: 600, color: STATUS_COLOR[s.status] ?? "#111" }}>{s.stage}</span>
                    {s.order_number && <span style={{ color: "#6b7280" }}>({s.order_number})</span>}
                    {s.error_message && <span style={{ color: "#dc2626" }}>— {s.error_message}</span>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
