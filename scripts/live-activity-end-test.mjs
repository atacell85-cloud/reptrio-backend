// Build 45 B45-APNs-01 candidate: server-side Live Activity end (worker/live-activity-end.js, worker/apns.js) on real
// SQLite with the repository migrations. Covers the deadline rule (30:00 from the last meaningful activity, never
// backwards), late Watch events, continuation of the same workout, token rotation, a report racing a send, delayed /
// undelivered end pushes, a new workout, offline/expiry, APNs outcomes (dead / auth / retry / sandbox fallback), the
// exact push request (headers, payload, decodable content-state), the ES256 provider token, log hygiene and account
// deletion. No network: APNs is a fake `fetch`.
import assert from 'node:assert/strict';
import { brotliDecompressSync } from 'node:zlib';
import { createD1 } from './lib/d1-sqlite.mjs';
import { scheduleLiveActivityEnd, cancelLiveActivityEnd, runLiveActivityEnds, LIVE_ACTIVITY_DORMANT_MS, parseSchedule } from '../worker/live-activity-end.js';
import { providerToken, endPayload, classify, LIVE_ACTIVITY_TOPIC, END_CONTENT_STATE } from '../worker/apns.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const TOKEN_A = 'a'.repeat(64), TOKEN_B = 'b'.repeat(64);
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64');
const PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

function setup({ configured = true } = {}) {
  const db = createD1();
  const env = { DB: db, ...(configured ? { APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'C4P47F32C8', APNS_PRIVATE_KEY: PEM } : {}) };
  db.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES ('u1','u1@example.test','h','s',?)").run(new Date(T0).toISOString());
  const pushes = [];
  let respond = () => new Response(null, { status: 200, headers: { 'apns-id': 'id-1' } });
  const fetchImpl = async (url, init) => { pushes.push({ url, init, body: JSON.parse(init.body) }); return respond(url, init); };
  const logs = [];
  const run = nowMs => runLiveActivityEnds(env, { nowMs, fetchImpl, log: entry => logs.push(JSON.stringify(entry)) });
  const row = () => db.rows("SELECT * FROM live_activity_end WHERE user_id='u1' AND workout_id='w1'")[0];
  const report = (activityMs, token = TOKEN_A, nowMs = activityMs, workoutId = 'w1', environment = 'production') =>
    scheduleLiveActivityEnd(env, 'u1', { workoutId, pushToken: token, environment, activityAt: new Date(activityMs).toISOString() }, nowMs);
  return { db, env, pushes, logs, run, row, report, setRespond: fn => { respond = fn; } };
}
const reply = (status, reason) => () => new Response(reason ? JSON.stringify({ reason }) : null, { status, headers: { 'apns-id': 'x' } });

// 1. Deadline = last activity + 30:00: nothing at 29:59, exactly one end push at 30:00, nothing after.
{
  const t = setup();
  assert.equal((await t.report(T0)).status, 200);
  assert.equal(t.row().end_ms, T0 + LIVE_ACTIVITY_DORMANT_MS);
  assert.deepEqual(await t.run(T0 + 29 * MIN + 59_000), { sent: 0, rows: 0 });
  assert.equal(t.pushes.length, 0);
  assert.deepEqual(await t.run(T0 + 30 * MIN), { sent: 1, rows: 1 });
  assert.equal(t.row().state, 'SENT');
  await t.run(T0 + 31 * MIN); await t.run(T0 + 60 * MIN);
  assert.equal(t.pushes.length, 1, 'exactly one end push');
}

// 2. Late Watch event (older occurredAt processed later) never moves the deadline backwards; an identical retry of the
// same report writes nothing (no revision bump, no D1 write amplification).
{
  const t = setup();
  await t.report(T0 + 10 * MIN, TOKEN_A, T0 + 10 * MIN);
  const before = t.row();
  await t.report(T0 + 4 * MIN, TOKEN_A, T0 + 11 * MIN);
  await t.report(T0 + 10 * MIN, TOKEN_A, T0 + 12 * MIN);
  assert.deepEqual(t.row(), before, 'older or equal activity changes nothing');
  await t.run(T0 + 39 * MIN);
  assert.equal(t.pushes.length, 0, 'not ended 30 min after the late event');
  await t.run(T0 + 40 * MIN);
  assert.equal(t.pushes.length, 1);
}

// 3. The same workout continues: the deadline moves forward; a send claimed for the old revision cannot happen.
{
  const t = setup();
  await t.report(T0);
  await t.report(T0 + 25 * MIN, TOKEN_A, T0 + 25 * MIN);
  await t.run(T0 + 30 * MIN);
  assert.equal(t.pushes.length, 0, 'continued workout is not ended at the old deadline');
  await t.run(T0 + 55 * MIN);
  assert.equal(t.pushes.length, 1);
}

// 4. Token rotation (ActivityKit pushTokenUpdates): the newest token is used; retries/attempts reset.
{
  const t = setup();
  await t.report(T0, TOKEN_A);
  t.setRespond(reply(500, 'InternalServerError'));
  await t.run(T0 + 30 * MIN);
  assert.equal(t.row().attempts, 1); assert.ok(t.row().retry_ms > T0 + 30 * MIN);
  await t.report(T0, TOKEN_B, T0 + 31 * MIN);
  assert.equal(t.row().attempts, 0); assert.equal(t.row().retry_ms, null); assert.equal(t.row().state, 'PENDING');
  t.setRespond(reply(200));
  await t.run(T0 + 31 * MIN);
  assert.ok(t.pushes.at(-1).url.endsWith('/3/device/' + TOKEN_B), 'sent to the rotated token');
  assert.equal(t.row().state, 'SENT');
}

// 4b. A rotated token reported together with an OLDER activity time (late Watch event) keeps the later deadline;
// a new token rearms a row that was SENT (new activity) or FAILED (dead token replaced).
{
  const t = setup();
  await t.report(T0 + 20 * MIN, TOKEN_A, T0 + 20 * MIN);
  await t.report(T0 + 5 * MIN, TOKEN_B, T0 + 21 * MIN);
  assert.equal(t.row().push_token, TOKEN_B); assert.equal(t.row().end_ms, T0 + 50 * MIN, 'deadline kept, not moved backwards');
  await t.run(T0 + 50 * MIN); assert.equal(t.row().state, 'SENT');
  await t.report(T0 + 20 * MIN, TOKEN_A, T0 + 51 * MIN);
  assert.equal(t.row().state, 'PENDING', 'new token after SENT: a new activity is armed');
  t.setRespond(reply(410, 'Unregistered')); await t.run(T0 + 52 * MIN);
  assert.equal(t.row().state, 'FAILED');
  t.setRespond(reply(200)); await t.report(T0 + 20 * MIN, TOKEN_B, T0 + 53 * MIN);
  assert.equal(t.row().state, 'PENDING', 'dead token replaced: rearmed'); assert.equal(t.row().last_error, null);
  await t.run(T0 + 53 * MIN); assert.equal(t.row().state, 'SENT'); assert.ok(t.pushes.at(-1).url.endsWith(TOKEN_B));
}

// 5. A report that lands while the end push is in flight: the send is not recorded as the final state; the row is
// rearmed for the new deadline (the push already sent can at most end an activity that then restarts in the app).
{
  const t = setup();
  await t.report(T0);
  t.setRespond(() => { void t.report(T0 + 30 * MIN, TOKEN_A, T0 + 30 * MIN); return new Response(null, { status: 200 }); });
  await t.run(T0 + 30 * MIN);
  assert.equal(t.row().state, 'PENDING'); assert.equal(t.row().end_ms, T0 + 60 * MIN);
  t.setRespond(reply(200));
  await t.run(T0 + 59 * MIN); assert.equal(t.pushes.length, 1);
  await t.run(T0 + 60 * MIN); assert.equal(t.pushes.length, 2);
}

// 6. Delayed / undelivered end push: after SENT, a newer activity with the SAME token (the phone never got the push,
// the activity is still alive) rearms the row; an older/equal report does not resend.
{
  const t = setup();
  await t.report(T0); await t.run(T0 + 30 * MIN);
  await t.report(T0, TOKEN_A, T0 + 31 * MIN); await t.run(T0 + 32 * MIN);
  assert.equal(t.pushes.length, 1, 'no second push without new activity');
  await t.report(T0 + 35 * MIN, TOKEN_A, T0 + 35 * MIN);
  assert.equal(t.row().state, 'PENDING');
  await t.run(T0 + 65 * MIN);
  assert.equal(t.pushes.length, 2, 'ended again 30 min after the continued activity');
  // The push itself expires after 5 minutes: an offline phone cannot be closed by it much later.
  const expiration = Number(t.pushes[0].init.headers['apns-expiration']);
  assert.ok(expiration <= Math.floor((T0 + 30 * MIN) / 1000) + 300);
}

// 7. A new workout is a separate row; finishing a workout cancels its end push.
{
  const t = setup();
  await t.report(T0, TOKEN_A, T0, 'w1');
  await t.report(T0 + 5 * MIN, TOKEN_B, T0 + 5 * MIN, 'w2');
  assert.equal((await cancelLiveActivityEnd(t.env, 'u1', 'w1')).status, 200);
  await t.run(T0 + 40 * MIN);
  assert.equal(t.pushes.length, 1);
  assert.ok(t.pushes[0].url.endsWith(TOKEN_B), 'only the open workout is ended');
}

// 8. Offline / no report: rows nobody updates expire with the 120-minute auto-close (+30) and are deleted.
{
  const t = setup({ configured: false });
  await t.report(T0);
  assert.deepEqual(await t.run(T0 + 30 * MIN), { sent: 0, rows: 1, unconfigured: true });
  assert.equal(t.row().state, 'PENDING', 'unconfigured: nothing claimed, nothing lost');
  await t.run(T0 + 150 * MIN);
  assert.equal(t.row(), undefined, 'stale row removed');
  assert.ok(t.logs.some(line => line.includes('live_activity_end_unconfigured')));
}

// 9. APNs outcomes.
{
  for (const [status, reason, state] of [[410, 'Unregistered', 'FAILED'], [400, 'BadDeviceToken', 'FAILED'], [400, 'DeviceTokenNotForTopic', 'FAILED'], [403, 'ExpiredProviderToken', 'PENDING'], [429, 'TooManyRequests', 'PENDING'], [503, 'ServiceUnavailable', 'PENDING']]) {
    const t = setup(); await t.report(T0); t.setRespond(reply(status, reason));
    await t.run(T0 + 30 * MIN);
    assert.equal(t.row().state, state, `${status} ${reason}`);
    if (state === 'PENDING') assert.ok(t.row().retry_ms >= T0 + 32 * MIN, 'retried later, not in a hot loop');
  }
  // Network failure -> retry; the attempt cap ends in FAILED.
  const t = setup(); await t.report(T0); t.setRespond(() => { throw new Error('connection reset'); });
  let at = T0 + 30 * MIN;
  for (let i = 0; i < 8 && t.row().state === 'PENDING'; i++) { await t.run(at); at = t.row().retry_ms ?? at; }
  assert.ok(at - T0 < 150 * MIN, 'backoff finishes before the stale-row expiry');
  assert.equal(t.row().state, 'FAILED'); assert.equal(t.row().attempts, 6);
  // 'auto': a development-signed build's sandbox token is BadDeviceToken on production, then sent via sandbox.
  const auto = setup(); await auto.report(T0, TOKEN_A, T0, 'w1', 'auto');
  auto.setRespond(url => url.startsWith('https://api.push.apple.com') ? reply(400, 'BadDeviceToken')() : reply(200)());
  await auto.run(T0 + 30 * MIN);
  assert.deepEqual(auto.pushes.map(p => new URL(p.url).host), ['api.push.apple.com', 'api.sandbox.push.apple.com']);
  assert.equal(auto.row().state, 'SENT'); assert.equal(auto.row().apns_env, 'sandbox');
  assert.equal(classify({ status: 200 }), 'sent');
}

// 10. An interrupted send (Worker killed while SENDING) is swept back after the 2-minute lease and retried exactly once.
{
  const t = setup(); await t.report(T0);
  t.db.raw.prepare("UPDATE live_activity_end SET state='SENDING',claimed_ms=? WHERE workout_id='w1'").run(T0 + 30 * MIN);
  await t.run(T0 + 31 * MIN); assert.equal(t.pushes.length, 0, 'lease still held');
  // Same minute: the sweep releases it and the due read (same batch) picks it up again.
  await t.run(T0 + 32 * MIN); assert.equal(t.pushes.length, 1); assert.equal(t.row().state, 'SENT');
  await t.run(T0 + 33 * MIN); assert.equal(t.pushes.length, 1, 'no duplicate after the retried send');
}

// 11. Input validation, clock skew and the 120-minute bound.
{
  const t = setup();
  for (const bad of [{ pushToken: 'zz' }, { pushToken: 'A'.repeat(63) }, { workoutId: '' }, { workoutId: 'x'.repeat(129) }, { workoutId: 'a b' }, { environment: 'dev' }, { activityAt: 'nope' }]) {
    const input = { workoutId: 'w1', pushToken: TOKEN_A, environment: 'production', activityAt: new Date(T0).toISOString(), ...bad };
    assert.equal((await scheduleLiveActivityEnd(t.env, 'u1', input, T0)).status, 400, JSON.stringify(bad));
  }
  assert.equal(parseSchedule({ workoutId: 'w1', pushToken: TOKEN_A.toUpperCase(), environment: 'auto', activityAt: new Date(T0).toISOString() }, T0).pushToken, TOKEN_A, 'hex case-insensitive');
  await t.report(T0 + 60 * MIN, TOKEN_A, T0);
  assert.equal(t.row().activity_ms, T0 + 2 * MIN, 'a phone clock ahead is clamped to +2 min');
  const old = await t.report(T0 - 121 * MIN, TOKEN_A, T0);
  assert.equal(old.code, 'LIVE_ACTIVITY_EXPIRED'); assert.equal(t.row(), undefined, 'beyond auto-close: removed, never pushed');
}

// 12. The exact APNs request.
{
  const t = setup(); await t.report(T0); await t.run(T0 + 30 * MIN);
  const { url, init, body } = t.pushes[0];
  assert.equal(url, 'https://api.push.apple.com/3/device/' + TOKEN_A);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['apns-push-type'], 'liveactivity');
  assert.equal(init.headers['apns-topic'], LIVE_ACTIVITY_TOPIC);
  assert.equal(init.headers['apns-priority'], '10');
  assert.match(init.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const now = Math.floor((T0 + 30 * MIN) / 1000);
  assert.deepEqual(Object.keys(body.aps).sort(), ['content-state', 'dismissal-date', 'event', 'timestamp']);
  assert.equal(body.aps.event, 'end'); assert.equal(body.aps.timestamp, now); assert.equal(body.aps['dismissal-date'], now);
  const decoded = JSON.parse(brotliDecompressSync(Buffer.from(body.aps['content-state'].uiJsonData, 'base64')).toString());
  assert.equal(decoded.ls.c.c, 'Antrenman beklemede'); assert.ok(decoded.isl_cmp_l && decoded.isl_cmp_t && decoded.isl_min, 'all required island regions');
  assert.deepEqual(endPayload(T0).aps['content-state'], END_CONTENT_STATE);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 4096, 'ActivityKit 4 KB push payload limit');
}

// 13. ES256 provider token: verifiable, kid/iss, iat bucketed (same token inside a 40-min bucket, new one after).
{
  const config = { keyId: 'KEY1234567', teamId: 'C4P47F32C8', privateKey: PEM };
  const a = await providerToken(config, T0), b = await providerToken(config, T0 + 10 * MIN), c = await providerToken(config, T0 + 41 * MIN);
  assert.equal(a, b); assert.notEqual(a, c);
  const [h, p, s] = a.split('.');
  const json = part => JSON.parse(Buffer.from(part, 'base64url').toString());
  assert.deepEqual(json(h), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(json(p).iss, 'C4P47F32C8'); assert.ok(T0 / 1000 - json(p).iat < 40 * 60 && json(p).iat <= T0 / 1000);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, ec.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${p}`)));
}

// 14. Logs never carry the device push token or the provider token; account deletion removes the rows (FK cascade).
{
  const t = setup(); await t.report(T0); t.setRespond(reply(410, 'Unregistered')); await t.run(T0 + 30 * MIN);
  assert.ok(t.logs.length > 0);
  for (const line of t.logs) { assert.ok(!line.includes(TOKEN_A)); assert.ok(!/bearer|eyJ/.test(line)); }
  await t.report(T0 + 40 * MIN, TOKEN_B, T0 + 40 * MIN, 'w2');
  t.db.raw.prepare("DELETE FROM users WHERE id='u1'").run();
  assert.equal(t.db.rows('SELECT COUNT(*) n FROM live_activity_end')[0].n, 0);
}

// 15. D1 cost: an idle minute is one batch (sweep + expiry + due read); a send adds claim + final.
{
  const t = setup(); t.db.resetMetrics();
  await t.run(T0);
  assert.equal(t.db.metrics.batches, 1); assert.equal(t.db.metrics.queries, 3);
  await t.report(T0); t.db.resetMetrics(); await t.run(T0 + 30 * MIN);
  assert.equal(t.db.metrics.batches, 1); assert.equal(t.db.metrics.queries, 5);
}

console.log('Live Activity end (B45-APNs-01 candidate): 30:00 deadline, late Watch events, continuation, token rotation, send race, delayed/undelivered end push, new workout, offline expiry, APNs outcomes + sandbox fallback, lease sweep, validation/skew/120-min, exact request + decodable content-state, ES256 token, log hygiene, FK cascade and D1 cost passed.');
