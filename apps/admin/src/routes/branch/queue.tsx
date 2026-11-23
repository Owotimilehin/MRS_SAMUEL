import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { local, type OutboxRow } from "../../db/local.js";
import { flushOutbox } from "../../sync/engine.js";
import { BranchTabs } from "../../components/BranchTabs.js";
import { plainFailureReason, saleIdForOutboxRow } from "../../lib/sale-failure.js";
import { receiptCodeFromSaleId } from "../../lib/receipt-code.js";
import { ngn } from "../../lib/format.js";

interface SaleDetail {
  items: string;
  totalNgn: number | null;
  receiptNo: string;
}

function age(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Turn a raw outbox row (HTTP method + URL with UUIDs) into plain language a
 * shop owner can read at a glance. Known operations get a friendly label and a
 * short detail line; anything unrecognised falls back to a humanised path with
 * the IDs stripped out so the till never shows raw codes.
 */
function describeOperation(row: OutboxRow): { label: string; detail?: string } {
  const { method, endpoint, payload } = row;

  // PATCH /v1/branches/{id}/sales/{id}/pay
  if (method === "PATCH" && /\/sales\/[^/]+\/pay$/.test(endpoint)) {
    return { label: "Payment recorded" };
  }

  // POST /v1/branches/{id}/sales
  if (method === "POST" && /\/sales$/.test(endpoint)) {
    const p = payload as
      | { items?: unknown[]; payment_method?: string }
      | null
      | undefined;
    const count = Array.isArray(p?.items) ? p.items.length : 0;
    const itemsText = count > 0 ? `${count} ${count === 1 ? "item" : "items"}` : null;
    const payText = p?.payment_method ? titleCase(p.payment_method) : null;
    const detail = [itemsText, payText].filter(Boolean).join(" · ");
    return detail ? { label: "Sale rung up", detail } : { label: "Sale rung up" };
  }

  // Fallback: humanise the path, dropping version + UUID segments.
  const words = endpoint
    .split("/")
    .filter((seg) => seg && seg !== "v1" && !UUID.test(seg))
    .map((seg) => seg.replace(/[-_]/g, " "));
  const verb = method === "POST" ? "New" : "Update";
  return { label: titleCase([verb, ...words].join(" ")) };
}

function statusPill(s: OutboxRow["status"]): JSX.Element {
  if (s === "pending") return <span className="pill pill--warning">Pending</span>;
  if (s === "in_flight") return <span className="pill pill--ink">Sending…</span>;
  if (s === "acknowledged") return <span className="pill pill--success">Synced</span>;
  if (s === "dead") return <span className="pill pill--danger">Failed</span>;
  return <span className="pill">{s}</span>;
}

export function BranchQueuePage({ branchId }: { branchId: string }): JSX.Element {
  const rows =
    useLiveQuery(
      () =>
        local.outbox
          .orderBy("created_at_local")
          .reverse()
          .limit(200)
          .toArray(),
      [],
      [] as OutboxRow[],
    ) ?? [];

  const [acting, setActing] = useState<string | null>(null);

  async function retry(id: string): Promise<void> {
    setActing(id);
    await local.outbox
      .where("id")
      .equals(id)
      .modify((row) => {
        row.status = "pending";
        row.attempt_count = 0;
        row.next_attempt_at = Date.now();
        delete row.last_error;
        delete row.last_error_status;
      });
    void flushOutbox();
    setActing(null);
  }

  async function drop(id: string): Promise<void> {
    const reason = window.prompt(
      "Drop this operation permanently? Type a reason for the audit log.",
    );
    if (!reason) return;
    setActing(id);
    await local.outbox.delete(id);
    setActing(null);
  }

  // For each failed sale: what was in it, the total and its receipt code, so
  // the cashier can tell which customer it was. Built from the sale's Confirm
  // row (items), the local sale row (total + code) and the catalog (names).
  const deadKey = rows
    .filter((r) => r.status === "dead")
    .map((r) => r.id)
    .join(",");
  const saleDetails = useLiveQuery(
    async () => {
      const out: Record<string, SaleDetail> = {};
      const deadRows = await local.outbox.where("status").equals("dead").toArray();
      for (const r of deadRows) {
        const saleId = saleIdForOutboxRow(r);
        if (!saleId || out[saleId]) continue;
        const [confirm, sale] = await Promise.all([local.outbox.get(saleId), local.sales.get(saleId)]);
        const items = ((confirm?.payload as { items?: Array<{ product_id?: string; variant_id?: string; quantity?: number }> } | null)
          ?.items ?? []);
        const lines = await Promise.all(
          items.map(async (it) => {
            const [product, variant] = await Promise.all([
              it.product_id ? local.products.get(it.product_id) : undefined,
              it.variant_id ? local.variants.get(it.variant_id) : undefined,
            ]);
            const size = variant ? (variant.size_ml >= 1000 ? `${variant.size_ml / 1000}L` : `${variant.size_ml}ml`) : "";
            return `${it.quantity ?? 1} × ${product?.name ?? "Item"}${size ? ` ${size}` : ""}`;
          }),
        );
        out[saleId] = {
          items: lines.join(", "),
          totalNgn: sale?.total_ngn ?? null,
          receiptNo: sale?.order_number ?? receiptCodeFromSaleId(saleId),
        };
      }
      return out;
    },
    [deadKey],
    {} as Record<string, SaleDetail>,
  );

  const pendingRows = rows.filter((r) => r.status === "pending");
  const inFlightRows = rows.filter((r) => r.status === "in_flight");
  const pending = rows.filter((r) => r.status === "pending" || r.status === "in_flight");
  const dead = rows.filter((r) => r.status === "dead");
  const done = rows.filter((r) => r.status === "acknowledged").slice(0, 20);

  const queueChips: StatChip[] = [
    { label: "In queue", value: pendingRows.length ?? 0 },
    { label: "Sending", value: inFlightRows.length ?? 0 },
  ];
  if (dead.length > 0) {
    queueChips.push({ label: "Failed", value: dead.length, tone: "danger" });
  } else {
    queueChips.push({ label: "Failed", value: dead.length, tone: "good" });
  }
  queueChips.push({ label: "Synced", value: done.length ?? 0 });

  return (
    <BranchShell
      branchId={branchId}
      title="Sync queue"
      actions={
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => void flushOutbox()}
        >
          Sync now
        </button>
      }
    >
      <StatHero
        eyebrow="Branch"
        title="Sync queue"
        sub="Sales and changes made on this till that are still waiting to reach the server."
        chips={queueChips}
      />
      <BranchTabs items={[
        { to: "/branch/device", label: "Device" },
        { to: "/branch/queue", label: "Sync queue" },
      ]} />
      {pending.length === 0 && dead.length === 0 ? (
        <div className="empty">
          <div className="empty__title">Everything synced ✓</div>
          Nothing is waiting. Sales reach the server the moment they're rung up.
        </div>
      ) : (
        <>
          {dead.length > 0 && (
            <section className="card" style={{ marginBottom: 16 }}>
              <header style={{ marginBottom: 10 }}>
                <h2 className="t-h2" style={{ color: "var(--danger)" }}>
                  Failed ({dead.length})
                </h2>
                <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  The system turned these down. For a sale, the customer has already paid, so fix the
                  cause (for example, record the missing stock or open the shift) and tap Retry. Only
                  tap Drop if it should never be sent, and tell a manager.
                </p>
              </header>
              <QueueTable rows={dead} acting={acting} onRetry={retry} onDrop={drop} saleDetails={saleDetails} />
            </section>
          )}
          {pending.length > 0 && (
            <section className="card" style={{ marginBottom: 16 }}>
              <header style={{ marginBottom: 10 }}>
                <h2 className="t-h2">Pending ({pending.length})</h2>
                <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  Waiting to send. These go through by themselves when the network comes back.
                </p>
              </header>
              <QueueTable rows={pending} acting={acting} onRetry={retry} onDrop={drop} />
            </section>
          )}
        </>
      )}

      {done.length > 0 && (
        <section className="card">
          <header style={{ marginBottom: 10 }}>
            <h2 className="t-h2">Recently synced ({done.length})</h2>
          </header>
          <QueueTable rows={done} acting={acting} onRetry={retry} onDrop={drop} compact />
        </section>
      )}
    </BranchShell>
  );
}

function QueueTable({
  rows,
  acting,
  onRetry,
  onDrop,
  compact,
  saleDetails,
}: {
  rows: OutboxRow[];
  acting: string | null;
  onRetry: (id: string) => void;
  onDrop: (id: string) => void;
  compact?: boolean;
  saleDetails?: Record<string, SaleDetail>;
}): JSX.Element {
  return (
    <div className="table-wrap" style={{ border: 0 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Activity</th>
            <th>Status</th>
            {!compact && <th className="table__num">Attempts</th>}
            <th>When</th>
            {!compact && <th>Last error</th>}
            {!compact && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const op = describeOperation(r);
            const saleId = saleIdForOutboxRow(r);
            const sale = saleId ? saleDetails?.[saleId] : undefined;
            const isDead = r.status === "dead";
            return (
            <tr key={r.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{op.label}</div>
                {op.detail && (
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{op.detail}</div>
                )}
                {sale && (
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    <span className="tabular-nums" style={{ fontWeight: 700 }}>
                      {sale.receiptNo}
                      {sale.totalNgn != null ? ` · ${ngn(sale.totalNgn)}` : ""}
                    </span>
                    {sale.items && <div style={{ color: "var(--ink-soft)" }}>{sale.items}</div>}
                  </div>
                )}
              </td>
              <td>{statusPill(r.status)}</td>
              {!compact && <td className="table__num">{r.attempt_count}</td>}
              <td style={{ color: "var(--ink-soft)" }}>{age(r.created_at_local)}</td>
              {!compact && (
                <td style={{ fontSize: 13, color: "var(--danger)", maxWidth: 320 }}>
                  {isDead ? (
                    <>
                      <div style={{ fontWeight: 700 }}>{plainFailureReason(r.last_error, r.last_error_status)}</div>
                      {r.last_error && (
                        <div style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 400 }}>
                          System said: {r.last_error}
                        </div>
                      )}
                    </>
                  ) : (
                    r.last_error ?? ""
                  )}
                </td>
              )}
              {!compact && (
                <td className="table__num" style={{ display: "flex", gap: 6 }}>
                  {r.status !== "in_flight" && (
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={acting === r.id}
                      onClick={() => onRetry(r.id)}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    disabled={acting === r.id}
                    onClick={() => onDrop(r.id)}
                  >
                    Drop
                  </button>
                </td>
              )}
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
