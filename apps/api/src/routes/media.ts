import { Hono } from "hono";
import { eq, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { mediaAsset, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { presignPut } from "../lib/r2.js";

const KINDS = ["bottle", "cluster", "fruit", "splash", "leaf"] as const;

const CreateAsset = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1),
  url: z.string().min(1),
  object_key: z.string().min(1).optional(),
});

const PresignUpload = z.object({
  kind: z.enum(KINDS),
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size_bytes: z.number().int().positive(),
});

/**
 * Media library: the bottle / decoration image pool that the admin product
 * editor picks from (and uploads into). Reads are open to any authenticated
 * admin; writes require products.manage (same gate as the product editor).
 */
export function mediaRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  // List assets, newest first, optionally filtered by ?kind=bottle|cluster|...
  r.get("/", async (c) => {
    const kind = c.req.query("kind");
    const rows = kind
      ? await db
          .select()
          .from(mediaAsset)
          .where(eq(mediaAsset.kind, kind as (typeof KINDS)[number]))
          .orderBy(asc(mediaAsset.name))
      : await db.select().from(mediaAsset).orderBy(desc(mediaAsset.createdAt));
    return c.json({ data: rows });
  });

  // Register an asset record. Used both to add a known URL (e.g. a /media/...
  // path served by the customer app) and to record an R2 upload after the
  // browser PUTs to the presigned URL.
  r.post("/", requireCapability("products.manage"), async (c) => {
    const body = CreateAsset.parse(await c.req.json());
    const [row] = await db
      .insert(mediaAsset)
      .values({
        kind: body.kind,
        name: body.name,
        url: body.url,
        objectKey: body.object_key ?? null,
      })
      .returning();
    await writeAudit(db, c, {
      action: "media_asset.create",
      entityType: "media_asset",
      entityId: row!.id,
      after: row,
    });
    return c.json({ data: row }, 201);
  });

  // Presign a direct-to-R2 upload. The browser PUTs the file to upload_url,
  // then calls POST / with the returned object_key + public URL to record it.
  // Returns 503 if R2 isn't configured (library-pick still works without it).
  r.post("/upload-url", requireCapability("products.manage"), async (c) => {
    const body = PresignUpload.parse(await c.req.json());
    const { upload_url, object_key } = await presignPut({
      filename: body.filename,
      contentType: body.content_type,
      sizeBytes: body.size_bytes,
      folder: `media-${body.kind}`,
    });
    return c.json({ data: { upload_url, object_key } });
  });

  return r;
}
