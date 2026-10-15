// Build 44 operator tool (runbook §4c): reduce an account HELD by ACCOUNT_PURGE_PLAN_CAPACITY (its final erase would
// exceed the Workers Free daily purge write cap) in bounded chunks. Prints guarded `wrangler d1 execute` commands; it
// never executes anything.
// Every chunk is two commands, run in order:
//   1. charge: reserves the chunk's worst-case rows written (min(rows, present) x 5: <= 4 indexes + the row) in TODAY's shared purge
//      budget (d1_write_budget scope 'purge', cap 60,000). Expect "changes": 1. If 0, the day's budget is spent: stop
//      and continue after 00:00 UTC. A charge without its delete only over-counts (safe).
//   2. delete: at most --rows owner rows of one bulk table, only while the account is still PURGING with that hold
//      (upstream cleanup is already complete in that state). Repeat chunks until a delete reports "changes": 0 for
//      every table; then clear the retry so the minute cron runs the normal, fully gated final erase:
//      UPDATE users SET purge_retry_at=NULL WHERE id='<user>' AND account_status='PURGING';
// Usage: node scripts/ops/purge-large-account.mjs --user <id> --evidence <ticket> [--rows 4000] [--day YYYY-MM-DD]
import { fileURLToPath } from 'node:url';
import { PURGE_DAILY_ROWS_WRITTEN } from '../../worker/free-plan-limits.js';

const USER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EVIDENCE = /^[A-Za-z0-9._:#\/-]{3,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEIGHT = 5;
// Owner-scoped bulk tables (largest first); everything else is small and left to the automatic final erase.
export const BULK_TABLES = ['sync_records', 'personal_restore_records', 'workout_sets', 'personal_restore_identity_journal', 'workout_sessions', 'sync_mutation_receipts'];

export function buildChunkSQL({ user, evidence, rows = 4000, day = new Date().toISOString().slice(0, 10) }) {
  if (!USER_ID.test(String(user || ''))) throw new Error('--user must be the held account id from the ops digest / dashboard');
  if (!EVIDENCE.test(String(evidence || ''))) throw new Error('--evidence must be a ticket/log reference (3-80 chars: A-Z a-z 0-9 . _ : # / -)');
  if (!DAY.test(String(day))) throw new Error('--day must be YYYY-MM-DD (UTC)');
  const n = Number(rows);
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error('--rows must be an integer 1..5000');
  const cap = PURGE_DAILY_ROWS_WRITTEN;
  const held = `EXISTS(SELECT 1 FROM users WHERE id='${user}' AND account_status='PURGING' AND deleted_at IS NULL AND purge_error='ACCOUNT_PURGE_PLAN_CAPACITY')`;
  // Charge only the rows this chunk can actually delete (an empty table costs 0), x WEIGHT.
  const cost = table => `(SELECT MIN(${n},COUNT(*))*${WEIGHT} FROM ${table} WHERE user_id='${user}')`;
  const charge = table => `INSERT INTO d1_write_budget(day,scope,rows_written) SELECT '${day}','purge',${cost(table)} WHERE ${cost(table)}<=${cap} ON CONFLICT(day,scope) DO UPDATE SET rows_written=d1_write_budget.rows_written+excluded.rows_written WHERE d1_write_budget.rows_written+excluded.rows_written<=${cap};`;
  return BULK_TABLES.map(table => ({ table, charge: charge(table), delete: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE user_id='${user}' LIMIT ${n}) AND ${held};` }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = {}; const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (!['--user', '--evidence', '--rows', '--day'].includes(k)) throw new Error(`unknown argument ${k}`); args[k.slice(2)] = argv[++i]; }
    const chunks = buildChunkSQL(args);
    console.log(`# Evidence: ${args.evidence}. Per chunk: run "charge" (expect changes 1; 0 = budget spent, stop until 00:00 UTC), then "delete".`);
    for (const c of chunks) {
      console.log(`# ${c.table}`);
      console.log(`npx wrangler d1 execute a2-workout-pilot --remote --command "${c.charge}"`);
      console.log(`npx wrangler d1 execute a2-workout-pilot --remote --command "${c.delete}"`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
