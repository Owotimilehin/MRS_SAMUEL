import { sql } from "drizzle-orm";
import { createHash, createHmac } from "node:crypto";
import type { DbClient } from "@ms/db";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "audit-export" } });

/**
 * Sign a Cloudflare R2 PUT request with AWS Signature V4. We do this by
 * hand to avoid pulling in the full @aws-sdk/client-s3 — R2's S3 surface is
 * small enough that the inline signer is cheaper than the dependency.
 */
function signR2Put(opts: {
  accountId: string;
  bucket: string;
  key: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
}): { url: string; headers: Record<string, string> } {
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const path = `/${opts.bucket}/${opts.key}`;
  const url = `https://${host}${path}`;
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(opts.body).digest("hex");
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  const signedHeadersList = Object.keys(headers).sort();
  const signedHeaders = signedHeadersList.join(";");
  const canonicalHeaders =
    signedHeadersList.map((h) => `${h}:${headers[h]}\n`).join("");
  const canonical = [
    "PUT",
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const region = "auto";
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const kDate = createHmac("sha256", `AWS4${opts.secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url,
    headers: { ...headers, authorization, "content-type": "application/x-ndjson" },
  };
}

/**
 * Dump yesterday's audit_log rows as JSONL to R2. No-ops with a log line
 * when R2 env vars are not configured (so the job is safe in dev/test).
 */
export async function exportAuditLog(db: DbClient): Promise<{ skipped: boolean; bytes?: number; key?: string }> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    logger.warn("R2 env vars not set — skipping audit export");
    return { skipped: true };
  }

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM audit_log
    WHERE occurred_at >= ${yesterday}::date
      AND occurred_at <  (${yesterday}::date + INTERVAL '1 day')
    ORDER BY occurred_at
  `);
  if (rows.length === 0) {
    logger.info({ date: yesterday }, "no audit rows to export");
    return { skipped: true };
  }
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const key = `audit/${yesterday}.jsonl`;
  const { url, headers } = signR2Put({
    accountId,
    bucket,
    key,
    body,
    accessKeyId,
    secretAccessKey,
  });
  const res = await fetch(url, { method: "PUT", headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 PUT ${key} failed ${res.status}: ${text}`);
  }
  logger.info({ key, bytes: body.length, rows: rows.length }, "audit log exported");
  return { skipped: false, bytes: body.length, key };
}

/**
 * Whether the current Africa/Lagos local time has just crossed 02:30 and
 * the job hasn't yet run today. Caller tracks `lastRunDate`.
 */
export function isAuditExportWindow(lastRunDate: string | null): boolean {
  const lagosMs = Date.now() + 60 * 60 * 1000; // UTC+1
  const lagos = new Date(lagosMs);
  const today = lagos.toISOString().slice(0, 10);
  const h = lagos.getUTCHours();
  const m = lagos.getUTCMinutes();
  if (lastRunDate === today) return false;
  // Window: 02:30–03:30 Lagos
  return (h === 2 && m >= 30) || (h === 3 && m < 30);
}
