-- audit_log is append-only at the application user level.
-- Owner role retains all privileges (used by migrations + seeds);
-- the runtime application user (when we add one) will be restricted.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
