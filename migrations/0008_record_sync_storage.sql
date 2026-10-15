-- Additive only. No backfill, legacy writes, or destructive migration.
CREATE TABLE IF NOT EXISTS sync_account_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  storage_schema_version INTEGER NOT NULL CHECK(storage_schema_version >= 1),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  write_token TEXT NOT NULL,
  write_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(write_status IN ('ACTIVE','BLOCKED')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('program','session','set','measurement','metadata')),
  record_key TEXT NOT NULL,
  parent_key TEXT,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  address_json TEXT NOT NULL CHECK(json_valid(address_json)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
  modified_revision INTEGER NOT NULL CHECK(modified_revision >= created_revision),
  tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1)),
  deleted_revision INTEGER,
  PRIMARY KEY(user_id,kind,record_key),
  CHECK((tombstone = 0 AND deleted_revision IS NULL) OR (tombstone = 1 AND deleted_revision = modified_revision))
);
CREATE INDEX IF NOT EXISTS sync_records_parent_idx ON sync_records(user_id,kind,parent_key,ordinal);
CREATE INDEX IF NOT EXISTS sync_records_revision_idx ON sync_records(user_id,modified_revision);
