import { Worker } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker" } });
const url = process.env.REDIS_URL;
if (!url) throw new Error("REDIS_URL required");
const connection = new IORedis(url, { maxRetriesPerRequest: null });

new Worker(
  "ms-default",
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, "processing job");
  },
  { connection },
);

logger.info("worker started");
