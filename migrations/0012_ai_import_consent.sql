-- Build 44 / B44-07: independent opt-in for selected training documents sent to OpenAI.
-- Additive migration: all existing/new users start without AI consent.
CREATE TABLE IF NOT EXISTS ai_import_consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL,
  granted_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_import_consent_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_import_consent_events_user_idx ON ai_import_consent_events(user_id, created_at);
