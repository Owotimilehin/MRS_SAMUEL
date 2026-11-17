import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuid } from "uuid";
import { env } from "../env.js";
import { BusinessError } from "./errors.js";

const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
const MAX_SIZE_BYTES = 8 * 1024 * 1024;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
    throw new BusinessError("service_unavailable", "R2 credentials not configured", 503);
  }
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export interface PresignPutArgs {
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Top-level R2 folder. Defaults to expense-receipts for legacy callers. */
  folder?: string;
}

export interface PresignPutResult {
  upload_url: string;
  object_key: string;
}

export async function presignPut(args: PresignPutArgs): Promise<PresignPutResult> {
  if (!ALLOWED_CONTENT_TYPES.includes(args.contentType as typeof ALLOWED_CONTENT_TYPES[number])) {
    throw new BusinessError("validation_failed", `unsupported content_type: ${args.contentType}`, 400);
  }
  if (args.sizeBytes <= 0 || args.sizeBytes > MAX_SIZE_BYTES) {
    throw new BusinessError("validation_failed", `size_bytes must be 1..${MAX_SIZE_BYTES}`, 400);
  }
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const ext = (args.filename.split(".").pop() ?? "bin").toLowerCase().slice(0, 6);
  const folder = (args.folder ?? "expense-receipts").replace(/[^a-z0-9-]/gi, "");
  const key = `${folder}/${yyyy}/${mm}/${uuid()}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET!,
    Key: key,
    ContentType: args.contentType,
    ContentLength: args.sizeBytes,
  });
  const url = await getSignedUrl(getClient(), cmd, { expiresIn: 300 });
  return { upload_url: url, object_key: key };
}

/** Sign a GET URL for an existing key. Returns null when R2 is not configured. */
export async function presignGet(objectKey: string | null | undefined): Promise<string | null> {
  if (!objectKey) return null;
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET) return null;
  const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET!, Key: objectKey });
  return getSignedUrl(getClient(), cmd, { expiresIn: 86_400 });
}

// ── Unified inbox: private files (WhatsApp media, call recordings) ───────────

/** What staff may attach to a WhatsApp reply, with Meta's own size limits. */
export const INBOX_UPLOAD_TYPES: Record<string, { kind: "image" | "document" | "audio" | "video"; maxBytes: number }> = {
  "image/jpeg": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "image/png": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "application/pdf": { kind: "document", maxBytes: 16 * 1024 * 1024 },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { kind: "document", maxBytes: 16 * 1024 * 1024 },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { kind: "document", maxBytes: 16 * 1024 * 1024 },
  "text/plain": { kind: "document", maxBytes: 16 * 1024 * 1024 },
  "audio/mpeg": { kind: "audio", maxBytes: 16 * 1024 * 1024 },
  "audio/ogg": { kind: "audio", maxBytes: 16 * 1024 * 1024 },
  "audio/aac": { kind: "audio", maxBytes: 16 * 1024 * 1024 },
  "video/mp4": { kind: "video", maxBytes: 16 * 1024 * 1024 },
};

/** Presigned PUT for an outgoing inbox attachment under inbox/outgoing/. */
export async function presignInboxPut(args: {
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<PresignPutResult & { kind: "image" | "document" | "audio" | "video" }> {
  const rule = INBOX_UPLOAD_TYPES[args.contentType];
  if (!rule) throw new BusinessError("validation_failed", `This file type can't be sent on WhatsApp: ${args.contentType}`, 400);
  if (args.sizeBytes <= 0 || args.sizeBytes > rule.maxBytes) {
    throw new BusinessError("validation_failed", `File is too large (max ${Math.round(rule.maxBytes / 1048576)} MB)`, 400);
  }
  const now = new Date();
  const ext = (args.filename.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "bin";
  const key = `inbox/outgoing/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${uuid()}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET!,
    Key: key,
    ContentType: args.contentType,
    ContentLength: args.sizeBytes,
  });
  const url = await getSignedUrl(getClient(), cmd, { expiresIn: 300 });
  return { upload_url: url, object_key: key, kind: rule.kind };
}

/**
 * Short-lived signed GET (default 10 minutes) for private inbox files. Only
 * call after a permission check. `downloadName` forces a download.
 */
export async function presignInboxGet(
  objectKey: string,
  opts: { expiresIn?: number; downloadName?: string } = {},
): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: env.R2_BUCKET!,
    Key: objectKey,
    ...(opts.downloadName
      ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName.replace(/["\\\r\n]/g, "")}"` }
      : {}),
  });
  return getSignedUrl(getClient(), cmd, { expiresIn: opts.expiresIn ?? 600 });
}
