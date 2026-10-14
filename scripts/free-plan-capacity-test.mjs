// Build 44 Free-plan purge: real Worker code on real SQLite (repository migrations) with the Workers Free per-invocation
// limits enforced separately (D1: 50 queries, every batch statement counted; external fetch: 50). Covers bounded,
// durable, idempotent upstream cleanup; final-erase gate; interruption/retry; races; UNKNOWN fail-closed; Apple revoke
// failures; superseded import responses; daily D1 write budgets; statistics-free query plans.
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createD1 } from './lib/d1-sqlite.mjs';
import { purgeDueAccounts } from '../worker/account-lifecycle.js';
import { sealProviderToken, oauthConfig, tokenDigest } from '../worker/account-api.js';
import { runOperationalDigest } from '../worker/ops-alerts.js';
import { PURGE_UPSTREAM_DELETES, PURGE_DAILY_ROWS_WRITTEN, MAINTENANCE_DAILY_ROWS_WRITTEN } from '../worker/free-plan-limits.js';

const FREE = { d1: 50, fetch: 50 }, MARGIN = { d1: 40, fetch: 40 };
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64');
const APPLE_KEY = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

// ---- Per-invocation counters and network fakes.
const inv = { d1: 0, fetch: 0, enforce: false };
const net = { deleted: new Set(), calls: [], openai: () => null, apple: () => new Response(null, { status: 200 }), revokes: 0, mails: [] };
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target === 'https://cpaas.zoho.eu/v1.1/email') { net.mails.push(JSON.parse(init.body)); return new Response('{}'); }
  inv.fetch++;
  if (inv.enforce && inv.fetch > FREE.fetch) throw new Error('Too many subrequests.');
  if (target.startsWith('https://api.openai.com/v1/responses/') && init.method === 'DELETE') {
    const id = target.split('/').pop(); net.calls.push(id);
    const forced = net.openai(id); if (forced) return forced();
    const fresh = !net.deleted.has(id); net.deleted.add(id);
    return new Response('{}', { status: fresh ? 200 : 404 });
  }
  if (target === 'https://api.openai.com/v1/responses' && init.method === 'POST') return net.create();
  if (target === 'https://appleid.apple.com/auth/revoke') { net.revokes++; return net.apple(); }
  throw new Error('unexpected fetch ' + target);
};
function limited(db) {
  const tick = n => { inv.d1 += n; if (inv.enforce && inv.d1 > FREE.d1) throw new Error('D1_ERROR: Too many API requests by single worker invocation.'); };
  const wrap = st => ({ ...st, bind: (...v) => wrap(st.bind(...v)), first: (...a) => { tick(1); return st.first(...a); }, all: (...a) => { tick(1); return st.all(...a); }, run: (...a) => { tick(1); return st.run(...a); }, inner: st });
  return { ...db, prepare: sql => wrap(db.prepare(sql)), batch: items => { tick(items.length); return db.batch(items.map(item => item.inner || item)); } };
}
function fresh(options) {
  const db = createD1(options);
  const env = { DB: limited(db), ZEPTOMAIL_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture', ASSETS: { fetch: async () => new Response('') },
    APPLE_OAUTH_CLIENT_ID: 'com.reptrio.signin', APPLE_OAUTH_TEAM_ID: 'TEAM123456', APPLE_OAUTH_KEY_ID: 'KEY1234567', APPLE_OAUTH_PRIVATE_KEY: APPLE_KEY };
  return { db, env };
}
const call = (env, path, token, payload) => worker.fetch(new Request('https://api.reptrio.com' + path, { method: payload === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), env, { waitUntil() {} });
async function owner(db, env, tag, { provider = 'email', stored = 0, returned = 0 } = {}) {
  inv.enforce = false;
  const r = await call(env, '/api/auth/register', null, { email: `${tag}@example.test`, password: 'fixture-password' }); assert.equal(r.status, 201);
  const u = await r.json(), now = new Date().toISOString();
  if (provider !== 'email') {
    const sub = `${provider}-${tag}`;
    db.raw.prepare('INSERT INTO oauth_accounts(provider,provider_subject,user_id,email,created_at,last_login_at) VALUES (?,?,?,?,?,?)').run(provider, sub, u.user.id, `${tag}@example.test`, now, now);
    if (provider === 'apple') db.raw.prepare('UPDATE oauth_accounts SET refresh_token_ciphertext=? WHERE provider=? AND provider_subject=?').run(await sealProviderToken(oauthConfig(env, 'apple'), 'apple', sub, 'refresh-' + tag), 'apple', sub);
    db.raw.prepare('UPDATE users SET credential_origin=? WHERE id=?').run(provider.toUpperCase(), u.user.id);
  }
  for (let i = 0; i < stored; i++) {
    db.raw.prepare("INSERT INTO import_jobs(id,user_id,status,source_json,normalized_document_json,attempts,created_at,updated_at,openai_response_id) VALUES (?,?,'done','{}','{}',1,?,?,?)").run(`${tag}-j${i}`, u.user.id, now, now, `resp_${tag}_${i}`);
    db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id) VALUES (?,?,'RESOLVED',?,?,?)").run(`${tag}-w${i}`, u.user.id, now, now, `resp_${tag}_${i}`);
  }
  for (let i = 0; i < returned; i++) db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id) VALUES (?,?,'RETURNED',?,?,?)").run(`${tag}-r${i}`, u.user.id, now, now, `resp_${tag}_r${i}`);
  return { ...u, ids: [...Array(stored).keys()].map(i => `resp_${tag}_${i}`).concat([...Array(returned).keys()].map(i => `resp_${tag}_r${i}`)) };
}
const due = (db, u) => db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',purge_at=? WHERE id=?").run(new Date(Date.now() - 1).toISOString(), u.user.id);
const exists = (db, u) => db.rows('SELECT 1 FROM users WHERE id=?', u.user.id).length > 0;
const leftovers = (db, id) => db.rows("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%user_id%'").map(t => t.name).filter(t => db.rows(`SELECT COUNT(*) n FROM ${t} WHERE user_id=?`, id)[0].n);
const footprint = (db, id) => JSON.stringify(db.rows("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%user_id%' ORDER BY name").map(t => [t.name, db.rows(`SELECT * FROM ${t.name} WHERE user_id=? ORDER BY rowid`, id)]));
// One minute-cron invocation under Free limits; the erase invariant is checked after every step.
async function minute(db, env, u, stats) {
  inv.d1 = 0; inv.fetch = 0; inv.enforce = true;
  const cpu0 = process.cpuUsage(); await purgeDueAccounts(env); const cpu = process.cpuUsage(cpu0);
  inv.enforce = false; (stats.cpuMs ||= []).push((cpu.user + cpu.system) / 1000);
  stats.invocations++; stats.maxD1 = Math.max(stats.maxD1, inv.d1); stats.maxFetch = Math.max(stats.maxFetch, inv.fetch);
  if (!exists(db, u)) {
    const missing = u.ids.filter(id => !net.deleted.has(id));
    assert.deepEqual(missing, [], 'an account is erased only after every stored upstream response was confirmed deleted');
    assert.deepEqual(leftovers(db, u.user.id), [], 'final erase leaves no owner rows');
  }
}
async function drain(db, env, u, max = 30, stats = { invocations: 0, maxD1: 0, maxFetch: 0 }) {
  while (exists(db, u) && stats.invocations < max) await minute(db, env, u, stats);
  return stats;
}
const resetNet = () => { net.deleted.clear(); net.calls = []; net.openai = () => null; net.apple = () => new Response(null, { status: 200 }); net.revokes = 0; };

// 1. Matrix: stored responses x provider. Bounded steps, every response deleted once, margins kept, bystander intact.
const matrix = [];
for (const provider of ['email', 'google', 'apple']) for (const n of [0, 1, 3, 10, 30, 49, 50, 100, 300]) {
  const { db, env } = fresh(); resetNet();
  const bystander = await owner(db, env, `by-${provider}${n}`, { stored: 2 }), keep = footprint(db, bystander.user.id);
  const u = await owner(db, env, `${provider}${n}`, { provider, stored: n }); due(db, u);
  const stats = await drain(db, env, u);
  assert.ok(!exists(db, u), `${provider}/${n} erased`);
  assert.equal(stats.invocations, Math.ceil(n / PURGE_UPSTREAM_DELETES) + 1, `${provider}/${n} invocations`);
  assert.ok(stats.maxD1 <= MARGIN.d1 && stats.maxFetch <= MARGIN.fetch, `${provider}/${n} d1=${stats.maxD1} fetch=${stats.maxFetch}`);
  assert.equal(net.calls.length, n, 'no repeated upstream delete without a failure');
  assert.equal(net.revokes, provider === 'apple' ? 1 : 0);
  assert.equal(footprint(db, bystander.user.id), keep, 'bystander untouched');
  // Local Node CPU incl. in-process SQLite (D1 executes SQL outside the Worker): informational only, NOT Cloudflare CPU.
  const cpu = stats.cpuMs.slice().sort((a, b) => a - b);
  matrix.push({ provider, stored: n, invocations: stats.invocations, maxD1: stats.maxD1, maxFetch: stats.maxFetch, localCpuMsMedian: +cpu[cpu.length >> 1].toFixed(2), localCpuMsMax: +cpu.at(-1).toFixed(2) });
}

// 2. Upstream failures inside a step: confirmed deletes persist; failure backs off; no false success; retry completes.
for (const mode of ['5xx', 'timeout', 'network', '404']) {
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'fail-' + mode, { stored: 12 }); due(db, u);
  let calls = 0;
  // 404 = the object is already absent upstream: a valid proof that nothing remains.
  net.openai = id => {
    if (mode === '404') return () => { net.deleted.add(id); return new Response('', { status: 404 }); };
    if (++calls !== 6) return null;
    if (mode === '5xx') return () => new Response('', { status: 503 });
    if (mode === 'timeout') return () => { throw new DOMException('timeout', 'TimeoutError'); };
    return () => { throw new TypeError('fetch failed'); };
  };
  const stats = { invocations: 0, maxD1: 0, maxFetch: 0 };
  await minute(db, env, u, stats);
  const row = db.rows('SELECT account_status,purge_error,purge_retry_at FROM users WHERE id=?', u.user.id)[0];
  if (mode === '404') { assert.equal(row.purge_error, 'ACCOUNT_PURGE_IN_PROGRESS', '404 = already absent, counted as deleted'); }
  else {
    assert.equal(row.account_status, 'PURGING'); assert.equal(row.purge_error, 'OPENAI_CLEANUP_FAILED'); assert.ok(row.purge_retry_at, 'failure backs off');
    assert.equal(db.rows("SELECT COUNT(*) n FROM account_lifecycle_work WHERE user_id=? AND state='RESOLVED' AND id LIKE 'adopt-%'", u.user.id)[0].n, 5, 'the 5 confirmed deletes are durable');
    net.openai = () => null; db.raw.prepare('UPDATE users SET purge_retry_at=NULL WHERE id=?').run(u.user.id);
  }
  await drain(db, env, u, 30, stats);
  assert.ok(!exists(db, u));
  if (mode !== '404') assert.equal(net.calls.filter(id => id === net.calls[0]).length, 1, 'confirmed delete never repeated');
}

// 3. Interruption after every important step, then re-run: never data loss, never erase with an upstream object left.
for (const point of ['adopt', 'resolve', 'progress', 'final']) {
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'crash-' + point, { stored: 7, returned: 2 }); due(db, u);
  const pattern = { adopt: /INSERT INTO account_lifecycle_work\(id,user_id,state,response_id,created_at,expires_at,import_job_id\) SELECT 'adopt-/, resolve: /UPDATE account_lifecycle_work SET state='RESOLVED',last_error=NULL WHERE user_id=\? AND state='RETURNED' AND id IN/, progress: /purge_error='ACCOUNT_PURGE_IN_PROGRESS'/, final: /DELETE FROM users WHERE id=\?/ }[point];
  db.setFailOn(pattern);
  const stats = { invocations: 0, maxD1: 0, maxFetch: 0 };
  await minute(db, env, u, stats); if (point === 'final') await minute(db, env, u, stats);
  assert.ok(exists(db, u), `crash at ${point} never erases`);
  assert.equal(db.rows('SELECT account_status FROM users WHERE id=?', u.user.id)[0].account_status, 'PURGING');
  db.setFailOn(null);
  // Lease of the crashed step expires (simulated) and backoff is over.
  db.raw.prepare('UPDATE users SET purge_lease_until=NULL,purge_retry_at=NULL WHERE id=?').run(u.user.id);
  await drain(db, env, u, 30, stats);
  assert.ok(!exists(db, u), `recovers after crash at ${point}`);
  assert.deepEqual(u.ids.filter(id => !net.deleted.has(id)), []);
}

// 3b. Final-erase gate at the database: a stored response id appearing after the step's pending check blocks erasure.
{
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'gate'); due(db, u);
  db.setBeforeBatch(statements => { if (statements.some(st => st.sql.startsWith('DELETE FROM users'))) { db.setBeforeBatch(null); db.raw.prepare("INSERT INTO import_jobs(id,user_id,status,source_json,normalized_document_json,attempts,created_at,updated_at,openai_response_id) VALUES ('late',?,'done','{}','{}',1,?,?,'resp_gate_late')").run(u.user.id, new Date().toISOString(), new Date().toISOString()); } });
  const stats = { invocations: 0, maxD1: 0, maxFetch: 0 };
  inv.d1 = 0; inv.fetch = 0; await purgeDueAccounts(env);
  assert.ok(exists(db, u), 'erase refused while an upstream object is still referenced');
  assert.equal(db.rows('SELECT purge_error FROM users WHERE id=?', u.user.id)[0].purge_error, 'ACCOUNT_PURGE_LEASE_LOST');
  db.raw.prepare('UPDATE users SET purge_retry_at=NULL WHERE id=?').run(u.user.id); u.ids = ['resp_gate_late'];
  await drain(db, env, u, 5, stats); assert.ok(!exists(db, u)); assert.ok(net.deleted.has('resp_gate_late'));
}

// 4. D1 fault at every statement of one step (incl. platform limit exceptions): invariants hold, retry completes.
{
  const { db: probe, env: probeEnv } = fresh(); resetNet();
  const p = await owner(probe, probeEnv, 'probe', { stored: 3 }); due(probe, p); probe.resetMetrics(); await purgeDueAccounts(probeEnv);
  const upstreamStep = probe.trace.map(t => t.sql);
  for (let k = 0; k < upstreamStep.length; k++) {
    const { db, env } = fresh(); resetNet();
    const u = await owner(db, env, 'fault' + k, { stored: 3 }); due(db, u);
    let seen = 0; db.setFailOn(null);
    const original = db.prepare; let armed = true;
    env.DB = limited({ ...db, prepare: sql => { const st = original(sql); if (armed && seen++ === k) { armed = false; return { ...st, bind: () => ({ first: async () => { throw new Error('D1_ERROR: injected'); }, all: async () => { throw new Error('D1_ERROR: injected'); }, run: async () => { throw new Error('D1_ERROR: injected'); } }), first: async () => { throw new Error('D1_ERROR: injected'); }, all: async () => { throw new Error('D1_ERROR: injected'); }, run: async () => { throw new Error('D1_ERROR: injected'); } }; } return st; } });
    const stats = { invocations: 0, maxD1: 0, maxFetch: 0 };
    await minute(db, env, u, stats);
    db.raw.prepare('UPDATE users SET purge_lease_until=NULL,purge_retry_at=NULL WHERE id=?').run(u.user.id);
    await drain(db, env, u, 30, stats);
    assert.ok(!exists(db, u), `fault at statement ${k} recovers`);
  }
}

// 5. Races: two concurrent cron invocations on one owner; DELETE_NOW request racing a cron step; lease takeover.
{
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'race', { stored: 45 }); due(db, u);
  let release; const gate = new Promise(r => { release = r; });
  net.openai = () => async () => { await gate; return null; };
  net.openai = id => () => gate.then(() => { const freshId = !net.deleted.has(id); net.deleted.add(id); return new Response('{}', { status: freshId ? 200 : 404 }); });
  const a = purgeDueAccounts(env), b = purgeDueAccounts(env);
  await new Promise(r => setTimeout(r, 20)); release(); await Promise.all([a, b]);
  assert.equal(new Set(net.calls).size, net.calls.length, 'only one invocation holds the owner lease');
  // Lease takeover: holder's lease expires mid-step; a second invocation acquires; the stale holder cannot erase.
  net.openai = () => null;
  db.raw.prepare('UPDATE users SET purge_lease_until=NULL WHERE id=?').run(u.user.id);
  await drain(db, env, u);
  assert.ok(!exists(db, u));
  assert.deepEqual(u.ids.filter(id => !net.deleted.has(id)), []);
}
{
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'dn-race', { stored: 2 });
  await call(env, '/api/auth/delete/request-link', u.sessionToken, {});
  const link = /#token=([\w-]{43})/.exec(net.mails.at(-1).textbody)[1];
  const { proof } = await (await call(env, '/api/auth/delete/verify-link', u.sessionToken, { token: link })).json();
  const [reply] = await Promise.all([call(env, '/api/auth/delete', u.sessionToken, { proof, confirm: 'DELETE', method: 'DELETE_NOW' }), purgeDueAccounts(env)]);
  assert.equal(reply.status, 202); const body = await reply.json();
  assert.deepEqual([body.accountStatus, body.purgeComplete], ['PURGING', false], 'accepted, never reported complete');
  assert.equal((await call(env, '/api/me', u.sessionToken)).status, 401, 'sessions revoked at acceptance');
  await drain(db, env, u); assert.ok(!exists(db, u));
}

// 6. UNKNOWN / RUNNING stay fail-closed: no adoption or erase can bypass them.
for (const state of ['UNKNOWN', 'RUNNING']) {
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'open-' + state.toLowerCase(), { stored: 3 });
  db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at) VALUES (?,?,?,?,?)").run('open-' + state, u.user.id, state, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
  due(db, u); const stats = await drain(db, env, u, 5);
  assert.ok(exists(db, u)); assert.equal(net.calls.length, 0, 'no upstream effect while an outcome is open');
  assert.equal(db.rows('SELECT purge_error FROM users WHERE id=?', u.user.id)[0].purge_error, 'ACCOUNT_PURGE_UPSTREAM_UNRESOLVED');
  assert.equal(db.rows('SELECT COUNT(*) n FROM import_jobs WHERE user_id=? AND openai_response_id IS NOT NULL', u.user.id)[0].n, 3, 'stored ids untouched');
  assert.ok(stats.invocations >= 1);
}

// 7. Apple revoke failures block only the final step; never revoked during upstream steps.
for (const mode of ['network', 'server', 'invalid_grant']) {
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'apple-' + mode, { provider: 'apple', stored: 41 }); due(db, u);
  net.apple = mode === 'network' ? () => { throw new TypeError('fetch failed'); } : mode === 'server' ? () => new Response('', { status: 503 }) : () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  const stats = { invocations: 0, maxD1: 0, maxFetch: 0 };
  await minute(db, env, u, stats); await minute(db, env, u, stats);
  assert.equal(net.revokes, 0, 'no Apple revoke during upstream cleanup');
  await minute(db, env, u, stats);
  assert.equal(net.revokes, 1); assert.ok(exists(db, u));
  assert.equal(db.rows('SELECT purge_error FROM users WHERE id=?', u.user.id)[0].purge_error, mode === 'invalid_grant' ? 'APPLE_REAUTH_REQUIRED' : 'APPLE_REVOKE_FAILED');
  net.apple = () => new Response(null, { status: 200 }); db.raw.prepare('UPDATE users SET purge_retry_at=NULL WHERE id=?').run(u.user.id);
  await drain(db, env, u, 5, stats); assert.ok(!exists(db, u));
}

// 8. Superseded import responses (re-upload of the same import id; concurrent publication) stay in the ledger.
{
  const { db, env } = fresh(); resetNet();
  const u = await owner(db, env, 'supersede');
  inv.enforce = false;
  assert.equal((await call(env, '/api/privacy/ai-import/consent', u.sessionToken, { action: 'grant', policyVersion: 'ai_import_openai_document_v1' })).status, 200);
  let next = 0; net.create = () => new Response(JSON.stringify({ id: `resp_supersede_${next++}`, status: 'queued' }), { headers: { 'Content-Type': 'application/json' } });
  const upload = () => { const form = new FormData(); form.set('importId', 'same-job'); form.set('normalizedDocument', JSON.stringify({ fileName: 'r.pdf', fileType: 'pdf', blocks: [{ type: 'paragraph', text: 'Squat 3x10' }] })); form.set('file', new Blob(['%PDF-fixture'], { type: 'application/pdf' }), 'r.pdf'); return worker.fetch(new Request('https://api.reptrio.com/api/import/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + u.sessionToken }, body: form }), env, { waitUntil() {} }); };
  assert.equal((await upload()).status, 202); assert.equal((await upload()).status, 202);
  // Two concurrent uploads of the same import id: both OpenAI creates are held until both started, then answered in
  // order, so the second publication meets the first one's response id.
  const held = []; let started; const bothStarted = new Promise(r => { started = r; });
  net.create = () => new Promise(resolve => { held.push(resolve); if (held.length === 2) started(); });
  const pa = upload(), pb = upload(); await bothStarted;
  held[0](new Response(JSON.stringify({ id: `resp_supersede_${next++}`, status: 'queued' }), { headers: { 'Content-Type': 'application/json' } }));
  await new Promise(r => setTimeout(r, 10));
  held[1](new Response(JSON.stringify({ id: `resp_supersede_${next++}`, status: 'queued' }), { headers: { 'Content-Type': 'application/json' } }));
  const [a, b] = await Promise.all([pa, pb]); assert.equal(a.status, 202); assert.equal(b.status, 202);
  const current = db.rows("SELECT openai_response_id FROM import_jobs WHERE user_id=? AND id='same-job'", u.user.id)[0].openai_response_id;
  const ledger = db.rows("SELECT response_id,import_job_id FROM account_lifecycle_work WHERE user_id=? AND state='RETURNED' ORDER BY response_id", u.user.id);
  const created = [...Array(next).keys()].map(i => `resp_supersede_${i}`);
  assert.deepEqual([...ledger.map(r => r.response_id), current].sort(), created.sort(), 'every created response is referenced exactly once (ledger or job)');
  assert.ok(ledger.every(r => r.import_job_id === 'same-job'), 'ledger rows keep their import job');
  u.ids = created; due(db, u); await drain(db, env, u);
  assert.ok(!exists(db, u)); assert.deepEqual(created.filter(id => !net.deleted.has(id)), [], 'superseded responses deleted at purge');
}

// 9. Daily D1 write budgets: oversized account is held (not erased, alerted); spent budget resumes next UTC day;
//    maintenance never charges past its cap.
{
  const { db, env } = fresh(); resetNet();
  const big = await owner(db, env, 'big'); const now = new Date().toISOString();
  // 13,000 sets x (1 + 1 index) = 26,000 estimated rows written > the 25,000/day purge cap.
  const set = db.raw.prepare("INSERT INTO workout_sets(id,user_id,session_id,payload_json,created_at,updated_at) VALUES (?,?,'s','{}',?,?)");
  db.raw.exec('BEGIN'); for (let i = 0; i < 13000; i++) set.run(`big-${i}`, big.user.id, now, now); db.raw.exec('COMMIT');
  due(db, big); await drain(db, env, big, 3);
  assert.ok(exists(db, big), 'an account beyond the per-day write cap is never partially erased');
  assert.equal(db.rows('SELECT purge_error FROM users WHERE id=?', big.user.id)[0].purge_error, 'ACCOUNT_PURGE_PLAN_CAPACITY');
  const digest = await runOperationalDigest({ ...env, DB: db }, Date.now() + 2 * 3600000);
  assert.ok(digest.findings.find(f => f.code === 'ACCOUNT_PURGE_OVERDUE')?.errors.includes('ACCOUNT_PURGE_PLAN_CAPACITY'), 'held account is alerted');
  // Spent purge budget: the next owner waits for the next UTC day instead of exceeding it.
  const day = now.slice(0, 10); db.raw.prepare("INSERT INTO d1_write_budget(day,scope,rows_written) VALUES (?,'purge',?)").run(day, PURGE_DAILY_ROWS_WRITTEN);
  const late = await owner(db, env, 'late'); due(db, late); await drain(db, env, late, 2);
  const lateRow = db.rows('SELECT purge_error,purge_retry_at FROM users WHERE id=?', late.user.id)[0];
  assert.ok(exists(db, late)); assert.equal(lateRow.purge_error, 'ACCOUNT_PURGE_DAILY_BUDGET');
  assert.equal(lateRow.purge_retry_at.slice(11), '00:00:00.000Z', 'resumes at the next UTC day');
  assert.ok(db.rows("SELECT rows_written FROM d1_write_budget WHERE day=? AND scope='purge'", day)[0].rows_written <= PURGE_DAILY_ROWS_WRITTEN);
  db.raw.prepare("UPDATE d1_write_budget SET rows_written=0 WHERE scope='purge'").run(); db.raw.prepare('UPDATE users SET purge_retry_at=NULL WHERE id=?').run(late.user.id);
  await drain(db, env, late, 3); assert.ok(!exists(db, late));
  // Maintenance: a large expired-receipt backlog is cleaned without ever charging beyond the cap.
  db.raw.exec('BEGIN'); for (let i = 0; i < 9000; i++) db.raw.prepare("INSERT INTO sync_mutation_receipts VALUES(?,?,'h','p',0,1,'{}',?,?)").run(big.user.id, 'rcpt-' + i, now, new Date(Date.now() - 1000).toISOString()); db.raw.exec('COMMIT');
  db.raw.prepare("INSERT INTO d1_write_budget(day,scope,rows_written) VALUES (?,'maintenance',?)").run(day, MAINTENANCE_DAILY_ROWS_WRITTEN - 2000);
  for (let i = 0; i < 6; i++) { let task; await worker.scheduled({ cron: '*/15 * * * *' }, { ...env, DB: db }, { waitUntil(p) { task = p; } }); await task; }
  assert.ok(db.rows("SELECT rows_written FROM d1_write_budget WHERE day=? AND scope='maintenance'", day)[0].rows_written <= MAINTENANCE_DAILY_ROWS_WRITTEN, 'maintenance cap never exceeded');
  assert.ok(db.rows('SELECT COUNT(*) n FROM sync_mutation_receipts WHERE user_id=?', big.user.id)[0].n > 0, 'backlog deferred, not forced');
}

// 10. Statistics-free query plans (no ANALYZE): cron and digest statements never scan growing tables.
{
  const { db, env } = fresh(); const now = new Date().toISOString(), past = new Date(Date.now() - 86400000).toISOString();
  db.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES ('grow','grow@example.test','x','x',?)").run(now);
  db.raw.exec('BEGIN');
  for (let i = 0; i < 3000; i++) db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id) VALUES (?,?,'RESOLVED',?,?,?)").run('g' + i, 'grow', now, past, 'resp_g' + i);
  for (let op = 0; op < 30; op++) {
    db.raw.prepare("INSERT INTO personal_restore_operations(user_id,operation_id,purpose,source_namespace,archive_retry_hash,local_binding,data_schema_version,expected_chunks,expected_counts_json,base_revision,state,expires_at,created_at,updated_at) VALUES ('grow',?,'RESTORE','n','h','b',8,1,'{}',0,'COMMITTED',?,?,?)").run('op' + op, past, now, now);
    db.raw.prepare("INSERT INTO personal_restore_roots(user_id,operation_id,root_id,root_kind,source_tuple,source_ordinal,portable_hash,counts_json) VALUES ('grow',?,0,'session','t',0,'h','{}')").run('op' + op);
    for (let r = 0; r < 100; r++) db.raw.prepare("INSERT INTO personal_restore_records(user_id,operation_id,root_id,item_ordinal,kind,record_key,ordinal,address_json,payload_json,source_tuple,portable_hash) VALUES ('grow',?,0,?,'set',?,?,'{}','{}',?,'h')").run('op' + op, r, 'k' + r, r, 't' + r);
  }
  db.raw.exec('COMMIT');
  assert.equal(db.rows("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")[0].n, 0, 'no planner statistics');
  const growing = ['import_jobs', 'sync_records', 'workout_sets', 'workout_sessions', 'user_data', 'programs', 'auth_sessions', 'oauth_accounts', 'account_lifecycle_work', 'account_lifecycle_credentials', 'oauth_reauth_tickets', 'personal_restore_records', 'personal_restore_roots', 'personal_restore_chunks', 'personal_restore_operations', 'sync_mutation_receipts', 'users'];
  const scans = [];
  // A due owner with stored responses, so the minute traces include both purge steps (upstream + final erase).
  const victim = await owner(db, env, 'plan-victim', { stored: 2 }); due(db, victim); resetNet();
  for (const [name, run] of [['minute', () => purgeDueAccounts({ ...env, DB: db })], ['minute-final', () => purgeDueAccounts({ ...env, DB: db })], ['maintenance', async () => { let t; await worker.scheduled({ cron: '*/15 * * * *' }, { ...env, DB: db }, { waitUntil(p) { t = p; } }); await t; }], ['digest', () => runOperationalDigest({ ...env, DB: db }, Date.now())]]) {
    db.resetMetrics(); await run();
    for (const { sql } of db.trace) {
      if (/^\s*PRAGMA/i.test(sql) || /sqlite_master/.test(sql)) continue;
      const plan = db.raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array((sql.match(/\?/g) || []).length).fill('x')).map(r => r.detail);
      for (const step of plan) { const m = /^SCAN (\w+)(?: AS \w+)?/.exec(step); const table = m && (growing.includes(m[1]) ? m[1] : null); if (table && !/USING (?:COVERING )?INDEX personal_restore_(?:cleanup|sync)_due/.test(step)) scans.push(`${name}: ${step} :: ${sql.slice(0, 80)}`); }
    }
  }
  assert.ok(!exists(db, victim), 'purge statements were exercised');
  assert.deepEqual(scans, [], 'no full scan of a growing table in cron/digest/purge paths');
}

console.log(JSON.stringify({ freePlanMatrix: matrix }));
console.log('Free-plan purge PASS: 0-300 stored responses x email/Google/Apple within 40/40 per invocation; durable idempotent upstream progress; crash/fault at every step; cron/DELETE_NOW/lease races; UNKNOWN/RUNNING fail-closed; Apple revoke failures; superseded responses tracked; daily D1 write budgets; statistics-free cron plans.');
