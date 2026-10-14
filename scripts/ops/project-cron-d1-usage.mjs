// Build 44 operator/analysis tool (not part of `npm test`; needs the `sqlite3` CLI with .scanstats).
// Projects the daily D1 rows-read cost of the background triggers (minute purge, 15-minute maintenance, daily digest) on
// statistics-free databases of growing size. The real Worker code runs against an in-memory SQLite with the repository
// migrations; every statement is captured with its bound values, then replayed on a snapshot (VACUUM INTO) of the state
// before it ran with `.scanstats on`. Rows visited by each plan loop approximate D1 "rows read" (rows scanned).
// Usage: node scripts/ops/project-cron-d1-usage.mjs [sizes, default 1000,10000,100000]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createD1 } from '../lib/d1-sqlite.mjs';
import { purgeDueAccounts } from '../../worker/account-lifecycle.js';
import worker from '../../worker/index.js';
import { runOperationalDigest } from '../../worker/ops-alerts.js';

const sizes = (process.argv[2] || '1000,10000,100000').split(',').map(Number);
const dir = mkdtempSync(join(tmpdir(), 'reptrio-d1-usage-'));
const quote = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

function capture(db) {
  const log = [];
  const wrap = (sql, values = []) => {
    const st = db.prepare(sql).bind(...values);
    const rec = op => (...a) => { log.push({ sql, values }); return st[op](...a); };
    return { bind: (...v) => wrap(sql, v), first: rec('first'), all: rec('all'), run: rec('run'), sql, values };
  };
  return { log, db: { prepare: sql => wrap(sql), batch: items => { for (const i of items) log.push({ sql: i.sql, values: i.values }); return db.batch(items.map(i => db.prepare(i.sql).bind(...i.values))); } } };
}
function rowsRead(snapshot, statements) {
  if (!statements.length) return 0;
  const script = ['.scanstats on', 'BEGIN;', ...statements.map(({ sql, values }) => {
    let i = 0; const numbered = sql.replace(/\?/g, () => `?${++i}`);
    return ['.parameter clear', ...values.map((v, k) => `.parameter set ?${k + 1} ${quote(v)}`), numbered.replace(/\s+/g, ' ') + ';'].join('\n');
  }), 'ROLLBACK;'].join('\n');
  const file = join(dir, 'replay.sql'); writeFileSync(file, script);
  const out = execFileSync('sqlite3', [snapshot], { input: `.read ${file}\n`, encoding: 'utf8', maxBuffer: 256 << 20 });
  return [...out.matchAll(/(?:SCAN|SEARCH)[^\n]*?rows=(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
}

const results = [];
for (const n of sizes) {
  const db = createD1();
  const now = new Date().toISOString(), past = new Date(Date.now() - 86400000).toISOString(), future = new Date(Date.now() + 86400000).toISOString();
  const users = Math.max(10, n / 10);
  db.raw.exec('BEGIN');
  const user = db.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES (?,?,'x','x',?)");
  for (let i = 0; i < users; i++) user.run('u' + i, `u${i}@example.test`, now);
  // Steady state at scale: n completed AI imports (RESOLVED ledger rows), n live receipts, n retained restore records
  // (committed operations keep payloads for undo), n/10 live credentials, tickets and sessions, n/100 accounts closed
  // for 30 days (not yet due). No cleanup backlog: the cost the triggers pay every day.
  const work = db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id) VALUES (?,?,'RESOLVED',?,?,?)");
  for (let i = 0; i < n; i++) work.run('w' + i, 'u' + (i % users), past, past, 'resp_' + i);
  const receipt = db.raw.prepare("INSERT INTO sync_mutation_receipts VALUES(?,?,'h','p',0,1,'{}',?,?)");
  for (let i = 0; i < n; i++) receipt.run('u' + (i % users), 'm' + i, now, future);
  const ops = Math.max(1, n / 100), op = db.raw.prepare("INSERT INTO personal_restore_operations(user_id,operation_id,purpose,source_namespace,archive_retry_hash,local_binding,data_schema_version,expected_chunks,expected_counts_json,base_revision,state,expires_at,created_at,updated_at) VALUES (?,?,'RESTORE','n','h','b',8,1,'{}',0,'COMMITTED',?,?,?)");
  const root = db.raw.prepare("INSERT INTO personal_restore_roots(user_id,operation_id,root_id,root_kind,source_tuple,source_ordinal,portable_hash,counts_json) VALUES (?,?,0,'session','t',0,'h','{}')");
  const record = db.raw.prepare("INSERT INTO personal_restore_records(user_id,operation_id,root_id,item_ordinal,kind,record_key,ordinal,address_json,payload_json,source_tuple,portable_hash) VALUES (?,?,0,?,'set',?,?,'{}','{}',?,'h')");
  for (let o = 0; o < ops; o++) { const owner = 'u' + (o % users); op.run(owner, 'op' + o, past, now, now); root.run(owner, 'op' + o); for (let r = 0; r < n / ops; r++) record.run(owner, 'op' + o, r, 'k' + r, r, 't' + r); }
  const cred = db.raw.prepare("INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at) VALUES (?,?,?,?,'RECOVERY',?,?)");
  const ticket = db.raw.prepare('INSERT INTO oauth_reauth_tickets(id,user_id,ticket_hash,created_at,expires_at) VALUES (?,?,?,?,?)');
  const session = db.raw.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < n / 10; i++) { cred.run('c' + i, 'u' + (i % users), 'th' + i, 'sh' + i, now, future); ticket.run('t' + i, 'u' + (i % users), 'tk' + i, now, future); session.run('s' + i, 'u' + (i % users), 'st' + i, now, future); }
  db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',purge_at=? WHERE rowid % 10 = 0").run(future);
  db.raw.exec('COMMIT');
  const snapshot = join(dir, `state-${n}.db`); db.raw.exec(`VACUUM INTO '${snapshot}'`);
  const { log, db: traced } = capture(db), env = { DB: traced };
  const measure = async run => { log.length = 0; await run(); return rowsRead(snapshot, log.slice()); };
  const minute = await measure(() => purgeDueAccounts(env));
  const maintenance = await measure(async () => { let t; await worker.scheduled({ cron: '*/15 * * * *' }, env, { waitUntil(p) { t = p; } }); await t; });
  const digest = await measure(() => runOperationalDigest(env, Date.now()));
  const perDay = minute * 1440 + maintenance * 96 + digest;
  results.push({ size: n, rowsReadPerInvocation: { minute, maintenance, digest }, rowsReadPerDay: perDay, shareOfFreeDailyRead: +(perDay / 5_000_000).toFixed(4) });
}
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ freeDailyRowsRead: 5_000_000, idleCronProjection: results }, null, 1));
