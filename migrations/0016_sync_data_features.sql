-- Build 47 H1: additive account-level data-feature guard. No existing record is rewritten.
-- A row means the account holds data a pre-Build-47 client would drop; the server then refuses that client's writes.
-- Re-runnable: IF NOT EXISTS / INSERT OR IGNORE. Apply BEFORE deploying the Worker that requires it.
CREATE TABLE IF NOT EXISTS sync_account_data_features (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK(level >= 1),
  raised_revision INTEGER NOT NULL CHECK(raised_revision >= 0),
  raised_at TEXT NOT NULL
);
-- Monotonic: the level can never be lowered (account erasure removes the row with the account).
CREATE TRIGGER IF NOT EXISTS sync_account_data_features_monotonic
BEFORE UPDATE OF level ON sync_account_data_features
WHEN NEW.level < OLD.level
BEGIN
  SELECT RAISE(ABORT, 'DATA_FEATURE_LEVEL_DECREASE');
END;
-- One-time backfill for accounts that already hold Build 47 fields. Same predicate as worker/data-feature-guard.js.
INSERT OR IGNORE INTO sync_account_data_features(user_id,level,raised_revision,raised_at)
SELECT s.user_id, 1, s.revision, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM sync_account_state s
WHERE EXISTS (
  SELECT 1 FROM sync_records r WHERE r.user_id = s.user_id AND r.tombstone = 0 AND (
    instr(r.payload_json,'"catalogLink":') > 0
    OR (r.kind = 'measurement' AND (
      instr(r.payload_json,'"shoulderCm":') > 0 OR instr(r.payload_json,'"chestCm":') > 0 OR instr(r.payload_json,'"neckCm":') > 0
      OR instr(r.payload_json,'"hipCm":') > 0 OR instr(r.payload_json,'"basenCm":') > 0
      OR instr(r.payload_json,'"bicepsLeftCm":') > 0 OR instr(r.payload_json,'"bicepsRightCm":') > 0
      OR instr(r.payload_json,'"forearmLeftCm":') > 0 OR instr(r.payload_json,'"forearmRightCm":') > 0
      OR instr(r.payload_json,'"thighLeftCm":') > 0 OR instr(r.payload_json,'"thighRightCm":') > 0
      OR instr(r.payload_json,'"calfLeftCm":') > 0 OR instr(r.payload_json,'"calfRightCm":') > 0
      OR instr(r.payload_json,'"extraCm":') > 0 OR instr(r.payload_json,'"profileAtRecord":') > 0 OR instr(r.payload_json,'"derived":') > 0))
    OR (r.kind = 'metadata' AND r.record_key = '["settings"]' AND (
      instr(r.payload_json,'"googlePlaceId":') > 0 OR instr(r.payload_json,'"archivedAt":') > 0))
  )
);
