-- Which branch fulfils online orders.
--
-- Online checkout previously hardcoded the first branch returned by the API,
-- so with >1 branch every web order silently landed on whichever sorted first.
-- This flag lets the owner choose. At most one branch is the default; the app
-- enforces that on write. No default set = checkout falls back to first branch.
ALTER TABLE "branch" ADD COLUMN "is_online_default" boolean NOT NULL DEFAULT false;
