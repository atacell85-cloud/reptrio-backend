-- Build 44 Free-plan capacity (additive only: one nullable column, indexes, one small table; no DROP/RENAME).

-- Import job a superseded/adopted upstream response came from (traceability of the cleanup ledger).
ALTER TABLE account_lifecycle_work ADD COLUMN import_job_id TEXT;

-- Minute purge cron: `state='RUNNING' AND expires_at<=?` and the daily digest's per-state terms seek instead of scanning
-- every work row ever written.
CREATE INDEX IF NOT EXISTS lifecycle_work_state_expiry ON account_lifecycle_work(state, expires_at);

-- Account erase / DELETE_NOW / logout-all remove an owner's sessions (and the users-row FK cascade checks them):
-- seek by owner instead of scanning every session.
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);

-- Expiry cleanup of short-lived credentials/tickets seeks by expiry.
CREATE INDEX IF NOT EXISTS lifecycle_credentials_expiry ON account_lifecycle_credentials(expires_at);
CREATE INDEX IF NOT EXISTS oauth_reauth_tickets_expiry ON oauth_reauth_tickets(expires_at);

-- Restore maintenance drives from expired operations (outer loop, forced by CROSS JOIN) through these partial indexes,
-- independent of planner statistics; (expires_at,user_id,operation_id) also yields the delete order without a sort.
-- Each WHERE clause matches the maintenance query's term exactly so SQLite can use the partial index.
CREATE INDEX IF NOT EXISTS personal_restore_cleanup_due ON personal_restore_operations(expires_at,user_id,operation_id)
  WHERE state NOT IN ('COMMITTED','UNDONE','UNDO_READY','UNDO_PREVIEWING');
CREATE INDEX IF NOT EXISTS personal_restore_sync_due ON personal_restore_operations(expires_at,user_id,operation_id)
  WHERE purpose='SYNC';

-- Daily D1 rows-written budget for background work (Workers Free: 100,000 rows written/day, reset 00:00 UTC).
-- scope: 'purge' (final account erase batches) or 'maintenance' (15-minute expiry cleanup).
CREATE TABLE IF NOT EXISTS d1_write_budget (
  day TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('purge','maintenance')),
  rows_written INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  PRIMARY KEY(day, scope)
);
