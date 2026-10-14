// Build 44 release safety: UNKNOWN AI upstream reconciliation, DELETE_NOW refusal, operational digest/alert routing and
// purge capacity evidence. Routed Worker + real SQLite (scripts/lib/d1-sqlite.mjs); upstreams are local fakes.
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createD1 } from './lib/d1-sqlite.mjs';
import { purgeDueAccounts, backgroundRejected } from '../worker/account-lifecycle.js';
import { runOperationalDigest, OPS_DIGEST_CRON } from '../worker/ops-alerts.js';
import { buildReconcileSQL } from './ops/reconcile-ai-work.mjs';

const POLICY = 'ai_import_openai_document_v1';
let upstream = () => new Response('{}'), mails = [], openaiCreates = [], openaiDeletes = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === 'https://cpaas.zoho.eu/v1.1/email') { mails.push(JSON.parse(init.body)); return new Response('{}'); }
  if (url === 'https://api.openai.com/v1/responses') { openaiCreates.push({ headers: init.headers, body: JSON.parse(init.body) }); return upstream(); }
  if (url.startsWith('https://api.openai.com/v1/responses/') && init.method === 'DELETE') { openaiDeletes.push(url.split('/').pop()); return new Response('{}'); }
  throw new Error(`unexpected fetch ${url}`);
};
const fresh = () => { const db = createD1(); return { db, env: { DB: db, OPENAI_API_KEY: 'fixture', ZEPTOMAIL_API_KEY: 'fixture', ASSETS: { fetch: () => new Response('') } } }; };
const call = (env, path, token, payload) => worker.fetch(new Request('https://api.reptrio.com' + path, { method: payload === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), env, {});
async function account(env, tag) {
  const r = await call(env, '/api/auth/register', null, { email: tag + '@example.test', password: 'fixture-password' }); assert.equal(r.status, 201);
  const u = await r.json();
  assert.equal((await call(env, '/api/privacy/ai-import/consent', u.sessionToken, { action: 'grant', policyVersion: POLICY })).status, 200);
  return u;
}
async function proof(env, u) {
  mails = []; assert.equal((await call(env, '/api/auth/delete/request-link', u.sessionToken, {})).status, 202);
  const token = /#token=([\w-]{43})/.exec(mails[0].textbody)[1];
  const r = await call(env, '/api/auth/delete/verify-link', u.sessionToken, { token }); assert.equal(r.status, 200); return (await r.json()).proof;
}
function upload(env, u, id) {
  const form = new FormData(); form.set('importId', id); form.set('normalizedDocument', JSON.stringify({ fileName: 'r.pdf', fileType: 'pdf', blocks: [{ type: 'paragraph', text: 'Squat 3x10' }] })); form.set('file', new Blob(['%PDF-fixture'], { type: 'application/pdf' }), 'r.pdf');
  return worker.fetch(new Request('https://api.reptrio.com/api/import/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + u.sessionToken }, body: form }), env, {});
}
const work = (db, u) => db.rows('SELECT id,state,response_id,last_error FROM account_lifecycle_work WHERE user_id=? ORDER BY created_at', u.user.id);
const due = (db, u) => db.raw.prepare('UPDATE users SET purge_at=?,purge_retry_at=NULL,purge_lease_until=NULL WHERE id=?').run(new Date(Date.now() - 1).toISOString(), u.user.id);

// 1. Upstream outcome classification: a definite 4xx rejection created nothing; 5xx/timeout/network/unreadable stay UNKNOWN.
{
  const { db, env } = fresh();
  for (const [tag, reply, expected, error] of [
    ['r400', () => new Response('{"error":{}}', { status: 400 }), 'RESOLVED', 'UPSTREAM_REJECTED_400'],
    ['r429', () => new Response('{"error":{}}', { status: 429 }), 'RESOLVED', 'UPSTREAM_REJECTED_429'],
    ['r408', () => new Response('{}', { status: 408 }), 'UNKNOWN', 'UPSTREAM_OUTCOME_UNKNOWN'],
    ['r409', () => new Response('{}', { status: 409 }), 'UNKNOWN', 'UPSTREAM_OUTCOME_UNKNOWN'],
    ['r413', () => new Response('{}', { status: 413 }), 'RESOLVED', 'UPSTREAM_REJECTED_413'],
    ['r500', () => new Response('{}', { status: 500 }), 'UNKNOWN', 'UPSTREAM_OUTCOME_UNKNOWN'],
    ['net', () => { throw new TypeError('network'); }, 'UNKNOWN', 'UPSTREAM_OUTCOME_UNKNOWN'],
    ['body', () => new Response('not-json', { status: 200 }), 'UNKNOWN', 'UPSTREAM_OUTCOME_UNKNOWN'],
  ]) {
    const u = await account(env, tag); upstream = reply; openaiCreates = [];
    assert.notEqual((await upload(env, u, 'job-' + tag)).status, 202, tag);
    const [row] = work(db, u);
    assert.deepEqual([row.state, row.last_error], [expected, error], tag);
    // The durable work id is the upstream correlation key used by the operator runbook.
    assert.equal(openaiCreates[0].headers['X-Client-Request-Id'], row.id, tag);
    assert.equal(openaiCreates[0].body.metadata.import_request_id, row.id, tag);
  }
  // Success still records and resolves the returned id.
  const ok = await account(env, 'ok'); upstream = () => new Response(JSON.stringify({ id: 'resp_okfixture1', status: 'queued' }), { headers: { 'Content-Type': 'application/json' } });
  assert.equal((await upload(env, ok, 'job-ok')).status, 202);
  assert.deepEqual(work(db, ok).map(r => [r.state, r.response_id]), [['RESOLVED', 'resp_okfixture1']]);
}

// 2. DELETE_NOW refuses on UNKNOWN without any state change; 30-day closure is accepted; purge blocks until reconciled.
{
  const { db, env } = fresh();
  const u = await account(env, 'unknown-owner'), bystander = await account(env, 'bystander');
  upstream = () => new Response('{}', { status: 502 }); await upload(env, u, 'job-u');
  const [unknown] = work(db, u); assert.equal(unknown.state, 'UNKNOWN');
  const p = await proof(env, u);
  // A bad proof is still 401 first, even with open upstream work.
  const badProof = await call(env, '/api/auth/delete', u.sessionToken, { proof: 'X'.repeat(43), confirm: 'DELETE', method: 'DELETE_NOW' });
  assert.equal(badProof.status, 401); assert.equal((await badProof.json()).code, 'ACCOUNT_DELETE_PROOF_INVALID');
  db.resetMetrics();
  const refused = await call(env, '/api/auth/delete', u.sessionToken, { proof: p, confirm: 'DELETE', method: 'DELETE_NOW' });
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'ACCOUNT_PURGE_UPSTREAM_UNRESOLVED');
  assert.equal(db.rows('SELECT account_status FROM users WHERE id=?', u.user.id)[0].account_status, 'ACTIVE');
  assert.equal(db.rows('SELECT used_at FROM account_lifecycle_credentials WHERE user_id=? AND purpose=?', u.user.id, 'DELETE_PROOF')[0].used_at, null, 'proof not consumed');
  assert.equal((await call(env, '/api/me', u.sessionToken)).status, 200, 'session intact after refusal');
  const closed = await call(env, '/api/auth/delete', u.sessionToken, { proof: p, confirm: 'DELETE', method: 'DELETE_AFTER_30_DAYS' });
  assert.equal(closed.status, 200); assert.equal((await closed.json()).accountStatus, 'PENDING_DELETION');
  // Recovery-screen "delete now" refuses too and keeps the account recoverable (still PENDING_DELETION).
  const relog = await (await call(env, '/api/auth/login', null, { email: u.user.email, password: 'fixture-password' })).json();
  assert.ok(relog.recoveryToken);
  const own = db.rows('SELECT id FROM account_lifecycle_credentials WHERE user_id=? AND purpose=?', u.user.id, 'RECOVERY')[0];
  db.raw.prepare('UPDATE account_lifecycle_credentials SET ownership_verified_at=? WHERE id=?').run(new Date().toISOString(), own.id);
  const nowRefused = await call(env, '/api/auth/account/purge-now', relog.recoveryToken, { confirm: 'DELETE' });
  assert.equal(nowRefused.status, 409); assert.equal((await nowRefused.json()).code, 'ACCOUNT_PURGE_UPSTREAM_UNRESOLVED');
  assert.equal(db.rows('SELECT account_status FROM users WHERE id=?', u.user.id)[0].account_status, 'PENDING_DELETION', 'still recoverable');
  due(db, u); await purgeDueAccounts(env);
  assert.equal(db.rows('SELECT account_status FROM users WHERE id=?', u.user.id)[0].account_status, 'PURGING', 'UNKNOWN never purges as success');
  assert.equal(db.rows('SELECT purge_error FROM users WHERE id=?', u.user.id)[0].purge_error, 'ACCOUNT_PURGE_UPSTREAM_UNRESOLVED');

  // 3. Digest routes the blocked purge + UNKNOWN id to the operator; no account email or user id leaves in the alert.
  mails = [];
  const unrouted = await runOperationalDigest(env, Date.now() + 2 * 3600000);
  assert.equal(unrouted.routed, false); assert.equal(mails.length, 0, 'no recipient configured: logged, not sent');
  const alerting = { ...env, OPS_ALERT_EMAIL: 'ops@example.test' };
  const routed = await runOperationalDigest(alerting, Date.now() + 2 * 3600000);
  assert.equal(routed.routed, true); assert.equal(mails.length, 1);
  assert.equal(mails[0].to[0].email_address.address, 'ops@example.test');
  assert.deepEqual(routed.findings.map(f => f.code).sort(), ['ACCOUNT_PURGE_OVERDUE', 'AI_WORK_UNKNOWN']);
  assert.ok(mails[0].textbody.includes(unknown.id), 'operator receives the opaque work id');
  for (const leak of [u.user.email, u.user.id, bystander.user.email]) assert.ok(!mails[0].textbody.includes(leak) && !mails[0].subject.includes(leak), 'no personal identifiers');

  // 4. Operator reconciliation: absent-with-evidence closes only the UNKNOWN row, then the unchanged purge completes.
  assert.throws(() => buildReconcileSQL({ work: unknown.id, absent: true, evidence: "x'; DROP TABLE users;--" }));
  assert.throws(() => buildReconcileSQL({ work: 'not-a-uuid', absent: true, evidence: 'ticket-1' }));
  assert.throws(() => buildReconcileSQL({ work: unknown.id, absent: true, response: 'resp_abcdefgh', evidence: 'ticket-1' }));
  assert.throws(() => buildReconcileSQL({ work: unknown.id, response: "resp_x' OR '1'='1", evidence: 'ticket-1' }));
  const sql = buildReconcileSQL({ work: unknown.id, absent: true, evidence: 'openai-logs:2026-10-14' });
  db.raw.exec(sql); db.raw.exec(sql);
  assert.deepEqual(work(db, u).map(r => [r.state, r.last_error]), [['RESOLVED', 'OPERATOR_VERIFIED_ABSENT:openai-logs:2026-10-14']]);
  due(db, u); await purgeDueAccounts(env);
  assert.equal(db.rows('SELECT * FROM users WHERE id=?', u.user.id).length, 0, 'purge completes after reconciliation');
  assert.equal((await call(env, '/api/me', bystander.sessionToken)).status, 200, 'other account untouched');
  assert.equal(work(db, bystander).length, 0);
}

// 4b. Operator found the response upstream: hand-off to the normal purge, which deletes it at OpenAI before erasure.
{
  const { db, env } = fresh();
  const u = await account(env, 'found');
  upstream = () => { throw new TypeError('reset'); }; await upload(env, u, 'job-f');
  const [row] = work(db, u); const p = await proof(env, u);
  assert.equal((await call(env, '/api/auth/delete', u.sessionToken, { proof: p, confirm: 'DELETE' })).status, 200);
  db.raw.exec(buildReconcileSQL({ work: row.id, response: 'resp_foundupstream1', evidence: 'openai-logs:found' }));
  const digest = await runOperationalDigest({ ...env, OPS_ALERT_EMAIL: 'ops@example.test' }, Date.now());
  assert.ok(!digest.findings.some(f => f.code === 'AI_CLEANUP_FAILED' || f.code === 'AI_WORK_UNKNOWN'), 'handed-off row is not re-alerted');
  openaiDeletes = []; due(db, u); await purgeDueAccounts(env);
  assert.deepEqual(openaiDeletes, ['resp_foundupstream1']);
  assert.equal(db.rows('SELECT * FROM users WHERE id=?', u.user.id).length, 0);
}

// 4c. Closures are state-guarded: a rejection only closes RUNNING work; operator SQL only touches UNKNOWN rows.
{
  const { db, env } = fresh();
  const u = await account(env, 'guards'), now = new Date().toISOString();
  const ids = { UNKNOWN: '11111111-1111-4111-8111-111111111111', RETURNED: '22222222-2222-4222-8222-222222222222', RESOLVED: '33333333-3333-4333-8333-333333333333' };
  for (const [state, id] of Object.entries(ids)) db.raw.prepare('INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id,last_error)VALUES(?,?,?,?,?,?,?)').run(id, u.user.id, state, now, now, state === 'RETURNED' ? 'resp_keepreturned' : null, 'BEFORE');
  const snapshot = () => db.rows('SELECT id,state,response_id,last_error FROM account_lifecycle_work WHERE user_id=? ORDER BY id', u.user.id);
  const before = snapshot();
  for (const id of Object.values(ids)) await backgroundRejected(env, id, 400);
  for (const id of [ids.RETURNED, ids.RESOLVED]) { db.raw.exec(buildReconcileSQL({ work: id, absent: true, evidence: 'stale-cmd' })); db.raw.exec(buildReconcileSQL({ work: id, response: 'resp_staleresp1', evidence: 'stale-cmd' })); }
  const after = snapshot();
  assert.deepEqual(after.filter(r => r.id !== ids.UNKNOWN), before.filter(r => r.id !== ids.UNKNOWN), 'non-UNKNOWN rows unchanged by rejection or stale operator SQL');
  assert.deepEqual(after.find(r => r.id === ids.UNKNOWN), before.find(r => r.id === ids.UNKNOWN), 'rejection never closes UNKNOWN');
}

// 4d. Digest counts are exact beyond the 50 listed ids.
{
  const { db, env } = fresh();
  const u = await account(env, 'many'), now = new Date().toISOString();
  for (let i = 0; i < 73; i++) db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,last_error)VALUES(?,?,'UNKNOWN',?,?,'UPSTREAM_OUTCOME_UNKNOWN')").run('u' + String(i).padStart(3, '0'), u.user.id, now, now);
  const digest = await runOperationalDigest({ ...env, OPS_ALERT_EMAIL: 'ops@example.test' }, Date.now());
  const unknown = digest.findings.find(f => f.code === 'AI_WORK_UNKNOWN');
  assert.equal(unknown.count, 73); assert.equal(unknown.workIds.length, 50);
}

// 5. Scheduling: the digest has its own trigger; the minute purge and 15-minute maintenance triggers are unchanged.
{
  const { db, env } = fresh();
  const stamp = new Date().toISOString();
  db.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at,account_status,purge_at)VALUES('due','due@example.test','h','s',?,'PENDING_DELETION',?)").run(stamp, new Date(Date.now() - 1).toISOString());
  let task; db.resetMetrics(); mails = [];
  await worker.scheduled({ cron: OPS_DIGEST_CRON, scheduledTime: Date.now() }, { ...env, OPS_ALERT_EMAIL: 'ops@example.test' }, { waitUntil(p) { task = p; } }); await task;
  assert.equal(db.rows("SELECT id FROM users WHERE id='due'").length, 1, 'digest invocation never purges');
  assert.ok(!db.trace.some(r => /^\s*(UPDATE|DELETE|INSERT)/i.test(r.sql)), 'digest is read-only');
  assert.ok(db.metrics.queries <= 5, `digest query budget ${db.metrics.queries}`);
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, { waitUntil(p) { task = p; } }); await task;
  assert.equal(db.rows("SELECT id FROM users WHERE id='due'").length, 0, 'minute trigger still purges');
  const clear = await runOperationalDigest({ ...env, OPS_ALERT_EMAIL: 'ops@example.test' }, Date.now()); mails = [];
  assert.deepEqual(clear.findings, []); assert.equal(mails.length, 0, 'clear digest sends nothing');
}

// 6. Capacity evidence: D1 statements + outbound subrequests per purge invocation by account shape (Workers Paid gate).
{
  const rows = [];
  for (const n of [0, 1, 3, 10, 30]) {
    const { db, env } = fresh();
    const u = await (await call(env, '/api/auth/register', null, { email: `cap${n}@example.test`, password: 'fixture-password' })).json();
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      db.raw.prepare("INSERT INTO import_jobs(id,user_id,status,source_json,normalized_document_json,attempts,created_at,updated_at,openai_response_id)VALUES(?,?,'done','{}','{}',1,?,?,?)").run('j' + i, u.user.id, now, now, 'resp_job' + i);
      db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id)VALUES(?,?,'RETURNED',?,?,?)").run('w' + i, u.user.id, now, now, 'resp_work' + i);
    }
    db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',purge_at=? WHERE id=?").run(new Date(Date.now() - 1).toISOString(), u.user.id);
    openaiDeletes = []; db.resetMetrics(); await purgeDueAccounts(env);
    assert.equal(db.rows('SELECT id FROM users WHERE id=?', u.user.id).length, 0);
    rows.push({ storedResponses: n, d1: db.metrics.queries, fetch: openaiDeletes.length, total: db.metrics.queries + openaiDeletes.length });
  }
  for (const r of rows) assert.ok(r.d1 <= 1000 && r.total <= 10000, 'within Workers Paid per-invocation limits');
  assert.ok(rows.some(r => r.total > 50), 'Free plan (50 subrequests) cannot purge AI-import accounts: Paid is a release precondition');
  console.log(JSON.stringify({ purgeBudget: rows }));
}

console.log('Ops release safety PASS: 4xx/5xx/network/unreadable classification + work-id correlation; DELETE_NOW refusal without state change; UNKNOWN blocks purge; digest routing without personal identifiers; operator absent/found reconciliation; isolated digest trigger; purge capacity evidence.');
