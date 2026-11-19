import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuid } from "uuid";
import { env } from "../env.js";
import { BusinessError } from "./errors.js";
import { UPLOAD_RULES } from "@ms/shared";

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
/** WhatsApp's upload list, now kept in @ms/shared (UPLOAD_RULES.whatsapp) so the composer uses the same rules. */
export const INBOX_UPLOAD_TYPES = UPLOAD_RULES.whatsapp;

const UPLOAD_CHANNEL_NAMES = { messenger: "Messenger", instagram: "Instagram" } as const;

/**
 * Presigned PUT for an outgoing inbox attachment under inbox/outgoing/.
 * `channel` picks the rules (spec 02, 5.6); WhatsApp (the default) keeps its wording.
 */
export async function presignInboxPut(args: {
  filename: string;
  contentType: string;
  sizeBytes: number;
  channel?: "whatsapp" | "messenger" | "instagram";
}): Promise<PresignPutResult & { kind: "image" | "document" | "audio" | "video" }> {
  const channel = args.channel ?? "whatsapp";
  const rule = UPLOAD_RULES[channel][args.contentType];
  if (channel === "whatsapp") {
    if (!rule) throw new BusinessError("validation_failed", `This file type can't be sent on WhatsApp: ${args.contentType}`, 400);
    if (args.sizeBytes <= 0 || args.sizeBytes > rule.maxBytes) {
      throw new BusinessError("validation_failed", `File is too large (max ${Math.round(rule.maxBytes / 1048576)} MB)`, 400);
    }
  } else {
    const name = UPLOAD_CHANNEL_NAMES[channel];
    if (!rule) throw new BusinessError("validation_failed", `This kind of file can't be sent on ${name}: ${args.contentType}`, 400);
    if (args.sizeBytes <= 0 || args.sizeBytes > rule.maxBytes) {
      throw new BusinessError("validation_failed", `This file is too large for ${name} (limit ${Math.round(rule.maxBytes / 1048576)} MB)`, 400);
    }
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

/** Permanently delete private inbox files. No-op when storage isn't configured. */
export async function deleteInboxObjects(keys: readonly (string | null | undefined)[]): Promise<number> {
  const real = [...new Set(keys.filter((k): k is string => !!k && k.startsWith("inbox/")))];
  if (real.length === 0 || !env.R2_ACCOUNT_ID || !env.R2_BUCKET) return 0;
  for (let i = 0; i < real.length; i += 1000) {
    await getClient().send(
      new DeleteObjectsCommand({
        Bucket: env.R2_BUCKET!,
        Delete: { Objects: real.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
  return real.length;
}

const GREETING_TYPES: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" };

/** Presigned PUT for a phone greeting recording (MP3/WAV, max 5 MB) under inbox/greetings/. */
export async function presignGreetingPut(args: { contentType: string; sizeBytes: number }): Promise<PresignPutResult> {
  const ext = GREETING_TYPES[args.contentType];
  if (!ext) throw new BusinessError("validation_failed", "Upload an MP3 or WAV file", 400);
  if (args.sizeBytes <= 0 || args.sizeBytes > 5 * 1024 * 1024) {
    throw new BusinessError("validation_failed", "Recording is too large (max 5 MB)", 400);
  }
  const key = `inbox/greetings/${uuid()}.${ext}`;
  const cmd = new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, ContentType: args.contentType, ContentLength: args.sizeBytes });
  return { upload_url: await getSignedUrl(getClient(), cmd, { expiresIn: 300 }), object_key: key };
}

/**
 * Presigned PUT for a template heading sample (suite spec 06, 5.4) under inbox/template-samples/.
 * Picture: JPG or PNG up to 5 MB. Video (MP4) and PDF: up to 16 MB. The route checks the first bytes
 * again at submit time.
 */
export const TEMPLATE_SAMPLE_PREFIX = "inbox/template-samples/";
const TEMPLATE_SAMPLE_TYPES: Record<string, { ext: string; maxBytes: number }> = {
  "image/jpeg": { ext: "jpg", maxBytes: 5 * 1024 * 1024 },
  "image/png": { ext: "png", maxBytes: 5 * 1024 * 1024 },
  "video/mp4": { ext: "mp4", maxBytes: 16 * 1024 * 1024 },
  "application/pdf": { ext: "pdf", maxBytes: 16 * 1024 * 1024 },
};

export async function presignTemplateSamplePut(args: {
  contentType: string;
  sizeBytes: number;
}): Promise<PresignPutResult> {
  const rule = TEMPLATE_SAMPLE_TYPES[args.contentType];
  if (!rule) throw new BusinessError("validation_failed", "Use a JPG or PNG picture, an MP4 video or a PDF.", 400);
  if (args.sizeBytes <= 0 || args.sizeBytes > rule.maxBytes) {
    throw new BusinessError(
      "validation_failed",
      `That file is too big. Pictures can be up to 5 MB. Videos and PDFs can be up to 16 MB.`,
      400,
    );
  }
  const now = new Date();
  const key = `${TEMPLATE_SAMPLE_PREFIX}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${uuid()}.${rule.ext}`;
  const cmd = new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, ContentType: args.contentType, ContentLength: args.sizeBytes });
  return { upload_url: await getSignedUrl(getClient(), cmd, { expiresIn: 300 }), object_key: key };
}

// ── Posts to Facebook and Instagram (suite spec 09) ──────────────────────────

/** What may be attached to a post. Pictures are always JPEG: the browser converts them before upload. */
export const SOCIAL_UPLOAD_TYPES: Record<string, { kind: "image" | "video"; maxBytes: number; ext: string }> = {
  "image/jpeg": { kind: "image", maxBytes: 8 * 1024 * 1024, ext: "jpg" },
  "video/mp4": { kind: "video", maxBytes: 100 * 1024 * 1024, ext: "mp4" },
  "video/quicktime": { kind: "video", maxBytes: 100 * 1024 * 1024, ext: "mov" },
};

/** Presigned PUT under social/posts/YYYY/MM/<uuid>.<ext>, valid 15 minutes. */
export async function presignSocialPut(args: {
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<PresignPutResult & { kind: "image" | "video" }> {
  const rule = SOCIAL_UPLOAD_TYPES[args.contentType];
  if (!rule) {
    throw new BusinessError("validation_failed", "This file type can't be used in a post. Use a JPEG picture or an MP4 or MOV video.", 400);
  }
  if (args.sizeBytes <= 0 || args.sizeBytes > rule.maxBytes) {
    throw new BusinessError("validation_failed", `File is too large (max ${Math.round(rule.maxBytes / 1048576)} MB)`, 400);
  }
  const now = new Date();
  // The extension comes from the file type, not the file name, so the key always fits SOCIAL_MEDIA_KEY_RE.
  const key = `social/posts/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${uuid()}.${rule.ext}`;
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET!,
    Key: key,
    ContentType: args.contentType,
    ContentLength: args.sizeBytes,
  });
  const url = await getSignedUrl(getClient(), cmd, { expiresIn: 900 });
  return { upload_url: url, object_key: key, kind: rule.kind };
}

/** A 10-minute signed GET for a post's picture or video, for the staff preview. Null when storage is not set up. */
export async function presignSocialPreview(objectKey: string): Promise<string | null> {
  if (!objectKey.startsWith("social/posts/")) return null;
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) return null;
  return presignInboxGet(objectKey, { expiresIn: 600 });
}

// ── Advert pictures (suite spec 12, Phase B) ────────────────────────────────

const AD_IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };
const AD_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** A 15-minute signed PUT for an advert's picture: JPEG or PNG, at most 8 MB, under ads/images/. */
export async function presignAdImagePut(args: { contentType: string; sizeBytes: number }): Promise<PresignPutResult> {
  const ext = AD_IMAGE_TYPES[args.contentType];
  if (!ext) throw new BusinessError("validation_failed", "The picture must be a JPEG or a PNG.", 400);
  if (!Number.isInteger(args.sizeBytes) || args.sizeBytes <= 0 || args.sizeBytes > AD_IMAGE_MAX_BYTES) {
    throw new BusinessError("validation_failed", "The picture is too large (limit 8 MB).", 400);
  }
  const now = new Date();
  const key = `ads/images/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${uuid()}.${ext}`;
  const cmd = new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, ContentType: args.contentType, ContentLength: args.sizeBytes });
  const url = await getSignedUrl(getClient(), cmd, { expiresIn: 900 });
  return { upload_url: url, object_key: key };
}

/** The bytes of an advert picture from our own storage. Only keys under ads/images/ are read. */
export async function getAdImageBytes(key: string): Promise<Uint8Array> {
  if (!/^ads\/images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|jpeg|png)$/.test(key)) {
    throw new BusinessError("validation_failed", "That is not an advert picture.", 400);
  }
  const res = await getClient().send(new GetObjectCommand({ Bucket: env.R2_BUCKET!, Key: key }));
  if (!res.Body) throw new BusinessError("not_found", "The advert's picture was not found. Upload it again.", 404);
  const bytes = await res.Body.transformToByteArray();
  if (bytes.length === 0 || bytes.length > AD_IMAGE_MAX_BYTES) {
    throw new BusinessError("validation_failed", "The advert's picture is empty or too large. Upload it again.", 400);
  }
  return bytes;
}
