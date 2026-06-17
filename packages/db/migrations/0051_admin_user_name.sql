-- Staff display name.
--
-- admin_user previously stored only email/phone/role, so notifications could
-- only ever say "Branch staff" plus an id fragment. Add an optional human name
-- so Telegram alerts can identify who did what. Nullable: existing accounts
-- fall back to their email handle until a name is filled in.
ALTER TABLE "admin_user" ADD COLUMN "name" text;
