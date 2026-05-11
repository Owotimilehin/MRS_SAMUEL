import { Hono } from "hono";
import { factory, type DbClient } from "@ms/db";
import { requireAuth } from "../middleware/auth.js";

/**
 * Owner + factory dispatchers list their factories. Branch users see them too
 * because phase-1 transfers need the factory id at create time; we'll narrow
 * this later if it becomes a privacy concern.
 */
export function factoryRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.get("/", async (c) => {
    const rows = await db.select().from(factory);
    return c.json({ data: rows });
  });
  return r;
}
