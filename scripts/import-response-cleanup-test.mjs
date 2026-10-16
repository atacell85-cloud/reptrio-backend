// B46-03 (Option C): the stored OpenAI response of a completed background import is deleted right after its preview is
// persisted. Routed Worker + real SQLite (scripts/lib/d1-sqlite.mjs) with the repository migrations; OpenAI is a local
// fake. Covers: still-running jobs untouched, done preview + ledger row + id removal in ONE batch, delete 200/404,
// failure kept RETURNED with a retry time, the 15-minute retry (one per invocation, ACTIVE owners only, budget charged),
// concurrent polls (one ledger row, one delete), an injected batch failure (nothing untracked), failed jobs untouched,
// unchanged user-visible preview, and account deletion still erasing a not-yet-deleted response.
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createD1 } from './lib/d1-sqlite.mjs';
import { purgeDueAccounts, IMPORTED_RESPONSE_RETRY_MS } from '../worker/account-lifecycle.js';
import { MAINTENANCE_DAILY_ROWS_WRITTEN } from '../worker/free-plan-limits.js';

const POLICY = 'ai_import_openai_document_v1';
const ref = { page: null, sheet: null, cellRange: null, text: null };
const prescription = { sets: 3, setsText: '3', repsMin: 10, repsMax: 10, repsText: '3x10', weight: null, weightUnit: null, weightText: null, rir: null, rirText: null, rpe: null, rpeText: null, restSeconds: null, restText: null, tempo: null, tempoText: null, durationSeconds: null, durationText: null, distanceMeters: null, distanceText: null, side: null, sideText: null };
const preview = { schemaVersion: '1.1', importId: 'x', importedAt: '2026-10-17T00:00:00.000Z', source: { fileName: 'r.pdf', fileType: 'pdf', language: 'en', documentTitle: null }, program: { id: null, name: 'Fixture program', description: null, sourceType: 'pdf-import', notes: null, days: [{ name: 'Day A', order: 1, notes: null, sourceReference: ref, sections: [{ title: 'Main', sectionType: 'strength', order: 1, notes: null, sourceReference: ref, items: [{ itemType: 'exercise', order: 1, sourceExerciseName: 'Squat', normalizedExerciseName: 'Squat', exerciseMatch: null, notes: null, sourceReference: ref, prescription }] }] }] }, warnings: [], unparsedContent: [] };

// ---- OpenAI fake: create (background), retrieve (per-id status), delete (programmable reply).
const net = { creates: 0, deletes: [], retrieves: 0, status: {}, output: () => JSON.stringify(preview), deleteReply: () => new Response('{}'), retrieveGate: null, deleteGate: null, nextId: 0 };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const ok = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://cpaas.zoho.eu/v1.1/email') { net.mail = JSON.parse(init.body); return new Response('{}'); }
  if (url === 'https://api.openai.com/v1/responses' && init.method === 'POST') { net.creates++; const id = `resp_fixture${++net.nextId}`; net.status[id] = 'in_progress'; return ok({ id, status: 'queued' }); }
  const id = url.split('/').pop();
  if (url.startsWith('https://api.openai.com/v1/responses/') && init.method === 'DELETE') { net.deletes.push(id); if (net.deleteGate) await net.deleteGate; return net.deleteReply(id); }
  if (url.startsWith('https://api.openai.com/v1/responses/')) {
    net.retrieves++; if (net.retrieveGate) await net.retrieveGate;
    const status = net.status[id];
    return ok(status === 'completed' ? { id, status, model: 'gpt-4.1-mini', output_text: net.output(), usage: {} } : { id, status });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const fresh = options => { const db = createD1(options); return { db, env: { DB: db, OPENAI_API_KEY: 'fixture', ZEPTOMAIL_API_KEY: 'fixture', ASSETS: { fetch: () => new Response('') } } }; };
const waits = [];
const ctx = { waitUntil: promise => waits.push(promise) };
const settle = async () => { while (waits.length) await waits.shift(); };
const call = (env, path, token, payload) => worker.fetch(new Request('https://api.reptrio.com' + path, { method: payload === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), env, ctx);
async function account(env, tag) {
  const r = await call(env, '/api/auth/register', null, { email: tag + '@example.test', password: 'fixture-password' }); assert.equal(r.status, 201);
  const u = await r.json();
  assert.equal((await call(env, '/api/privacy/ai-import/consent', u.sessionToken, { action: 'grant', policyVersion: POLICY })).status, 200);
  return u;
}
async function upload(env, u, importId) {
  const form = new FormData(); form.set('importId', importId); form.set('normalizedDocument', JSON.stringify({ fileName: 'r.pdf', fileType: 'pdf', blocks: [{ type: 'paragraph', text: 'Squat 3x10' }] })); form.set('file', new Blob(['%PDF-fixture'], { type: 'application/pdf' }), 'r.pdf');
  const r = await worker.fetch(new Request('https://api.reptrio.com/api/import/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + u.sessionToken }, body: form }), env, ctx);
  assert.equal(r.status, 202);
  return job(env.DB, u, importId).openai_response_id;
}
const poll = async (env, u, importId) => { const r = await call(env, `/api/import/jobs/${importId}`, u.sessionToken); assert.equal(r.status, 200); return r.json(); };
const job = (db, u, id) => db.rows('SELECT status,openai_response_id,preview_json FROM import_jobs WHERE user_id=? AND id=?', u.user.id, id)[0];
const ledger = (db, u) => db.rows("SELECT id,state,response_id,last_error,expires_at,import_job_id FROM account_lifecycle_work WHERE user_id=? AND id LIKE 'imported-%' ORDER BY created_at", u.user.id);
const maintenance = async env => { await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx); await settle(); };
const makeDue = (db, id) => db.raw.prepare('UPDATE account_lifecycle_work SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), id);

// 1. Happy path: nothing happens while the job runs; on completion the preview is durable and the response is deleted.
{
  const { db, env } = fresh();
  const u = await account(env, 'happy');
  const responseId = await upload(env, u, 'job-1');
  assert.ok(responseId);
  assert.equal((await poll(env, u, 'job-1')).status, 'processing');
  await settle();
  assert.deepEqual(net.deletes, [], 'a running job is never cleaned');
  assert.equal(ledger(db, u).length, 0);
  net.status[responseId] = 'completed';
  let release; net.deleteGate = new Promise(resolve => { release = resolve; });
  const done = await poll(env, u, 'job-1');
  assert.equal(done.status, 'done'); assert.equal(done.preview.program.name, 'Fixture program');
  assert.equal(job(db, u, 'job-1').openai_response_id, null, 'the id leaves import_jobs with the done write');
  const [opened] = ledger(db, u);
  assert.deepEqual([opened.state, opened.response_id, opened.import_job_id], ['RETURNED', responseId, 'job-1'], 'ledger row opened in the same batch');
  assert.ok(net.deletes.length <= 1);
  release(); net.deleteGate = null; await settle();
  assert.deepEqual(net.deletes, [responseId], 'deleted once, after the preview was persisted');
  assert.equal(ledger(db, u)[0].state, 'RESOLVED');
  assert.equal(ledger(db, u)[0].last_error, null);
  // The user's data is unchanged: the same preview is served from D1; no further upstream call.
  const again = await poll(env, u, 'job-1'); await settle();
  assert.deepEqual(again.preview, done.preview); assert.equal(again.status, 'done');
  assert.equal(net.deletes.length, 1); assert.ok(!('openaiResponseId' in again) && !('openai_response_id' in again), 'response shape unchanged');
  // Nothing due afterwards.
  await maintenance(env); assert.equal(net.deletes.length, 1);
}

// 2. 404 counts as deleted (already absent upstream).
{
  const { db, env } = fresh(); net.deletes = [];
  const u = await account(env, 'absent');
  const responseId = await upload(env, u, 'job-404'); net.status[responseId] = 'completed';
  net.deleteReply = () => new Response('{}', { status: 404 });
  await poll(env, u, 'job-404'); await settle();
  assert.equal(ledger(db, u)[0].state, 'RESOLVED');
  net.deleteReply = () => new Response('{}');
}

// 3. Failure (5xx, network, missing key) keeps the row RETURNED with a later retry time; the preview stays; the
//    15-minute maintenance retries exactly one due row per invocation and charges the write to the daily budget.
{
  const { db, env } = fresh(); net.deletes = [];
  const u = await account(env, 'retry');
  const ids = [];
  for (const [n, reply] of [[1, () => new Response('{}', { status: 500 })], [2, () => { throw new TypeError('network'); }]]) {
    const responseId = await upload(env, u, `job-r${n}`); net.status[responseId] = 'completed'; ids.push(responseId);
    net.deleteReply = reply;
    const before = Date.now();
    const done = await poll(env, u, `job-r${n}`); await settle();
    assert.equal(done.status, 'done'); assert.equal(done.preview.program.name, 'Fixture program', 'preview kept on cleanup failure');
    const row = ledger(db, u).find(r => r.response_id === responseId);
    assert.deepEqual([row.state, row.last_error], ['RETURNED', 'OPENAI_CLEANUP_FAILED']);
    assert.ok(Date.parse(row.expires_at) >= before + IMPORTED_RESPONSE_RETRY_MS - 1000, 'next attempt in ~1 h');
  }
  assert.deepEqual(net.deletes, ids);
  // Not due yet: no attempt.
  net.deleteReply = () => new Response('{}'); net.deletes = [];
  await maintenance(env); assert.deepEqual(net.deletes, []);
  // Both due, but today's maintenance budget cannot take the retry write: no attempt.
  for (const row of ledger(db, u)) makeDue(db, row.id);
  const day = new Date().toISOString().slice(0, 10);
  db.raw.prepare("INSERT INTO d1_write_budget(day,scope,rows_written) VALUES (?,'maintenance',?) ON CONFLICT(day,scope) DO UPDATE SET rows_written=excluded.rows_written").run(day, MAINTENANCE_DAILY_ROWS_WRITTEN - 1);
  await maintenance(env); assert.deepEqual(net.deletes, [], 'budget exhausted: retry skipped');
  db.raw.prepare("UPDATE d1_write_budget SET rows_written=0 WHERE day=? AND scope='maintenance'").run(day);
  // One per invocation, oldest retry time first.
  const spentBefore = Number(db.rows("SELECT rows_written FROM d1_write_budget WHERE scope='maintenance'")[0]?.rows_written || 0);
  await maintenance(env); assert.equal(net.deletes.length, 1, 'at most one retry per maintenance invocation');
  const spentAfter = Number(db.rows("SELECT rows_written FROM d1_write_budget WHERE scope='maintenance'")[0]?.rows_written || 0);
  assert.ok(spentAfter > spentBefore, 'retry write charged to the maintenance budget');
  await maintenance(env); assert.equal(net.deletes.length, 2);
  assert.deepEqual(ledger(db, u).map(r => r.state), ['RESOLVED', 'RESOLVED']);
  await maintenance(env); assert.equal(net.deletes.length, 2, 'resolved rows are never retried');
  // Missing key: fails closed (kept RETURNED), never reported as deleted.
  const responseId = await upload(env, u, 'job-nokey'); net.status[responseId] = 'completed';
  const noKey = { ...env, OPENAI_API_KEY: '' };
  await poll(env, u, 'job-nokey');
  const row = ledger(db, u).find(r => r.response_id === responseId);
  await settle(); // the poll above had the key; this row is RESOLVED. Reproduce the no-key path via maintenance:
  db.raw.prepare("UPDATE account_lifecycle_work SET state='RETURNED',last_error='OPENAI_CLEANUP_FAILED' WHERE id=?").run(row.id); makeDue(db, row.id);
  net.deletes = [];
  await maintenance(noKey);
  assert.deepEqual(net.deletes, []); assert.equal(ledger(db, u).find(r => r.id === row.id).state, 'RETURNED');
}

// 4. Concurrent polls of the same completed job: one done write wins, ONE ledger row, ONE delete.
{
  const { db, env } = fresh(); net.deletes = [];
  const u = await account(env, 'race');
  const responseId = await upload(env, u, 'job-race'); net.status[responseId] = 'completed';
  let release; net.retrieveGate = new Promise(resolve => { release = resolve; });
  const both = Promise.all([poll(env, u, 'job-race'), poll(env, u, 'job-race')]);
  await new Promise(resolve => setTimeout(resolve, 10)); release(); net.retrieveGate = null;
  const [a, b] = await both; await settle();
  assert.equal(a.status, 'done'); assert.equal(b.status, 'done');
  assert.equal(ledger(db, u).length, 1, 'one ledger row'); assert.deepEqual(net.deletes, [responseId], 'one delete');
  assert.equal(job(db, u, 'job-race').openai_response_id, null);
}

// 5. An injected failure inside the done batch rolls everything back: no ledger row, no delete, and the response id
//    stays tracked on the job (account purge still erases it). The job is reported failed, as before.
{
  const { db, env } = fresh({ failOn: /INSERT INTO account_lifecycle_work\(id,user_id,state,response_id,created_at,expires_at,import_job_id\)\s+SELECT \?,j\.user_id/ }); net.deletes = [];
  const u = await account(env, 'atomic');
  const responseId = await upload(env, u, 'job-atomic'); net.status[responseId] = 'completed';
  const r = await poll(env, u, 'job-atomic'); await settle();
  assert.equal(r.status, 'failed');
  assert.equal(job(db, u, 'job-atomic').openai_response_id, responseId, 'never untracked');
  assert.equal(job(db, u, 'job-atomic').preview_json, null, 'no partial done write');
  assert.equal(ledger(db, u).length, 0); assert.deepEqual(net.deletes, []);
}

// 5b. The job left 'processing' just before the done batch (a concurrent retry re-queued it): the done write misses, so
//     no ledger row is opened, the id stays on the job and nothing is deleted (cleanup only after a successful import).
{
  const { db, env } = fresh(); net.deletes = [];
  const u = await account(env, 'requeued');
  const responseId = await upload(env, u, 'job-requeued'); net.status[responseId] = 'completed';
  db.setBeforeBatch(statements => { if (statements.some(s => /status = 'done'/.test(s.sql))) db.raw.prepare("UPDATE import_jobs SET status='queued' WHERE id='job-requeued'").run(); });
  await poll(env, u, 'job-requeued'); await settle(); db.setBeforeBatch(null);
  assert.equal(job(db, u, 'job-requeued').openai_response_id, responseId);
  assert.equal(ledger(db, u).length, 0); assert.deepEqual(net.deletes, []);
}

// 6. A job that completes upstream with an invalid result is failed: no import, so no cleanup (purge-only, unchanged).
{
  const { db, env } = fresh(); net.deletes = [];
  const u = await account(env, 'invalid');
  const responseId = await upload(env, u, 'job-bad'); net.status[responseId] = 'completed';
  net.output = () => '{"schemaVersion":"0"}';
  assert.equal((await poll(env, u, 'job-bad')).status, 'failed'); await settle();
  net.output = () => JSON.stringify(preview);
  assert.equal(job(db, u, 'job-bad').openai_response_id, responseId); assert.equal(ledger(db, u).length, 0); assert.deepEqual(net.deletes, []);
}

// 7. Account deletion: maintenance never touches a deleting owner's row; the purge deletes it upstream and erases the
//    account exactly as before (DELETE_NOW is not refused by a RETURNED row).
{
  const { db, env } = fresh(); net.deletes = [];
  const u = await account(env, 'deleting');
  const responseId = await upload(env, u, 'job-del'); net.status[responseId] = 'completed';
  net.deleteReply = () => new Response('{}', { status: 503 });
  await poll(env, u, 'job-del'); await settle();
  const [row] = ledger(db, u); assert.equal(row.state, 'RETURNED');
  net.deleteReply = () => new Response('{}'); net.deletes = [];
  assert.equal((await call(env, '/api/auth/delete/request-link', u.sessionToken, {})).status, 202);
  const token = /#token=([\w-]{43})/.exec(net.mail.textbody)[1];
  const proof = (await (await call(env, '/api/auth/delete/verify-link', u.sessionToken, { token })).json()).proof;
  const deleted = await call(env, '/api/auth/delete', u.sessionToken, { proof, confirm: 'DELETE', method: 'DELETE_NOW' });
  assert.equal(deleted.status, 202, 'DELETE_NOW accepted with a pending imported-response row');
  makeDue(db, row.id);
  await maintenance(env); assert.deepEqual(net.deletes, [], 'maintenance skips non-ACTIVE owners');
  for (let i = 0; i < 4 && db.rows('SELECT id FROM users WHERE id=?', u.user.id).length; i++) await purgeDueAccounts(env);
  assert.deepEqual(net.deletes, [responseId], 'purge deleted the response upstream');
  assert.equal(db.rows('SELECT id FROM users WHERE id=?', u.user.id).length, 0, 'account erased');
  assert.equal(db.rows('SELECT id FROM account_lifecycle_work WHERE user_id=?', u.user.id).length, 0);
}

console.log('B46-03 import response cleanup: running jobs untouched, done preview + ledger + id removal atomic, delete 200/404, failure kept RETURNED with retry time, 15-min retry one-per-invocation (budget charged, ACTIVE only, no key fails closed), concurrent polls one delete, injected batch failure leaves nothing untracked, failed jobs untouched, preview unchanged, account deletion still erases the response passed.');
