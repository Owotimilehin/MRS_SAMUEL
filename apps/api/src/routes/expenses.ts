import { Hono } from "hono";
import { eq, and, gte, lte, isNull, ilike, or, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { businessExpense, vendor, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { presignGet, presignPut } from "../lib/r2.js";
import { toCsv } from "../lib/csv.js";

const CATEGORY = z.enum([
  "raw_materials","packaging","utilities","transport","salaries",
  "rent","marketing","equipment","regulatory","other_with_note",
]);

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

const CreateBody = z
  .object({
    expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    category_code: CATEGORY,
    amount_ngn: z.number().int().positive(),
    vendor_id: z.string().uuid().nullable().optional(),
    vendor_name: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    reason_note: z.string().max(500).optional(),
    receipt_url: z.string().max(500).optional(),
  })
  .refine(
    (v) => v.category_code !== "other_with_note" || (v.reason_note?.trim().length ?? 0) > 0,
    { message: "reason_note required when category_code is other_with_note" },
  );

const PatchBody = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category_code: CATEGORY.optional(),
  amount_ngn: z.number().int().positive().optional(),
  vendor_id: z.string().uuid().nullable().optional(),
  vendor_name: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  reason_note: z.string().max(500).nullable().optional(),
  receipt_url: z.string().max(500).nullable().optional(),
});

const PresignBody = z.object({
  filename: z.string().min(1).max(200),
  content_type: z.string().min(1).max(100),
  size_bytes: z.number().int().positive(),
});

interface RowOut {
  id: string;
  expense_date: string;
  category_code: string;
  amount_ngn: number;
  vendor_id: string | null;
  vendor_name: string | null;
  description: string | null;
  reason_note: string | null;
  receipt_url: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function shape(
  row: typeof businessExpense.$inferSelect,
  resolvedVendorName?: string | null,
): Promise<RowOut> {
  return {
    id: row.id,
    expense_date: row.expenseDate,
    category_code: row.categoryCode,
    amount_ngn: row.amountNgn,
    vendor_id: row.vendorId,
    // Prefer the joined vendor.name when we have a vendor_id; fall back to
    // the legacy free-text vendor_name column.
    vendor_name: row.vendorId ? (resolvedVendorName ?? null) : row.vendorName,
    description: row.description,
    reason_note: row.reasonNote,
    receipt_url: await presignGet(row.receiptUrl),
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function expenseRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", requireCapability("expenses.view"), async (c) => {
    const url = new URL(c.req.url);
    const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
    const categories = url.searchParams.getAll("category").filter(Boolean);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const format = url.searchParams.get("format");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("page_size") ?? 50)));

    const conds: SQL[] = [
      isNull(businessExpense.deletedAt),
      gte(businessExpense.expenseDate, from),
      lte(businessExpense.expenseDate, to),
    ];
    if (categories.length > 0) {
      const valid = categories.filter(
        (x): x is z.infer<typeof CATEGORY> => CATEGORY.options.includes(x as never),
      );
      if (valid.length > 0) {
        conds.push(inArray(businessExpense.categoryCode, valid));
      }
    }
    if (q.length > 0) {
      const like = `%${q}%`;
      const orCond = or(
        ilike(businessExpense.vendorName, like),
        ilike(businessExpense.description, like),
        ilike(vendor.name, like),
      );
      if (orCond) conds.push(orCond);
    }

    const where = and(...conds);

    // CSV: no pagination, fetch all matching rows.
    if (format === "csv") {
      const rows = await db
        .select({
          expense: businessExpense,
          vendor_name: vendor.name,
        })
        .from(businessExpense)
        .leftJoin(vendor, eq(vendor.id, businessExpense.vendorId))
        .where(where)
        .orderBy(sql`${businessExpense.expenseDate} ASC, ${businessExpense.createdAt} ASC`);
      const header = ["Date", "Category", "Vendor", "Description", "Amount (NGN)", "Notes"];
      const data = rows.map((r) => {
        const e = r.expense;
        const vname = e.vendorId ? r.vendor_name : e.vendorName;
        return [
          e.expenseDate,
          CATEGORY_LABEL[e.categoryCode] ?? e.categoryCode,
          vname ?? "",
          e.description ?? "",
          e.amountNgn,
          e.reasonNote ?? "",
        ];
      });
      const filename = `expenses-${from}_${to}.csv`;
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${filename}"`);
      return c.body(toCsv(header, data));
    }

    const totalRow = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(businessExpense)
      .leftJoin(vendor, eq(vendor.id, businessExpense.vendorId))
      .where(where);
    const total = Number(totalRow[0]?.total ?? 0);

    const rows = await db
      .select({ expense: businessExpense, vendor_name: vendor.name })
      .from(businessExpense)
      .leftJoin(vendor, eq(vendor.id, businessExpense.vendorId))
      .where(where)
      .orderBy(sql`${businessExpense.expenseDate} DESC, ${businessExpense.createdAt} DESC`)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const data = await Promise.all(rows.map((r) => shape(r.expense, r.vendor_name)));
    return c.json({ data, pagination: { page, page_size: pageSize, total } });
  });

  r.get("/:id", requireCapability("expenses.view"), async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select({ expense: businessExpense, vendor_name: vendor.name })
      .from(businessExpense)
      .leftJoin(vendor, eq(vendor.id, businessExpense.vendorId))
      .where(eq(businessExpense.id, id));
    if (!row) throw new BusinessError("not_found", "expense not found", 404);
    return c.json({ data: await shape(row.expense, row.vendor_name) });
  });

  r.post("/", requireCapability("expenses.write"), async (c) => {
    const body = CreateBody.parse(await c.req.json());
    const auth = c.get("auth");
    const [row] = await db
      .insert(businessExpense)
      .values({
        expenseDate: body.expense_date,
        categoryCode: body.category_code,
        amountNgn: body.amount_ngn,
        vendorId: body.vendor_id ?? null,
        // Only persist free-text vendor_name when no vendor_id is provided.
        vendorName: body.vendor_id ? null : (body.vendor_name?.trim() || null),
        description: body.description?.trim() || null,
        reasonNote: body.reason_note?.trim() || null,
        receiptUrl: body.receipt_url?.trim() || null,
        recordedByUserId: auth.userId,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);
    let resolvedName: string | null = null;
    if (row.vendorId) {
      const [v] = await db.select({ name: vendor.name }).from(vendor).where(eq(vendor.id, row.vendorId));
      resolvedName = v?.name ?? null;
    }
    await writeAudit(db, c, {
      action: "business_expense.create",
      entityType: "business_expense",
      entityId: row.id,
      after: { category_code: row.categoryCode, amount_ngn: row.amountNgn },
    });
    return c.json({ data: await shape(row, resolvedName) }, 201);
  });

  r.patch("/:id", requireCapability("expenses.write"), async (c) => {
    const id = c.req.param("id");
    const body = PatchBody.parse(await c.req.json());

    const [current] = await db.select().from(businessExpense).where(eq(businessExpense.id, id));
    if (!current) throw new BusinessError("not_found", "expense not found", 404);
    const finalCategory = body.category_code ?? current.categoryCode;
    const finalNote = body.reason_note === undefined ? current.reasonNote : body.reason_note;
    if (finalCategory === "other_with_note" && (finalNote?.trim().length ?? 0) === 0) {
      throw new BusinessError("validation_failed", "reason_note required when category is other_with_note", 400);
    }

    const patch: Partial<typeof businessExpense.$inferInsert> = { updatedAt: new Date() };
    if (body.expense_date !== undefined) patch.expenseDate = body.expense_date;
    if (body.category_code !== undefined) patch.categoryCode = body.category_code;
    if (body.amount_ngn !== undefined) patch.amountNgn = body.amount_ngn;
    if (body.vendor_id !== undefined) {
      patch.vendorId = body.vendor_id;
      // Switching to a vendor record clears the legacy free-text fallback.
      if (body.vendor_id) patch.vendorName = null;
    }
    if (body.vendor_name !== undefined && !body.vendor_id) {
      patch.vendorName = body.vendor_name?.trim() || null;
    }
    if (body.description !== undefined) patch.description = body.description?.trim() || null;
    if (body.reason_note !== undefined) patch.reasonNote = body.reason_note?.trim() || null;
    if (body.receipt_url !== undefined) patch.receiptUrl = body.receipt_url?.trim() || null;

    const [row] = await db
      .update(businessExpense)
      .set(patch)
      .where(eq(businessExpense.id, id))
      .returning();
    if (!row) throw new BusinessError("not_found", "expense not found", 404);
    let resolvedName: string | null = null;
    if (row.vendorId) {
      const [v] = await db.select({ name: vendor.name }).from(vendor).where(eq(vendor.id, row.vendorId));
      resolvedName = v?.name ?? null;
    }
    await writeAudit(db, c, {
      action: "business_expense.update",
      entityType: "business_expense",
      entityId: id,
      after: patch,
    });
    return c.json({ data: await shape(row, resolvedName) });
  });

  r.delete("/:id", requireCapability("expenses.write"), async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .update(businessExpense)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(businessExpense.id, id), isNull(businessExpense.deletedAt)))
      .returning();
    if (!row) {
      const [existed] = await db.select().from(businessExpense).where(eq(businessExpense.id, id));
      if (!existed) throw new BusinessError("not_found", "expense not found", 404);
    }
    await writeAudit(db, c, {
      action: "business_expense.delete",
      entityType: "business_expense",
      entityId: id,
    });
    return c.json({ data: { id, deleted: true } });
  });

  r.post("/presign-upload", requireCapability("expenses.write"), async (c) => {
    const body = PresignBody.parse(await c.req.json());
    const out = await presignPut({
      filename: body.filename,
      contentType: body.content_type,
      sizeBytes: body.size_bytes,
    });
    return c.json({ data: out });
  });

  return r;
}
