import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createDbClient } from "@ms/db";
import type { DbClient } from "@ms/db";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { onError } from "./middleware/error.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { authRoutes } from "./auth/routes.js";
import { healthRoutes } from "./routes/health.js";
import { productRoutes } from "./routes/products.js";
import { branchRoutes } from "./routes/branches.js";
import { productionRunRoutes } from "./routes/production-runs.js";
import { stockRoutes } from "./routes/stock.js";
import { transferRoutes } from "./routes/transfers.js";
import { reviewRoutes } from "./routes/review.js";
import { factoryRoutes } from "./routes/factories.js";
import { saleRoutes } from "./routes/sales.js";
import { syncRoutes } from "./routes/sync.js";
import { publicCatalogRoutes } from "./routes/public-catalog.js";
import { publicOrderRoutes } from "./routes/public-orders.js";
import { payazaWebhookRoutes } from "./routes/webhooks-payaza.js";
import { returnRoutes } from "./routes/returns.js";
import { dailyCloseRoutes } from "./routes/daily-close.js";
import { reportRoutes } from "./routes/reports.js";
import { telemetryRoutes } from "./routes/telemetry.js";

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
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=15552000; includeSubDomains",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://api.payaza.africa"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );
  app.onError(onError);

  app.get("/", (c) => c.json({ service: "ms-api", ok: true }));

  // Idempotency applies to all /v1/* mutations.
  app.use("/v1/*", idempotencyMiddleware(db));

  app.route("/v1/auth", authRoutes(db));
  app.route("/v1/health", healthRoutes(db));
  app.route("/v1/products", productRoutes(db));
  app.route("/v1/branches", branchRoutes(db));
  app.route("/v1/production-runs", productionRunRoutes(db));
  app.route("/v1/stock", stockRoutes(db));
  app.route("/v1/transfers", transferRoutes(db));
  app.route("/v1/review", reviewRoutes(db));
  app.route("/v1/factories", factoryRoutes(db));
  // Nested branch routes: /v1/branches/:branchId/sales/...
  app.route("/v1/branches/:branchId/sales", saleRoutes(db));
  app.route("/v1/branches/:branchId/returns", returnRoutes(db));
  app.route("/v1/branches/:branchId/daily-close", dailyCloseRoutes(db));
  app.route("/v1/reports", reportRoutes(db));
  app.route("/v1/telemetry", telemetryRoutes(db));
  app.route("/v1/sync", syncRoutes(db));

  // Public (unauthenticated) routes — customer site + webhooks
  app.route("/v1/public/catalog", publicCatalogRoutes(db));
  app.route("/v1/public/orders", publicOrderRoutes(db));
  app.route("/v1/webhooks/payaza", payazaWebhookRoutes(db));

  // Temporary echo endpoint used by idempotency integration tests.
  // TODO: remove once a real mutation endpoint exists (Phase 1).
  app.post("/v1/echo", async (c) => c.json({ data: await c.req.json() }));

  return app;
}

export const app = buildApp();
