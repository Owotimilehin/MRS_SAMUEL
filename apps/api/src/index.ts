import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "./env";
import { logger } from "./logger";

const app = new Hono();

app.get("/", (c) => c.json({ service: "ms-api", ok: true }));

const port = env.PORT;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "api listening");
});
