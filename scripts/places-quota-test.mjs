// Build 48 B48-C: per-account Places Autocomplete allowance (100 dispatched requests per window, shared by devices).
// Real Worker route + real migrations over SQLite. Reset policy approved by the user on 2026-10-22: `first-use-24h`
// (the only value enabled on the real route; `utc-day` is exercised only via the test-only `approvedQuotaPolicies`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { executePurge } from '../worker/account-lifecycle.js';
import { handlePlacesRequest } from '../worker/places-api.js';
import { APPROVED_PLACES_QUOTA_POLICIES, PLACES_DAILY_AUTOCOMPLETE_LIMIT, PLACES_QUOTA_POLICIES, placesQuotaPolicy } from '../worker/places-quota.js';
import { createD1 } from './lib/d1-sqlite.mjs';

const TOKEN = '12345678-abcd-4e01-9876-123456789abc', PLACE = 'ChIJ123456789012345678';
// One process-wide provider stub (never the network); each fixture installs its counters before calling.
let activeProvider = async () => { throw new Error('no provider'); };
globalThis.fetch = (url, init) => activeProvider(String(url), init);
const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
assert.equal(PLACES_DAILY_AUTOCOMPLETE_LIMIT, 100, 'approved allowance is 100, not 10');
assert.deepEqual([...APPROVED_PLACES_QUOTA_POLICIES], ['first-use-24h'], 'only the user-approved reset policy (2026-10-22)');
assert.ok(Object.isFrozen(APPROVED_PLACES_QUOTA_POLICIES) && Object.isFrozen(PLACES_QUOTA_POLICIES));

async function fixture({ migrationsUpTo, foreignKeys } = {}) {
  const db = createD1({ migrationsUpTo, foreignKeys });
  const users = {};
  for (const id of ['qa', 'qb']) {
    db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,'h','s','now')").run(id, id + '@x');
    for (const device of ['phone', 'ipad']) {
      const secret = `${id}-${device}-token`;
      db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'now','2099-01-01')").run(`${id}-${device}`, id, await tokenDigest(secret));
      users[`${id}:${device}`] = secret;
    }
  }
  const counters = { upstream: 0, autocomplete: 0, verify: 0, limiter: 0 };
  let upstream = async url => ({ ok: true, text: async () => JSON.stringify(url.includes(':autocomplete') ? { suggestions: [] } : { id: PLACE }) });
  let limiterOk = true;
  const env = (extra = {}) => ({ DB: db, GOOGLE_MAPS_PLACES_API_KEY: 'secret', PLACES_LIMITER: { limit: async () => { counters.limiter++; return { success: limiterOk }; } }, ...extra });
  let clock = T0;
  const call = async (who, { mode = 'autocomplete', body, policy = 'utc-day', approved = [policy], envExtra = {}, viaWorker = false } = {}) => {
    const payload = body ?? (mode === 'autocomplete' ? { input: 'Gold Gym', sessionToken: TOKEN } : { placeId: PLACE, sessionToken: TOKEN });
    const request = new Request(`https://x/api/places/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + users[who] }, body: JSON.stringify(payload) });
    activeProvider = async (url, init) => { counters.upstream++; counters[url.includes(':autocomplete') ? 'autocomplete' : 'verify']++; return upstream(url, init); };
    const e = env({ ...(policy ? { PLACES_DAILY_QUOTA_POLICY: policy } : {}), ...envExtra });
    return viaWorker ? await worker.fetch(request, e, { waitUntil() {} })
      : await handlePlacesRequest(request, e, `/api/places/${mode}`, { approvedQuotaPolicies: approved, now: () => clock });
  };
  const usage = id => db.raw.prepare('SELECT window_start_ms,window_end_ms,dispatched FROM places_autocomplete_usage WHERE user_id=?').get(id);
  return { db, call, counters, usage, setClock: t => { clock = t; }, setUpstream: f => { upstream = f; }, setLimiter: ok => { limiterOk = ok; } };
}
const code = async response => (await response.json()).code;

// 1. Release gate. Unset policy = Build 47 behaviour with no D1 access (works even without migration 0017). On the real
//    Worker route only `first-use-24h` is approved; any other configured value fails closed before the limiter/Google.
{
  const f = await fixture({ migrationsUpTo: '0016_sync_data_features.sql' });
  for (let i = 0; i < 3; i++) assert.equal((await f.call('qa:phone', { policy: null, viaWorker: true })).status, 200);
  assert.equal(f.counters.autocomplete, 3, 'quota off: unchanged Build 47 behaviour');
  for (const policy of ['utc-day', 'Europe/Istanbul', 'First-Use-24h', 'constructor', '__proto__']) {
    const r = await f.call('qa:phone', { policy, viaWorker: true });
    assert.equal(r.status, 503, policy); assert.equal(await code(r), 'PLACES_NOT_CONFIGURED');
  }
  assert.equal(f.counters.autocomplete, 3, 'unapproved policy: no provider request'); assert.equal(f.counters.limiter, 3, 'and no burst-limiter spend');
  // Verification never depends on the allowance or its gate.
  for (const policy of ['utc-day', 'Europe/Istanbul']) assert.equal((await f.call('qa:phone', { mode: 'verify', policy, viaWorker: true })).status, 200, 'verify under ' + policy);
  assert.equal(f.counters.verify, 2, 'verification reached Google once per call');
  assert.deepEqual(placesQuotaPolicy({}), { enabled: false });
  assert.equal(placesQuotaPolicy({ PLACES_DAILY_QUOTA_POLICY: 'utc-day' }).misconfigured, true);
  assert.equal(placesQuotaPolicy({ PLACES_DAILY_QUOTA_POLICY: 'first-use-24h' }).enabled, true);
  assert.equal(placesQuotaPolicy({ PLACES_DAILY_QUOTA_POLICY: 'utc-day' }, ['utc-day']).enabled, true);
  assert.equal(placesQuotaPolicy({ PLACES_DAILY_QUOTA_POLICY: 'hasOwnProperty' }, ['hasOwnProperty']).enabled, false);
}

// 1b. Production route (no test options): the approved policy enforces 100 per account; without 0017 it fails closed.
{
  const f = await fixture();
  for (let i = 0; i < 100; i++) assert.equal((await f.call('qa:phone', { policy: 'first-use-24h', viaWorker: true })).status, 200);
  const r = await f.call('qa:ipad', { policy: 'first-use-24h', viaWorker: true });
  assert.equal(r.status, 429); assert.equal(await code(r), 'PLACES_DAILY_LIMIT'); assert.equal(f.counters.autocomplete, 100);
  const row = f.usage('qa'); assert.equal(row.dispatched, 100); assert.equal(row.window_end_ms - row.window_start_ms, DAY, '24 h from first use');
  assert.equal((await f.call('qa:phone', { mode: 'verify', policy: 'first-use-24h', viaWorker: true })).status, 200);
  const g = await fixture({ migrationsUpTo: '0016_sync_data_features.sql' });
  const missing = await g.call('qa:phone', { policy: 'first-use-24h', viaWorker: true });
  assert.equal(missing.status, 503); assert.equal(await code(missing), 'PLACES_UNAVAILABLE'); assert.equal(g.counters.upstream, 0);
}

// 1c. Deployed configuration: the policy lives ONLY in wrangler.jsonc `vars` (wrangler deploy replaces dashboard-set
//     vars because keep_vars is not set, which would silently turn the quota off). Allowed: absent (not enabled yet)
//     or exactly 'first-use-24h'; dashboard-only settings are not supported.
{
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const vars = JSON.parse(config.replace(/^\s*\/\/.*$/gm, '')).vars || {};
  assert.ok(!('PLACES_DAILY_QUOTA_POLICY' in vars) || vars.PLACES_DAILY_QUOTA_POLICY === 'first-use-24h', 'only the approved policy in vars');
  assert.ok(!/"keep_vars"\s*:\s*true/.test(config), 'keep_vars would let a dashboard value drift from git');
}

// 2. Exactly 100 dispatched per account, shared across devices; the 101st is refused before Google; verification is
//    never counted nor blocked; another account is independent; Build 47 bodies are counted the same way.
{
  const f = await fixture();
  for (let i = 0; i < 60; i++) assert.equal((await f.call('qa:phone')).status, 200);
  for (let i = 0; i < 40; i++) assert.equal((await f.call('qa:ipad', { body: { input: 'Gold Gym ' + i, sessionToken: TOKEN, languageCode: 'en' } })).status, 200);
  assert.equal(f.counters.autocomplete, 100); assert.equal(f.usage('qa').dispatched, 100);
  for (const device of ['qa:phone', 'qa:ipad']) {
    const r = await f.call(device); assert.equal(r.status, 429); assert.equal(await code(r), 'PLACES_DAILY_LIMIT');
    assert.equal(JSON.stringify(await (await f.call(device)).json()).match(/\d/), null, 'no remaining count disclosed');
  }
  assert.equal(f.counters.autocomplete, 100, '101st+ never reaches Google'); assert.equal(f.usage('qa').dispatched, 100, 'refusals do not grow the counter');
  for (let i = 0; i < 3; i++) assert.equal((await f.call('qa:phone', { mode: 'verify' })).status, 200, 'verification works after the limit');
  assert.equal(f.counters.verify, 3); assert.equal(f.usage('qa').dispatched, 100, 'verification never counted');
  assert.equal((await f.call('qb:phone')).status, 200, 'other account unaffected'); assert.equal(f.usage('qb').dispatched, 1);
  // Bad bodies, unauthenticated calls and burst-limited calls never take a unit.
  const g = await fixture();
  assert.equal((await g.call('qa:phone', { body: { input: 'x', sessionToken: TOKEN } })).status, 400);
  g.setLimiter(false); assert.equal((await g.call('qa:phone')).status, 429); g.setLimiter(true);
  assert.equal(g.usage('qa'), undefined, 'nothing reserved for refused requests');
}

// 3. Concurrency: 2 accounts x 2 devices x many parallel requests -> exactly 100 per account dispatched.
{
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 260 }, (_, i) => f.call(['qa:phone', 'qa:ipad', 'qb:phone', 'qb:ipad'][i % 4])));
  const ok = results.filter(r => r.status === 200).length, limited = results.filter(r => r.status === 429).length;
  assert.equal(ok, 200); assert.equal(limited, 60); assert.equal(f.counters.autocomplete, 200);
  assert.equal(f.usage('qa').dispatched, 100); assert.equal(f.usage('qb').dispatched, 100);
}

// 4. Upstream outcomes: timeout/abort, 5xx and upstream 429 keep the unit (conservative billing; no refund to exploit).
{
  const f = await fixture();
  f.setUpstream(async () => ({ ok: false, status: 500 })); assert.equal((await f.call('qa:phone')).status, 502);
  f.setUpstream(async () => ({ ok: false, status: 429 })); assert.equal((await f.call('qa:phone')).status, 429);
  f.setUpstream(async () => { throw new Error('aborted'); }); assert.equal((await f.call('qa:phone')).status, 503);
  assert.equal(f.usage('qa').dispatched, 3, 'every dispatched attempt counted once');
  // Accounting failure fails closed without a provider request (e.g. 0017 not applied while a policy is enabled).
  const g = await fixture({ migrationsUpTo: '0016_sync_data_features.sql' });
  const r = await g.call('qa:phone'); assert.equal(r.status, 503); assert.equal(await code(r), 'PLACES_UNAVAILABLE'); assert.equal(g.counters.upstream, 0);
  assert.equal((await g.call('qa:phone', { mode: 'verify' })).status, 200, 'verification independent of the quota table');
}

// 5. Reset boundaries: approved first-use-24h, and the rejected utc-day kept as a comparison.
{
  // utc-day: one boundary for everybody at 00:00 UTC.
  const f = await fixture();
  f.setClock(Date.UTC(2026, 9, 22, 23, 59, 59, 999));
  for (let i = 0; i < 100; i++) await f.call('qa:phone');
  assert.equal((await f.call('qa:phone')).status, 429);
  f.setClock(Date.UTC(2026, 9, 22, 23, 59, 59, 990)); assert.equal((await f.call('qa:phone')).status, 429, 'earlier clock (skew) never refills');
  f.setClock(Date.UTC(2026, 9, 23, 0, 0, 0, 0)); assert.equal((await f.call('qa:phone')).status, 200, 'new UTC day');
  assert.deepEqual({ ...f.usage('qa') }, { window_start_ms: Date.UTC(2026, 9, 23), window_end_ms: Date.UTC(2026, 9, 24), dispatched: 1 });
  // first-use-24h: window opens at the first counted request and lasts exactly 24 h.
  const g = await fixture(); const start = T0 + 1234;
  g.setClock(start); await g.call('qa:phone', { policy: 'first-use-24h' });
  g.setClock(start + 5 * 3_600_000); for (let i = 0; i < 99; i++) await g.call('qa:phone', { policy: 'first-use-24h' });
  g.setClock(start + DAY - 1); assert.equal((await g.call('qa:phone', { policy: 'first-use-24h' })).status, 429);
  g.setClock(start + DAY); assert.equal((await g.call('qa:phone', { policy: 'first-use-24h' })).status, 200);
  assert.deepEqual({ ...g.usage('qa') }, { window_start_ms: start + DAY, window_end_ms: start + 2 * DAY, dispatched: 1 });
  assert.equal(PLACES_QUOTA_POLICIES['utc-day'](Date.UTC(2026, 0, 1, 23)).start, Date.UTC(2026, 0, 1));
}

// 6. Persistence across Worker restarts: state lives only in D1 (a fresh module instance sees the same count).
{
  const f = await fixture();
  for (let i = 0; i < 100; i++) await f.call('qa:phone');
  const fresh = await import('../worker/places-api.js?restart=' + Date.now());
  const request = new Request('https://x/api/places/autocomplete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer qa-phone-token' }, body: JSON.stringify({ input: 'Gold Gym', sessionToken: TOKEN }) });
  const r = await fresh.handlePlacesRequest(request, { DB: f.db, GOOGLE_MAPS_PLACES_API_KEY: 'secret', PLACES_DAILY_QUOTA_POLICY: 'utc-day', PLACES_LIMITER: { limit: async () => ({ success: true }) } }, '/api/places/autocomplete', { approvedQuotaPolicies: ['utc-day'], now: () => T0 });
  assert.equal(r.status, 429, 'restart does not reset the allowance');
}

// 7. Account erasure removes the row (FK on and off); the migration is additive and re-runnable on a 0016 database.
{
  for (const foreignKeys of [true, false]) {
    const f = await fixture({ foreignKeys });
    await f.call('qa:phone'); await f.call('qb:phone'); assert.ok(f.usage('qa'));
    f.db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',deletion_requested_at='2026-09-01T00:00:00.000Z',purge_at='2026-10-01T00:00:00.000Z' WHERE id='qa'").run();
    let outcome; for (let i = 0; i < 5; i++) { outcome = await executePurge({ DB: f.db }, 'qa'); if (outcome.ok) break; }
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(f.usage('qa'), undefined, 'erased with the account, FK=' + foreignKeys);
    assert.equal(f.usage('qb').dispatched, 1, 'other account kept');
  }
  const f = await fixture({ migrationsUpTo: '0016_sync_data_features.sql' });
  const before = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const sql = readFileSync(new URL('../migrations/0017_places_autocomplete_quota.sql', import.meta.url), 'utf8');
  const statements = sql.replace(/--.*$/gm, '').replace(/ON DELETE CASCADE/gi, '');
  assert.doesNotMatch(statements, /\b(DROP|DELETE|UPDATE|ALTER|INSERT)\b/i, 'additive only');
  assert.match(statements, /CREATE TABLE IF NOT EXISTS places_autocomplete_usage/);
  f.db.raw.exec(sql); f.db.raw.exec(sql);
  const after = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(after.filter(n => !before.includes(n)), ['places_autocomplete_usage']);
  const cols = f.db.raw.prepare('PRAGMA table_info(places_autocomplete_usage)').all().map(c => c.name);
  assert.deepEqual(cols, ['user_id', 'window_start_ms', 'window_end_ms', 'dispatched', 'updated_ms'], 'no search text, Google content, device or location');
}

console.log('PASS: Places daily allowance — approved first-use-24h reset (unset = Build 47, other values = fail closed, production route enforced), exactly 100 dispatched per account across devices and under concurrency, 101st refused before Google, verification never counted, refused/bad/burst-limited requests free, no refund after dispatch, fail-closed accounting, first-use-24h (and rejected utc-day) boundaries incl. clock skew, restart persistence, account erasure (FK on/off), additive re-runnable migration with no content columns.');
