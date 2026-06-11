-- Blog marketing fields the static frontend had but the DB lacked: a display
-- author name (distinct from author_user_id), reading time, a category label,
-- and the decoration cluster the hero uses. All nullable so existing rows and
-- the admin write path keep working.
ALTER TABLE "blog_post"
  ADD COLUMN "author"    text,
  ADD COLUMN "read_mins" integer,
  ADD COLUMN "category"  text,
  ADD COLUMN "cluster"   text;
