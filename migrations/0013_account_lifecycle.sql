-- Additive account lifecycle. Legacy credential provenance stays UNKNOWN; never infer from timestamps.
ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(account_status IN ('ACTIVE','PENDING_DELETION','PURGING'));
ALTER TABLE users ADD COLUMN credential_origin TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(credential_origin IN ('UNKNOWN','PASSWORD','GOOGLE','APPLE'));
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN deletion_requested_at TEXT;
ALTER TABLE users ADD COLUMN purge_at TEXT;
ALTER TABLE users ADD COLUMN purge_lease TEXT;
ALTER TABLE users ADD COLUMN purge_lease_until TEXT;
ALTER TABLE users ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN purge_retry_at TEXT;
ALTER TABLE users ADD COLUMN purge_error TEXT;
CREATE INDEX IF NOT EXISTS account_purge_due ON users(account_status,purge_at,purge_retry_at);
CREATE TABLE IF NOT EXISTS account_lifecycle_credentials (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('DELETE_LINK','DELETE_PROOF','RECOVERY')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ownership_verified_at TEXT, used_at TEXT
);
CREATE INDEX IF NOT EXISTS account_lifecycle_owner ON account_lifecycle_credentials(user_id,purpose,created_at);
ALTER TABLE oauth_reauth_tickets ADD COLUMN provider TEXT;
ALTER TABLE oauth_reauth_tickets ADD COLUMN session_hash TEXT;
-- Execution metadata only: never a deletion receipt, and never timeout-as-proof of upstream cleanup.
CREATE TABLE IF NOT EXISTS account_lifecycle_work (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('RUNNING','RETURNED','UNKNOWN','RESOLVED')),
 response_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_error TEXT
);
CREATE INDEX IF NOT EXISTS lifecycle_work_owner ON account_lifecycle_work(user_id,state);
