-- Password reset (Build 43 G). One row per issued reset link. Only the SHA-256 digest of the 256-bit random token is
-- stored, never the token. `created_at` is the issue time; `used_at` marks the single successful consumption;
-- `revoked_at` marks a link superseded by a newer request or by a completed reset. Additive only.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id, created_at);
