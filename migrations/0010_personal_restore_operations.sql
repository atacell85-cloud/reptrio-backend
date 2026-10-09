-- Additive, account-scoped staging and lifetime restore evidence. No production backfill.
CREATE TABLE IF NOT EXISTS personal_restore_operations (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('RESTORE','SYNC')), protocol INTEGER NOT NULL DEFAULT 1,
 source_namespace TEXT NOT NULL, archive_retry_hash TEXT NOT NULL, local_binding TEXT NOT NULL,
 data_schema_version INTEGER NOT NULL, expected_chunks INTEGER NOT NULL, expected_counts_json TEXT NOT NULL,
 base_revision INTEGER NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 semantic_hash TEXT, preview_hash TEXT, selection_hash TEXT, confirm_hash TEXT, progress_json TEXT,
 generation_id TEXT, generation_version INTEGER NOT NULL DEFAULT 0, pinned_revision INTEGER, pinned_token TEXT,
 committed_revision INTEGER, undo_revision INTEGER, outcome_json TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE IF NOT EXISTS personal_restore_roots (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL, root_id INTEGER NOT NULL,
 root_kind TEXT NOT NULL, source_tuple TEXT NOT NULL, source_ordinal INTEGER NOT NULL,
 portable_hash TEXT NOT NULL, counts_json TEXT NOT NULL, classification TEXT, selected INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,operation_id,root_id), UNIQUE(user_id,operation_id,root_kind,source_tuple),
 FOREIGN KEY(user_id,operation_id) REFERENCES personal_restore_operations(user_id,operation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_restore_records (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL, root_id INTEGER NOT NULL, item_ordinal INTEGER NOT NULL,
 kind TEXT NOT NULL, record_key TEXT NOT NULL, parent_key TEXT, ordinal INTEGER NOT NULL,
 address_json TEXT NOT NULL, payload_json TEXT NOT NULL, source_tuple TEXT NOT NULL, portable_hash TEXT NOT NULL, address_hash TEXT NOT NULL DEFAULT '', container_json TEXT NOT NULL DEFAULT '{}',
 publish_kind TEXT, target_ordinal INTEGER, classification TEXT, selected INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,operation_id,root_id,item_ordinal), UNIQUE(user_id,operation_id,kind,source_tuple),
 FOREIGN KEY(user_id,operation_id,root_id) REFERENCES personal_restore_roots(user_id,operation_id,root_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_restore_chunks (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
 chunk_hash TEXT NOT NULL, roots INTEGER NOT NULL, records INTEGER NOT NULL, counts_json TEXT NOT NULL, byte_count INTEGER NOT NULL,
 PRIMARY KEY(user_id,operation_id,chunk_index),
 FOREIGN KEY(user_id,operation_id) REFERENCES personal_restore_operations(user_id,operation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_restore_identity_journal (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_namespace TEXT NOT NULL, kind TEXT NOT NULL, source_tuple TEXT NOT NULL,
 target_kind TEXT NOT NULL, target_key TEXT NOT NULL, target_path TEXT NOT NULL, operation_id TEXT NOT NULL,
 import_hash TEXT NOT NULL, address_hash TEXT NOT NULL, container_json TEXT NOT NULL DEFAULT '{}', target_ordinal INTEGER NOT NULL, added_revision INTEGER NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('ADDED','SAME_EXISTING')), state TEXT NOT NULL CHECK(state IN ('LIVE','UNDONE')),
 PRIMARY KEY(user_id,source_namespace,kind,source_tuple)
);
CREATE INDEX IF NOT EXISTS personal_restore_expiry ON personal_restore_operations(state,expires_at,user_id,operation_id);
CREATE INDEX IF NOT EXISTS personal_restore_source_order ON personal_restore_records(user_id,operation_id,root_id,item_ordinal);
CREATE INDEX IF NOT EXISTS personal_restore_journal_operation ON personal_restore_identity_journal(user_id,operation_id,disposition,state,kind,source_tuple);
CREATE INDEX IF NOT EXISTS personal_restore_record_target ON personal_restore_records(user_id,operation_id,publish_kind,record_key);
CREATE INDEX IF NOT EXISTS personal_restore_journal_target ON personal_restore_identity_journal(user_id,operation_id,target_kind,target_key,disposition,state);
