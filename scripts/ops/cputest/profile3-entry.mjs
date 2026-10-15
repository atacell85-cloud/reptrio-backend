// Third CPU profile round (isolated test Worker only): cost of D1 result size. The purge snapshot's schema read returns
// the full SQL text of ~40 objects; compare with names only, a single users row, the snapshot batch and the estimate.
const NAMES = ['sync_records','sync_account_state','import_jobs','mobile_oauth_codes','oauth_reauth_tickets','oauth_accounts','auth_sessions','user_data','programs','workout_sessions','workout_sets','user_settings','sync_metadata','password_reset_tokens','personal_restore_identity_journal','personal_restore_records','personal_restore_roots','personal_restore_chunks','personal_restore_operations','sync_mutation_receipts','ai_import_consents','ai_import_consent_events','account_lifecycle_work','account_lifecycle_credentials','personal_restore_record_target','personal_restore_journal_target'];
const schema = cols => `SELECT ${cols} FROM sqlite_master WHERE type IN ('table','index') AND name IN (${NAMES.map(() => '?').join(',')})`;
const VARIANTS = {
  '* * * * *': env => env.DB.prepare(schema('type,name,sql')).bind(...NAMES).all(),
  '*/1 * * * *': env => env.DB.prepare(schema('type,name')).bind(...NAMES).all(),
  '0-59 * * * *': env => env.DB.prepare('SELECT * FROM users LIMIT 1').all(),
  '*/3 * * * *': env => env.DB.batch([env.DB.prepare(schema('type,name,sql')).bind(...NAMES), env.DB.prepare('SELECT * FROM users LIMIT 1'), env.DB.prepare('SELECT 1')]),
  '* 0-23 * * *': env => env.DB.batch([env.DB.prepare(schema('type,name')).bind(...NAMES), env.DB.prepare('SELECT * FROM users LIMIT 1'), env.DB.prepare('SELECT 1')]),
};
export default { async scheduled(event, env) { const run = VARIANTS[event.cron]; if (run) { const r = await run(env); console.log(JSON.stringify({ event: 'cpu_profile', bytes: JSON.stringify(r).length })); } } };
