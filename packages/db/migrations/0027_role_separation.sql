-- Collapse admin_role to the 4-role model and add per-user permission overrides.
-- factory_dispatcher + branch_manager both map to the new 'manager' role.

ALTER TYPE "admin_role" RENAME TO "admin_role_old";

CREATE TYPE "admin_role" AS ENUM ('owner', 'admin', 'manager', 'branch_staff');

ALTER TABLE "admin_user"
  ALTER COLUMN "role" TYPE "admin_role"
  USING (
    CASE "role"::text
      WHEN 'owner' THEN 'owner'
      WHEN 'factory_dispatcher' THEN 'manager'
      WHEN 'branch_manager' THEN 'manager'
      ELSE 'branch_staff'
    END
  )::"admin_role";

DROP TYPE "admin_role_old";

ALTER TABLE "admin_user"
  ADD COLUMN IF NOT EXISTS "permission_overrides" jsonb NOT NULL DEFAULT '{"granted":[],"revoked":[]}'::jsonb;
