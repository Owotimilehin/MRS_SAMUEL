/**
 * Private storage for call recordings. The worker has no @aws-sdk dependency,
 * so the R2 implementation signs S3 requests (AWS Signature V4) by hand, the
 * same way audit-export.ts does. Objects are never public: the API hands out
 * short-lived signed GET URLs (apps/api/src/lib/r2.ts presignGet).
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
import { createHash, createHmac } from "node:crypto";

export interface RecordingStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function encodeKey(key: string): string {
  return key.split("/").map((s) => encodeURIComponent(s)).join("/");
}

/** Exported for tests. */
export function signR2Request(
  cfg: R2Config,
  method: "GET" | "PUT",
  key: string,
  body: Buffer | null,
  extraHeaders: Record<string, string> = {},
  now: Date = new Date(),
): { url: string; headers: Record<string, string> } {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const path = `/${encodeURIComponent(cfg.bucket)}/${encodeKey(key)}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? "");
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonical = [method, path, "", names.map((h) => `${h}:${headers[h]!.trim()}\n`).join(""), signedHeaders, payloadHash].join(
    "\n",
  );
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const kDate = createHmac("sha256", `AWS4${cfg.secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update("auto").digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  // fetch sets Host itself; it is signed but must not be sent manually.
  const sendHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "host"));
  return {
    url: `https://${host}${path}`,
    headers: {
      ...sendHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export class R2RecordingStore implements RecordingStore {
  constructor(private readonly cfg: R2Config) {}

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const { url, headers } = signR2Request(this.cfg, "PUT", key, bytes, { "content-type": contentType });
    const res = await fetch(url, { method: "PUT", headers, body: bytes, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`R2 PUT ${key} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  async get(key: string): Promise<Buffer> {
    const { url, headers } = signR2Request(this.cfg, "GET", key, null);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`R2 GET ${key} failed ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** null when R2 isn't configured (dev/test): recordings then stay pending. */
export function recordingStoreFromEnv(env: NodeJS.ProcessEnv = process.env): RecordingStore | null {
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return new R2RecordingStore({ accountId, bucket, accessKeyId, secretAccessKey });
}
