// Build 45: Live Activity end wired into the production Worker. Real SQLite with the repository migrations, the real
// worker.fetch routes and the real minute cron (purgeDueAccounts). Covers: session auth and request validation, account
// ownership, one schedule per workout and at most 3 rows per user, deleting accounts never written or pushed, the
// minute-probe fold (idle minute = one D1 call, due row -> end push, purge unaffected), the pre-0015 fallback (table
// missing: purge works, end step off), explicit erase in the final account purge (FK on and off), and the claim race
// (a send that outlived its lease cannot finalize a newer claim). APNs is a fake `fetch`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { createD1 } from './lib/d1-sqlite.mjs';
import { purgeDueAccounts } from '../worker/account-lifecycle.js';
import { runLiveActivityEnds } from '../worker/live-activity-end.js';

const MIN = 60_000;
const TOKEN_A = 'a1'.repeat(32), TOKEN_B = 'b2'.repeat(32);
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64');
const APNS = { APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'C4P47F32C8', APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----` };

function setup(options = {}) {
  const db = createD1(options);
  return { db, env: { DB: db, ASSETS: { fetch: () => new Response('asset') }, ...APNS } };
}
const call = (env, path, token, payload, headers = {}) => worker.fetch(new Request('https://api.reptrio.com' + path, {
  method: payload === undefined ? 'GET' : 'POST',
  headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }), ...headers },
  ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
}), env, {});
async function register(env, tag) {
  const r = await call(env, '/api/auth/register', null, { email: tag + '@example.test', password: 'fixture-password' });
  assert.equal(r.status, 201); return r.json();
}
const report = (workoutId, pushToken = TOKEN_A, activityMs = Date.now(), sentMs = Date.now()) => ({ workoutId, pushToken, environment: 'auto', activityAt: new Date(activityMs).toISOString(), sentAt: new Date(sentMs).toISOString() });
// Runs fn once per simulated minute (Date.now advanced by one minute each time), starting at an even minute.
async function minutes(n, fn) {
  const real = Date.now; let t = Math.ceil(real() / (2 * MIN)) * 2 * MIN;
  try { for (let i = 0; i < n; i++) { Date.now = () => t; await fn(i, t); t += MIN; } } finally { Date.now = real; }
}
const rows = (db, userId) => db.rows('SELECT workout_id,push_token,state,end_ms FROM live_activity_end WHERE user_id=? ORDER BY workout_id', userId);

// 1. HTTP contract: session auth, method/type/origin/size/JSON validation, ownership.
{
  const { db, env } = setup();
  const u = await register(env, 'la-http'), other = await register(env, 'la-other');
  assert.equal((await call(env, '/api/live-activity/end', null, report('w1'))).status, 401, 'no session');
  assert.equal((await call(env, '/api/live-activity/end', 'not-a-session', report('w1'))).status, 401, 'unknown session');
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken)).status, 405, 'GET');
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, 'x', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, report('w1'), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, '{bad')).status, 400);
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, { ...report('w1'), pad: 'x'.repeat(3000) })).status, 413);
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, { ...report('w1'), pushToken: 'zz' })).status, 400);
  assert.equal(rows(db, u.user.id).length, 0, 'nothing written by rejected requests');
  const ok = await call(env, '/api/live-activity/end', u.sessionToken, report('w1'));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.code, 'LIVE_ACTIVITY_SCHEDULED'); assert.ok(Date.parse(body.endAt) > Date.now() + 29 * MIN);
  assert.equal(JSON.stringify(body).includes(TOKEN_A), false, 'token never echoed');
  // The other user cannot cancel or overwrite it: the session names the owner, never the body.
  assert.equal((await call(env, '/api/live-activity/end/cancel', other.sessionToken, { workoutId: 'w1' })).status, 200);
  await call(env, '/api/live-activity/end', other.sessionToken, report('w1', TOKEN_B));
  assert.equal(rows(db, u.user.id)[0].push_token, TOKEN_A);
  assert.equal(rows(db, other.user.id)[0].push_token, TOKEN_B);
  assert.equal((await call(env, '/api/live-activity/end/cancel', u.sessionToken, { workoutId: '../x' })).status, 400);
  db.setFailOn(/INSERT INTO live_activity_end/);
  const warn = console.warn; console.warn = () => {};
  const outage = await call(env, '/api/live-activity/end', u.sessionToken, report('w1', TOKEN_A, Date.now() + 60_000));
  console.warn = warn; db.setFailOn(null);
  assert.deepEqual([outage.status, (await outage.json()).code], [503, 'LIVE_ACTIVITY_UNAVAILABLE'], 'D1 outage: generic 503 (the app retries, no backoff)');
  assert.equal((await call(env, '/api/live-activity/end/cancel', u.sessionToken, { workoutId: 'w1' })).status, 200);
  assert.equal(rows(db, u.user.id).length, 0, 'own cancel deletes');
}

// 2. At most 3 rows per user; the reported workout is always kept.
{
  const { db, env } = setup();
  const u = await register(env, 'la-cap');
  for (const [i, id] of ['w1', 'w2', 'w3', 'w4', 'w5'].entries()) {
    db.raw.prepare('UPDATE live_activity_end SET updated_ms=updated_ms-1000 WHERE user_id=?').run(u.user.id);
    assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, report(id, TOKEN_A, Date.now() - i))).status, 200);
  }
  assert.deepEqual(rows(db, u.user.id).map(r => r.workout_id), ['w3', 'w4', 'w5']);
  await call(env, '/api/live-activity/end', u.sessionToken, report('w3', TOKEN_B));
  assert.deepEqual(rows(db, u.user.id).map(r => r.workout_id), ['w3', 'w4', 'w5'], 'reporting an existing workout trims nothing new');
}

// 3. Deleting account: no new rows, no end push for existing rows.
{
  const { db, env } = setup();
  const u = await register(env, 'la-deleting');
  const start = Date.now() - 31 * MIN;
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, report('w1', TOKEN_A, start, start))).status, 200);
  db.raw.prepare("UPDATE live_activity_end SET end_ms=? WHERE user_id=?").run(Date.now() - MIN, u.user.id);
  db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',purge_at=? WHERE id=?").run(new Date(Date.now() + 30 * 86400000).toISOString(), u.user.id);
  assert.equal((await call(env, '/api/live-activity/end', u.sessionToken, report('w2'))).status, 401, 'session of a deleting account is not accepted');
  const pushes = [];
  const result = await runLiveActivityEnds(env, { fetchImpl: async () => { pushes.push(1); return new Response(null, { status: 200 }); }, log: () => {} });
  assert.deepEqual(result, { sent: 0, rows: 0 }); assert.equal(pushes.length, 0, 'never pushed for a deleting account');
  // Even a direct insert attempt for an inactive account writes nothing (atomic ACTIVE guard in SCHEDULE_SQL).
  const { scheduleLiveActivityEnd } = await import('../worker/live-activity-end.js');
  const direct = await scheduleLiveActivityEnd(env, u.user.id, report('w9'));
  assert.deepEqual([direct.status, direct.code], [200, 'LIVE_ACTIVITY_NOT_SCHEDULED'], 'never 401 (the app would sign out)'); assert.equal(db.rows("SELECT 1 FROM live_activity_end WHERE workout_id='w9'").length, 0);
}

// 4. Minute cron fold: idle = one D1 call; a due row is ended by the same cron; the purge decision is unchanged.
{
  const { db, env } = setup();
  const u = await register(env, 'la-cron');
  const before = db.metrics.queries;
  await purgeDueAccounts(env);
  assert.equal(db.metrics.queries - before, 1, 'idle minute: the single probe read');
  const start = Date.now() - 40 * MIN;
  await call(env, '/api/live-activity/end', u.sessionToken, report('w1', TOKEN_A, start, Date.now()));
  const sent = [];
  await purgeDueAccounts(env, { liveActivityEnds: (e, o) => runLiveActivityEnds(e, { ...o, fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 200, headers: { 'apns-id': 'x' } }); }, log: () => {} }) });
  assert.equal(sent.length, 1); assert.match(sent[0].url, /^https:\/\/api\.push\.apple\.com\/3\/device\//);
  assert.equal(rows(db, u.user.id)[0].state, 'SENT');
  const idle = db.metrics.queries;
  let woke = 0;
  await purgeDueAccounts(env, { liveActivityEnds: async () => { woke++; } });
  assert.equal(woke, 0, 'a SENT row does not wake the end step');
  assert.equal(db.metrics.queries - idle, 1, 'a SENT row costs nothing per minute');
  // A due row of a deleting account does not wake the step either (probe uses the same ACTIVE rule as DUE_SQL).
  const leaving = await register(env, 'la-cron-leaving');
  await call(env, '/api/live-activity/end', leaving.sessionToken, report('w1', TOKEN_B, start, Date.now()));
  db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',purge_at=? WHERE id=?").run(new Date(Date.now() + 86400000).toISOString(), leaving.user.id);
  await purgeDueAccounts(env, { liveActivityEnds: async () => { woke++; } });
  assert.equal(woke, 0, 'deleting account: no wake');
  db.raw.prepare('DELETE FROM live_activity_end WHERE user_id=?').run(leaving.user.id);
  // An end step failure never blocks the purge of a due account.
  const due = await register(env, 'la-purge');
  db.raw.prepare("UPDATE users SET account_status='PURGING',purge_at=? WHERE id=?").run(new Date(Date.now() - MIN).toISOString(), due.user.id);
  db.raw.prepare("UPDATE live_activity_end SET state='PENDING',end_ms=? WHERE user_id=?").run(Date.now() - MIN, u.user.id);
  // Both due: the steps alternate by minute (Workers Free CPU: never both in one invocation).
  const turns = [];
  await minutes(2, async (i, t) => {
    const before = db.rows('SELECT 1 FROM users WHERE id=?', due.user.id).length;
    let ended = 0;
    await purgeDueAccounts(env, { liveActivityEnds: async () => { ended++; } });
    turns.push([ended, before - db.rows('SELECT 1 FROM users WHERE id=?', due.user.id).length]);
  });
  assert.deepEqual(turns[0], [1, 0], 'even minute: end step only, purge waits');
  assert.equal(turns[1][0], 0, 'odd minute: no end step');
  // A failing end step never blocks the purge (it completes on the purge minutes).
  await minutes(10, async () => { if (db.rows('SELECT 1 FROM users WHERE id=?', due.user.id).length) await purgeDueAccounts(env, { liveActivityEnds: async () => { throw new Error('boom'); } }); });
  assert.equal(db.rows('SELECT 1 FROM users WHERE id=?', due.user.id).length, 0, 'purge completed despite the failing end step');
}

// 4b. At most 3 end pushes per minute (Workers Free CPU); the rest go out the next minute.
{
  const { db, env } = setup();
  const sent = [];
  const fetchImpl = async () => { sent.push(1); return new Response(null, { status: 200, headers: { 'apns-id': 'x' } }); };
  for (let i = 0; i < 4; i++) {
    const u = await register(env, 'la-cap-run-' + i);
    await call(env, '/api/live-activity/end', u.sessionToken, report('w1', ('c' + i).repeat(32), Date.now() - 40 * MIN, Date.now()));
  }
  assert.deepEqual(await runLiveActivityEnds(env, { fetchImpl, log: () => {} }), { sent: 3, rows: 3 });
  assert.deepEqual(await runLiveActivityEnds(env, { nowMs: Date.now() + MIN, fetchImpl, log: () => {} }), { sent: 1, rows: 1 });
  assert.equal(sent.length, 4);
}

// 5. Before migration 0015: the minute cron falls back to the unchanged probe; purge works; routes answer 503.
{
  const { db, env } = setup({ migrationsUpTo: '0014_free_plan_capacity.sql' });
  const due = await register(env, 'la-premigration');
  db.raw.prepare("UPDATE users SET account_status='PURGING',purge_at=? WHERE id=?").run(new Date(Date.now() - MIN).toISOString(), due.user.id);
  const warn = console.warn; const warnings = []; console.warn = line => warnings.push(String(line));
  try {
    let woke = 0;
    for (let i = 0; i < 5 && db.rows('SELECT 1 FROM users WHERE id=?', due.user.id).length; i++) await purgeDueAccounts(env, { liveActivityEnds: async () => { woke++; } });
    assert.equal(woke, 0, 'no end step without the table');
    const u = await register(env, 'la-premigration-user');
    const premigration = await call(env, '/api/live-activity/end', u.sessionToken, report('w1'));
    assert.equal(premigration.status, 503); assert.equal((await premigration.json()).code, 'LIVE_ACTIVITY_NOT_MIGRATED', 'distinct code: the app may back off');
    // After the migration is applied, the folded probe is retried 15 min later in the same isolate.
    db.raw.exec(readFileSync(new URL('../migrations/0015_live_activity_end.sql', import.meta.url), 'utf8'));
    await call(env, '/api/live-activity/end', u.sessionToken, report('w1', TOKEN_A, Date.now() - 40 * MIN, Date.now()));
    await purgeDueAccounts(env, { liveActivityEnds: async () => { woke++; } });
    assert.equal(woke, 0, 'still inside the 15-minute retry window');
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * MIN;
    try { await purgeDueAccounts(env, { liveActivityEnds: async () => { woke++; } }); } finally { Date.now = realNow; }
    assert.equal(woke, 1, 'folded probe retried after 15 min: the due row wakes the step');
  } finally { console.warn = warn; }
  assert.equal(db.rows('SELECT 1 FROM users WHERE id=?', due.user.id).length, 0, 'purge unaffected by the missing table');
  assert.ok(warnings.some(line => line.includes('live_activity_end_unavailable')));
}

// 6. Final account erase removes the rows explicitly (FK on and off).
for (const foreignKeys of [true, false]) {
  const { db, env } = setup({ foreignKeys });
  const u = await register(env, 'la-erase-' + foreignKeys);
  await call(env, '/api/live-activity/end', u.sessionToken, report('w1'));
  assert.equal(rows(db, u.user.id).length, 1);
  db.raw.prepare("UPDATE users SET account_status='PURGING',purge_at=? WHERE id=?").run(new Date(Date.now() - MIN).toISOString(), u.user.id);
  for (let i = 0; i < 5 && db.rows('SELECT 1 FROM users WHERE id=?', u.user.id).length; i++) await purgeDueAccounts(env, { liveActivityEnds: async () => ({}) });
  assert.equal(db.rows('SELECT 1 FROM users WHERE id=?', u.user.id).length, 0);
  assert.equal(db.rows('SELECT COUNT(*) n FROM live_activity_end')[0].n, 0, `erased explicitly (foreign keys ${foreignKeys ? 'on' : 'off'})`);
}

// 7. Claim race: a send that outlived its lease (swept and re-claimed at the same revision by a later run) cannot
// finalize the newer claim; only the newer claim finalizes.
{
  const { db, env } = setup();
  const u = await register(env, 'la-race');
  const T = Date.now();
  await call(env, '/api/live-activity/end', u.sessionToken, report('w1', TOKEN_A, T - 31 * MIN, T));
  let releaseFirst, releaseSecond;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const second = new Promise(resolve => { releaseSecond = resolve; });
  let calls = 0;
  const fetchImpl = () => (++calls === 1 ? first : second).then(() => new Response(null, { status: 200, headers: { 'apns-id': 'x' } }));
  const run1 = runLiveActivityEnds(env, { nowMs: T, fetchImpl, log: () => {} });
  await new Promise(resolve => setTimeout(resolve, 10));
  const run2 = runLiveActivityEnds(env, { nowMs: T + 3 * MIN, fetchImpl, log: () => {} });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 2, 'the second run re-claimed the swept send');
  releaseFirst(); await run1;
  const mid = db.rows('SELECT state,claimed_ms FROM live_activity_end WHERE user_id=?', u.user.id)[0];
  assert.deepEqual([mid.state, mid.claimed_ms], ['SENDING', T + 3 * MIN], 'the stale send did not finalize the newer claim');
  releaseSecond(); await run2;
  assert.equal(db.rows('SELECT state FROM live_activity_end WHERE user_id=?', u.user.id)[0].state, 'SENT');
}

console.log('Live Activity integration: session auth + validation + ownership, 3 rows per user, deleting accounts never written/pushed, minute-cron fold (idle = 1 D1 call, due -> push, purge unaffected by end failures), pre-0015 fallback, explicit final erase (FK on/off), claim race passed.');
