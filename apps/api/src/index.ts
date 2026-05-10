import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { onError } from "./middleware/error.js";

const app = new Hono();
app.use("*", requestIdMiddleware());
app.onError(onError);

app.get("/", (c) => c.json({ service: "ms-api", ok: true }));

const port = env.PORT;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "api listening");
});
