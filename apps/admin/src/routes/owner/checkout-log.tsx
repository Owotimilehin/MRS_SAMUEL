import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, humanizeError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { StatHero } from "../../components/StatHero.js";
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
      <StatHero
        eyebrow="Admin"
        title="Checkout log"
        sub={'Every "Place order" press on the website in the last 30 days: delivery details, errors, and what happened.'}
        loading={loading}
        chips={[
          { label: "Attempts", value: attempts.length },
          {
            label: "With errors",
            value: attempts.filter((a) => a.stages.some((s) => s.status === "error")).length,
          },
        ]}
      />
      <div>
        {loading && <InlineLoader />}
        {error && (
          <div className="empty" role="alert">
            <div className="empty__title">We couldn't load this</div>
            {error}
          </div>
        )}
        {!loading && !error && attempts.length === 0 && (
          <div className="empty">
            <div className="empty__title">No checkout attempts yet</div>
            When a customer presses "Place order" on the website, it shows up here.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {attempts.map((a) => (
            <div
              key={a.attempt_id}
              className="card"
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "2px 8px", fontSize: 14, flexWrap: "wrap" }}>
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
                  <li key={i} style={{ fontSize: 13, display: "flex", gap: "0 10px", alignItems: "baseline", flexWrap: "wrap" }}>
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
