import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { sendMessage, channels } from "../notifiers/telegram.js";

const ADMIN_URL = process.env.PUBLIC_ADMIN_URL ?? "https://admin.mrssamuel.com";

function fmt(n: number): string {
  return "₦" + new Intl.NumberFormat("en-NG").format(n);
}

export interface VarianceLossSummary {
  bottles: number;
  valueNgn: number;
  bySource: Record<string, { bottles: number; valueNgn: number }>;
  top: Array<{ label: string; valueNgn: number }>;
}

/** Pure formatter — kept separate so it is unit-testable without a DB. */
export function formatVarianceLossDigest(month: string, s: VarianceLossSummary): string {
  if (s.bottles === 0) {
    return `📦 *Monthly stock losses · ${month}*\nNo stock losses recorded. ✅`;
  }
  const transfer = s.bySource["transfer"] ?? { bottles: 0, valueNgn: 0 };
  const shift = s.bySource["shift_close"] ?? { bottles: 0, valueNgn: 0 };
  const top = s.top.map((t) => `${t.label} ${fmt(t.valueNgn)}`).join(", ");
  return (
    `📦 *Monthly stock losses · ${month}*\n` +
    `Lost:  *${fmt(s.valueNgn)}*  (${s.bottles} bottles)\n` +
    `Transfers:   ${fmt(transfer.valueNgn)} (${transfer.bottles})\n` +
    `Shift close: ${fmt(shift.valueNgn)} (${shift.bottles})\n` +
    (top ? `Top: ${top}\n` : "") +
    `👉 ${ADMIN_URL}/owner/variance`
  );
}

export async function fireMonthlyVarianceLossDigest(db: DbClient, month: string): Promise<void> {
  const from = `${month}-01`;
  const [yy, mm] = month.split("-").map((s) => Number(s));
  const nextMonth = mm === 12 ? `${yy! + 1}-01-01` : `${yy}-${String(mm! + 1).padStart(2, "0")}-01`;

  const rows = await db.execute<{ name: string; size_ml: number | null; source: string; bottles: number; value_ngn: number }>(sql`
    SELECT p.name, vl.size_ml, vl.source,
           SUM(vl.quantity)::int AS bottles, SUM(vl.value_ngn)::int AS value_ngn
    FROM variance_loss vl
    JOIN product p ON p.id = vl.product_id
    WHERE vl.occurred_at >= ${from}::date AND vl.occurred_at < ${nextMonth}::date
    GROUP BY p.name, vl.size_ml, vl.source
    ORDER BY value_ngn DESC
  `);

  const bySource: Record<string, { bottles: number; valueNgn: number }> = {};
  let bottles = 0;
  let valueNgn = 0;
  for (const r of rows) {
    const b = Number(r.bottles);
    const v = Number(r.value_ngn);
    bottles += b;
    valueNgn += v;
    const acc = (bySource[r.source] ??= { bottles: 0, valueNgn: 0 });
    acc.bottles += b;
    acc.valueNgn += v;
  }
  const top = rows.slice(0, 3).map((r) => ({
    label: `${r.name}${r.size_ml ? ` ${r.size_ml}ml` : ""}`,
    valueNgn: Number(r.value_ngn),
  }));

  const text = formatVarianceLossDigest(month, { bottles, valueNgn, bySource, top });
  const owner = channels.owner();
  if (owner) await sendMessage(owner, text);
}
