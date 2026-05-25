import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";

/**
 * Marketing blog posts. Published when `published_at` is non-null.
 * Authored in markdown; body stored as raw text (rendered on the client).
 */
export const blogPost = pgTable(
  "blog_post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    bodyMd: text("body_md").notNull(),
    coverUrl: text("cover_url"),
    authorUserId: uuid("author_user_id").references(() => adminUser.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    idxPublished: index("idx_blog_post_published").on(t.publishedAt),
  }),
);
