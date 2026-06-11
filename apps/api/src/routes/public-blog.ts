import { Hono } from "hono";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { blogPost, type DbClient } from "@ms/db";
import { BusinessError } from "../lib/errors.js";

/**
 * Public blog endpoints. Only returns published, non-deleted posts.
 */
export function publicBlogRoutes(db: DbClient) {
  const r = new Hono();

  r.get("/", async (c) => {
    const rows = await db
      .select({
        id: blogPost.id,
        slug: blogPost.slug,
        title: blogPost.title,
        excerpt: blogPost.excerpt,
        coverUrl: blogPost.coverUrl,
        publishedAt: blogPost.publishedAt,
        author: blogPost.author,
        readMins: blogPost.readMins,
        category: blogPost.category,
        cluster: blogPost.cluster,
      })
      .from(blogPost)
      .where(and(isNotNull(blogPost.publishedAt), isNull(blogPost.deletedAt)))
      .orderBy(desc(blogPost.publishedAt))
      .limit(50);
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        excerpt: r.excerpt,
        cover_url: r.coverUrl,
        published_at: r.publishedAt,
        author: r.author,
        read_mins: r.readMins,
        category: r.category,
        cluster: r.cluster,
      })),
    });
  });

  r.get("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const [row] = await db
      .select()
      .from(blogPost)
      .where(
        and(
          eq(blogPost.slug, slug),
          isNotNull(blogPost.publishedAt),
          isNull(blogPost.deletedAt),
        ),
      );
    if (!row) throw new BusinessError("not_found", "post not found", 404);
    return c.json({
      data: {
        id: row.id,
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        body_md: row.bodyMd,
        cover_url: row.coverUrl,
        published_at: row.publishedAt,
        author: row.author,
        read_mins: row.readMins,
        category: row.category,
        cluster: row.cluster,
        // Read counter is a nice-to-have; skip for v1.
      },
    });
  });

  // Tiny health check that confirms the table exists — useful when admin
  // wants to check the feature is wired before publishing.
  r.get("/_health", async (c) => {
    const rows = await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM blog_post`);
    return c.json({ data: { posts: Number(rows[0]?.n ?? 0) } });
  });

  return r;
}
