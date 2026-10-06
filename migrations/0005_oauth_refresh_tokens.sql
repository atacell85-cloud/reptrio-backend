-- Sign in with Apple token revocation (App Review Guideline 5.1.1(v)): keep the provider refresh token, encrypted
-- (AES-GCM, see worker/account-api.js `sealProviderToken`), so account deletion can call Apple's revoke endpoint.
ALTER TABLE oauth_accounts ADD COLUMN refresh_token_ciphertext TEXT;
ALTER TABLE oauth_accounts ADD COLUMN refresh_token_updated_at TEXT;

-- Account deletion: a legacy Apple user re-authorizes with Apple so a token can be stored and revoked. The ticket ties
-- that Apple authorization to the signed-in account (single use, short lived); it never creates or switches accounts.
CREATE TABLE IF NOT EXISTS oauth_reauth_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_reauth_tickets_user_idx ON oauth_reauth_tickets(user_id);
