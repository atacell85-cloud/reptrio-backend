// Build 44 operator tool: reconcile one UNKNOWN AI upstream work row. Prints a guarded `wrangler d1 execute` command;
// it never executes anything. Runbook: docs/BUILD_44_OPERATIONS_RUNBOOK.md.
//   --work <id> --response <resp_...> --evidence <ref>   response found upstream: hand it to the normal purge deletion
//   --work <id> --absent --evidence <ref>                no response exists upstream (documented evidence)
// Both forms touch only state='UNKNOWN', so a repeated or stale command changes nothing.
import { fileURLToPath } from 'node:url';

const WORK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESPONSE_ID = /^resp_[A-Za-z0-9]{8,128}$/;
const EVIDENCE = /^[A-Za-z0-9._:#\/-]{3,80}$/;

export function buildReconcileSQL({ work, response, absent, evidence }) {
  if (!WORK_ID.test(String(work || ''))) throw new Error('--work must be the lifecycle work UUID from the ops digest');
  if (!EVIDENCE.test(String(evidence || ''))) throw new Error('--evidence must be a ticket/log reference (3-80 chars: A-Z a-z 0-9 . _ : # / -)');
  if (Boolean(response) === Boolean(absent)) throw new Error('choose exactly one of --response <resp_...> or --absent');
  if (response) {
    if (!RESPONSE_ID.test(response)) throw new Error('--response must be an OpenAI response id (resp_...)');
    return `UPDATE account_lifecycle_work SET state='RETURNED',response_id='${response}',last_error='OPERATOR_FOUND:${evidence}' WHERE id='${work}' AND state='UNKNOWN';`;
  }
  return `UPDATE account_lifecycle_work SET state='RESOLVED',last_error='OPERATOR_VERIFIED_ABSENT:${evidence}' WHERE id='${work}' AND state='UNKNOWN';`;
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--absent') out.absent = true;
    else if (['--work', '--response', '--evidence'].includes(key)) out[key.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${key}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const sql = buildReconcileSQL(parse(process.argv.slice(2)));
    console.log('# Review, then run exactly once. Expect "changes": 1; 0 means the row was not UNKNOWN (nothing changed).');
    console.log(`npx wrangler d1 execute a2-workout-pilot --remote --command "${sql}"`);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
