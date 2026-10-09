-- Account deletion used to only mark users.deleted_at and left oauth_accounts, import_jobs and mobile OAuth codes
-- behind. Those users asked for deletion: remove every row still linked to them, then the user rows themselves.
-- Irreversible; applies only to users that already completed the in-app deletion. NOT a migration (migrations apply
-- automatically): run once, only with explicit owner approval, after the 0005, 0007 and 0008 migrations:
--   npx wrangler d1 execute a2-workout-pilot --remote --file scripts/maintenance/purge-soft-deleted-accounts.sql
DELETE FROM sync_records WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM sync_account_state WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM oauth_reauth_tickets WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM import_jobs WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM mobile_oauth_codes WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM oauth_accounts WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM user_data WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM programs WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM workout_sessions WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM workout_sets WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM sync_metadata WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM users WHERE deleted_at IS NOT NULL;
