import { Hono } from "hono";
import { createDbClient } from "@ms/db";
import type { DbClient } from "@ms/db";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { onError } from "./middleware/error.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { authRoutes } from "./auth/routes.js";
import { healthRoutes } from "./routes/health.js";

let cachedDb: DbClient | null = null;
function getDb(): DbClient {
  if (cachedDb) return cachedDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  cachedDb = createDbClient(url);
  return cachedDb;
}

export function buildApp(): Hono {
  const db = getDb();
  const app = new Hono();
  app.use("*", requestIdMiddleware());
  app.onError(onError);

  app.get("/", (c) => c.json({ service: "ms-api", ok: true }));

  // Idempotency applies to all /v1/* mutations.
  app.use("/v1/*", idempotencyMiddleware(db));

  app.route("/v1/auth", authRoutes(db));
  app.route("/v1/health", healthRoutes(db));

  // Temporary echo endpoint used by idempotency integration tests.
  // TODO: remove once a real mutation endpoint exists (Phase 1).
  app.post("/v1/echo", async (c) => c.json({ data: await c.req.json() }));

  return app;
}

export const app = buildApp();
