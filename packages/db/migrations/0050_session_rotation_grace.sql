-- Session rotation grace.
--
-- Refresh-token rotation revokes the old token the instant it's used. A lost
-- response, a backgrounded PWA, or a second tab racing the refresh then leaves
-- the client holding a dead token -> forced logout. We add `rotated_at` so we
-- can tell a ROTATION-revoke (which gets a short grace window where the old
-- token still works) from a LOGOUT / forced revoke (immediate, no grace).
ALTER TABLE "session" ADD COLUMN "rotated_at" timestamptz;
