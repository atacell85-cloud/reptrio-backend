-- Additive transport metadata only. No personal payload copies or backfill.
CREATE TABLE IF NOT EXISTS sync_mutation_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
  committed_revision INTEGER NOT NULL CHECK(committed_revision = base_revision + 1),
  outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(user_id,mutation_id)
);
CREATE INDEX IF NOT EXISTS sync_mutation_receipts_expiry_idx ON sync_mutation_receipts(expires_at);
CREATE INDEX IF NOT EXISTS sync_records_order_idx ON sync_records(user_id,kind,tombstone,ordinal,record_key);
