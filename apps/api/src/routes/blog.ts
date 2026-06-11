import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { blogPost, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const CreatePost = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
  title: z.string().min(1).max(200),
  excerpt: z.string().max(500).nullable().optional(),
  body_md: z.string().min(1),
  cover_url: z.string().url().nullable().optional(),
  author: z.string().max(120).nullable().optional(),
  read_mins: z.number().int().positive().max(120).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  cluster: z.string().max(40).nullable().optional(),
  published: z.boolean().optional().default(false),
});

const PatchPost = z.object({
  title: z.string().min(1).max(200).optional(),
  excerpt: z.string().max(500).nullable().optional(),
  body_md: z.string().min(1).optional(),
  cover_url: z.string().url().nullable().optional(),
  author: z.string().max(120).nullable().optional(),
  read_mins: z.number().int().positive().max(120).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  cluster: z.string().max(40).nullable().optional(),
  published: z.boolean().optional(),
});

export function blogRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("blog.manage"));

  r.get("/", async (c) => {
    const rows = await db
      .select()
      .from(blogPost)
      .where(isNull(blogPost.deletedAt))
      .orderBy(desc(blogPost.createdAt));
    return c.json({ data: rows });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(blogPost)
      .where(and(eq(blogPost.id, id), isNull(blogPost.deletedAt)));
    if (!row) throw new BusinessError("not_found", "post not found", 404);
    return c.json({ data: row });
  });

  r.post("/", async (c) => {
    const body = CreatePost.parse(await c.req.json());
    const auth = c.get("auth");

    const existing = await db
      .select({ id: blogPost.id })
      .from(blogPost)
      .where(eq(blogPost.slug, body.slug))
      .limit(1);
    if (existing.length > 0) {
      throw new BusinessError("conflict", "slug already in use", 409);
    }

    const [row] = await db
      .insert(blogPost)
      .values({
        slug: body.slug,
        title: body.title,
        excerpt: body.excerpt ?? null,
        bodyMd: body.body_md,
        coverUrl: body.cover_url ?? null,
        author: body.author ?? null,
        readMins: body.read_mins ?? null,
        category: body.category ?? null,
        cluster: body.cluster ?? null,
        authorUserId: auth.userId,
        publishedAt: body.published ? new Date() : null,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert failed", 500);
    await writeAudit(db, c, {
      action: "blog_post.create",
      entityType: "blog_post",
      entityId: row.id,
      after: row,
    });
    return c.json({ data: row }, 201);
  });

  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = PatchPost.parse(await c.req.json());

    const [before] = await db
      .select()
      .from(blogPost)
      .where(and(eq(blogPost.id, id), isNull(blogPost.deletedAt)));
    if (!before) throw new BusinessError("not_found", "post not found", 404);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch["title"] = body.title;
    if (body.excerpt !== undefined) patch["excerpt"] = body.excerpt;
    if (body.body_md !== undefined) patch["bodyMd"] = body.body_md;
    if (body.cover_url !== undefined) patch["coverUrl"] = body.cover_url;
    if (body.author !== undefined) patch["author"] = body.author;
    if (body.read_mins !== undefined) patch["readMins"] = body.read_mins;
    if (body.category !== undefined) patch["category"] = body.category;
    if (body.cluster !== undefined) patch["cluster"] = body.cluster;
    if (body.published !== undefined) {
      patch["publishedAt"] = body.published ? before.publishedAt ?? new Date() : null;
    }

    const [row] = await db.update(blogPost).set(patch).where(eq(blogPost.id, id)).returning();
    if (!row) throw new BusinessError("internal_error", "update failed", 500);
    await writeAudit(db, c, {
      action: "blog_post.update",
      entityType: "blog_post",
      entityId: id,
      before,
      after: row,
    });
    return c.json({ data: row });
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .update(blogPost)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(blogPost.id, id))
      .returning();
    if (!row) throw new BusinessError("not_found", "post not found", 404);
    await writeAudit(db, c, {
      action: "blog_post.delete",
      entityType: "blog_post",
      entityId: id,
    });
    return c.json({ data: { ok: true } });
  });

  return r;
}
