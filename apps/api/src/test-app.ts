import { Hono } from "hono";
import { createDbClient } from "@ms/db";
import type { DbClient } from "@ms/db";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { onError } from "./middleware/error.js";
import { authRoutes } from "./auth/routes.js";

let cachedDb: DbClient | null = null;
function getDb(): DbClient {
  if (cachedDb) return cachedDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  cachedDb = createDbClient(url);
  return cachedDb;
}

export function buildApp(): Hono {
  const app = new Hono();
  app.use("*", requestIdMiddleware());
  app.onError(onError);

  app.get("/", (c) => c.json({ service: "ms-api", ok: true }));
  app.route("/v1/auth", authRoutes(getDb()));

  return app;
}

export const app = buildApp();
