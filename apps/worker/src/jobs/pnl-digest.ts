import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { sendMessage, channels } from "../notifiers/telegram.js";

const CATEGORY_LABEL: Record<string, string> = {
  raw_materials: "Raw materials",
  packaging: "Packaging",
  utilities: "Utilities",
  transport: "Transport",
  salaries: "Salaries",
  rent: "Rent",
  marketing: "Marketing",
  equipment: "Equipment",
  regulatory: "Regulatory",
  other_with_note: "Other",
};

const ADMIN_URL = process.env.PUBLIC_ADMIN_URL ?? "https://admin.mrssamueljuice.com";

/** Telegram digest fires on day 1 once the Lagos hour is >= 9. */
export function shouldFirePnlDigestNow(
  lagos: { day: number; hour: number },
): boolean {
  return lagos.day === 1 && lagos.hour >= 9;
}

function fmt(n: number): string {
  return "₦" + new Intl.NumberFormat("en-NG").format(n);
}

export async function fireMonthlyPnlDigest(db: DbClient, month: string): Promise<void> {
  const from = `${month}-01`;
  const [yy, mm] = month.split("-").map((s) => Number(s));
  const nextMonth = mm === 12 ? `${yy! + 1}-01-01` : `${yy}-${String(mm! + 1).padStart(2, "0")}-01`;

  const revRow = await db.execute<{ revenue_ngn: number; refunds_ngn: number }>(sql`
    WITH sales AS (
      SELECT total_ngn FROM sale_order
      WHERE status IN ('paid','handed_over','delivered')
        AND created_at_local::date >= ${from}::date
        AND created_at_local::date <  ${nextMonth}::date
    ),
    refunds AS (
      SELECT refund_amount_ngn FROM sale_return
      WHERE status = 'completed'
        AND created_at::date >= ${from}::date
        AND created_at::date <  ${nextMonth}::date
    )
    SELECT
      COALESCE((SELECT SUM(total_ngn) FROM sales), 0)::int AS revenue_ngn,
      COALESCE((SELECT SUM(refund_amount_ngn) FROM refunds), 0)::int AS refunds_ngn
  `);
  const rev = revRow[0] ?? { revenue_ngn: 0, refunds_ngn: 0 };

  const expRows = await db.execute<{ category_code: string; amount_ngn: number }>(sql`
    SELECT category_code, COALESCE(SUM(amount_ngn), 0)::int AS amount_ngn
    FROM business_expense
    WHERE deleted_at IS NULL
      AND expense_date >= ${from}::date
      AND expense_date <  ${nextMonth}::date
    GROUP BY category_code
    ORDER BY amount_ngn DESC
  `);

  const revenue = Number(rev.revenue_ngn);
  const refunds = Number(rev.refunds_ngn);
  const netRev = revenue - refunds;
  const totalExp = expRows.reduce((s, r) => s + Number(r.amount_ngn), 0);
  const net = netRev - totalExp;
  const top = expRows
    .slice(0, 3)
    .map((r) => {
      const k = Math.round(Number(r.amount_ngn) / 1000);
      return `${CATEGORY_LABEL[r.category_code] ?? r.category_code} ₦${k}K`;
    })
    .join(", ");
  const sign = net >= 0 ? "✅" : "⚠️";

  const text =
    `📊 *Monthly P&L · ${month}*\n` +
    `Revenue:   ${fmt(netRev)}\n` +
    `Expenses:  ${fmt(totalExp)}\n` +
    `Net:       *${fmt(net)}* (${sign})\n` +
    (top ? `Top: ${top}\n` : "") +
    `👉 ${ADMIN_URL}/owner/bookkeeping`;

  const owner = channels.owner();
  if (owner) await sendMessage(owner, text);
}
