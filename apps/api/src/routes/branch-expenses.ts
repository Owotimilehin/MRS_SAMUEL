import { Hono } from "hono";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { adminUser, branch, businessExpense, type DbClient } from "@ms/db";
import {
  BRANCH_EXPENSE_CATEGORIES,
  BRANCH_EXPENSE_DESCRIPTION_MAX,
  BRANCH_EXPENSE_DESCRIPTION_MIN,
  BRANCH_EXPENSE_MAX_NGN,
  branchExpenseDateProblem,
  lagosDate,
  mondayOf,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

/**
 * Branch spending, logged from the till: /v1/branches/:branchId/expenses.
 * Rows land in business_expense with branch_id set, so they show in the
 * owner's Bookkeeping and in every report that sums business_expense.
 * Idempotency comes from the app-wide /v1/* middleware (Idempotency-Key header).
 */
const CreateBody = z.object({
  amount_ngn: z.number().int().positive().max(BRANCH_EXPENSE_MAX_NGN),
  category_code: z.enum(BRANCH_EXPENSE_CATEGORIES),
  description: z
    .string()
    .trim()
    .min(BRANCH_EXPENSE_DESCRIPTION_MIN)
    .max(BRANCH_EXPENSE_DESCRIPTION_MAX),
  expense_date: z.string().optional(),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function branchExpenseRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  async function assertBranch(branchId: string): Promise<void> {
    if (!z.string().uuid().safeParse(branchId).success) {
      throw new BusinessError("not_found", "branch not found", 404);
    }
    const [b] = await db.select({ id: branch.id }).from(branch).where(eq(branch.id, branchId));
    if (!b) throw new BusinessError("not_found", "branch not found", 404);
  }

  r.get("/", requireCapability("expenses.branch_write"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    await assertBranch(branchId);
    const today = lagosDate();
    const from = c.req.query("from") ?? mondayOf(today);
    const to = c.req.query("to") ?? today;
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
      throw new BusinessError("validation_failed", "from/to must be YYYY-MM-DD with from <= to", 400);
    }

    const rows = await db
      .select({
        id: businessExpense.id,
        expense_date: businessExpense.expenseDate,
        category_code: businessExpense.categoryCode,
        amount_ngn: businessExpense.amountNgn,
        description: businessExpense.description,
        created_at: businessExpense.createdAt,
        recorded_by_name: sql<string | null>`COALESCE(${adminUser.name}, ${adminUser.email})`,
      })
      .from(businessExpense)
      .leftJoin(adminUser, eq(adminUser.id, businessExpense.recordedByUserId))
      .where(
        and(
          eq(businessExpense.branchId, branchId),
          isNull(businessExpense.deletedAt),
          gte(businessExpense.expenseDate, from),
          lte(businessExpense.expenseDate, to),
        ),
      )
      .orderBy(sql`${businessExpense.expenseDate} DESC, ${businessExpense.createdAt} DESC`)
      .limit(500);

    const data = rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
    const total = data.reduce((s, row) => s + row.amount_ngn, 0);
    return c.json({ data, total_ngn: total, from, to });
  });

  r.post("/", requireCapability("expenses.branch_write"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = CreateBody.parse(await c.req.json());
    await assertBranch(branchId);

    const expenseDate = body.expense_date ?? lagosDate();
    const problem = branchExpenseDateProblem(expenseDate);
    if (problem) throw new BusinessError("validation_failed", problem, 400);

    const auth = c.get("auth");
    const description = body.description.trim();
    const [row] = await db
      .insert(businessExpense)
      .values({
        expenseDate,
        categoryCode: body.category_code,
        amountNgn: body.amount_ngn,
        description,
        // Bookkeeping requires a note on "Other"; the till's "what was it for"
        // is that note, so an owner edit later doesn't trip the rule.
        reasonNote: body.category_code === "other_with_note" ? description : null,
        branchId,
        recordedByUserId: auth.userId,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);

    await writeAudit(db, c, {
      action: "business_expense.branch_create",
      entityType: "business_expense",
      entityId: row.id,
      after: {
        branch_id: branchId,
        category_code: row.categoryCode,
        amount_ngn: row.amountNgn,
        expense_date: row.expenseDate,
        description,
      },
    });

    return c.json(
      {
        data: {
          id: row.id,
          expense_date: row.expenseDate,
          category_code: row.categoryCode,
          amount_ngn: row.amountNgn,
          description: row.description,
          branch_id: row.branchId,
          created_at: row.createdAt.toISOString(),
        },
      },
      201,
    );
  });

  return r;
}
