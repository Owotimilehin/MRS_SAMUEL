import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";

export function healthRoutes(db: DbClient) {
  const r = new Hono();
  r.get("/", async (c) => {
    try {
      await db.execute(sql`SELECT 1`);
      return c.json({ status: "ok", checks: { db: "ok" } });
    } catch {
      return c.json({ status: "degraded", checks: { db: "fail" } }, 503);
    }
  });
  return r;
}
