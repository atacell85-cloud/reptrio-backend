// Build 49 B49-001: location-aware Places. Autocomplete locationBias (device coordinates, validated, rounded, never stored)
// and the user-triggered Nearby Search (New): own allowance (5/24h first-use), project daily ceiling, fail-closed config,
// minimal Pro field mask, distance-sorted Google-ID-only response, no coordinate persistence, old clients unaffected.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { executePurge } from '../worker/account-lifecycle.js';
import { distanceMeters, googlePlacesRequest, parseCoordinates, parsePlaceRequest } from '../worker/places-api.js';
import { PLACES_NEARBY_DAILY_LIMIT, PLACES_NEARBY_MAX_RESULTS, PLACES_NEARBY_RADIUS_METERS, placesNearbyConfig } from '../worker/places-nearby-quota.js';
import { createD1 } from './lib/d1-sqlite.mjs';

const TOKEN = '12345678-abcd-4e01-9876-123456789abc';
const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
assert.equal(PLACES_NEARBY_DAILY_LIMIT, 5); assert.equal(PLACES_NEARBY_RADIUS_METERS, 5000); assert.equal(PLACES_NEARBY_MAX_RESULTS, 20);

// 1. Coordinate validation: exactly {latitude, longitude}, finite numbers in range; rounded to 4 decimals.
assert.deepEqual(parseCoordinates({ latitude: 41.015137, longitude: 28.97953 }), { latitude: 41.0151, longitude: 28.9795 });
assert.deepEqual(parseCoordinates({ latitude: -90, longitude: 180 }), { latitude: -90, longitude: 180 });
for (const bad of [null, [], 'x', 5, {}, { latitude: 1 }, { latitude: 1, longitude: 2, accuracy: 3 }, { latitude: '41', longitude: 28 }, { latitude: NaN, longitude: 1 }, { latitude: Infinity, longitude: 1 },
  { latitude: 90.0001, longitude: 0 }, { latitude: 0, longitude: -180.5 }, { latitude: null, longitude: 0 }, { latitude: true, longitude: 0 }])
  assert.equal(parseCoordinates(bad), null, JSON.stringify(bad));

// 2. Autocomplete: Build 47/48 bodies are unchanged; a location adds only a 50 km locationBias circle; malformed location is refused.
assert.deepEqual(parsePlaceRequest({ input: 'Gold Gym', sessionToken: TOKEN }, 'autocomplete'), { input: 'Gold Gym', sessionToken: TOKEN });
const located = parsePlaceRequest({ input: 'Gold Gym', sessionToken: TOKEN, location: { latitude: 41.015137, longitude: 28.97953 } }, 'autocomplete');
assert.deepEqual(located.location, { latitude: 41.0151, longitude: 28.9795 });
for (const location of [{ latitude: 'x', longitude: 1 }, { latitude: 1 }, [], null, { latitude: 1, longitude: 1, extra: 1 }])
  assert.equal(parsePlaceRequest({ input: 'Gold Gym', sessionToken: TOKEN, location }, 'autocomplete'), null, 'malformed location is refused, not dropped');
assert.equal(parsePlaceRequest({ placeId: 'ChIJ123456789012345678', sessionToken: TOKEN, location: { latitude: 1, longitude: 1 } }, 'verify'), null, 'verify accepts no location');
{
  let sent;
  await googlePlacesRequest('autocomplete', located, 'secret', async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, text: async () => JSON.stringify({ suggestions: [] }) }; });
  assert.deepEqual(sent.locationBias, { circle: { center: { latitude: 41.0151, longitude: 28.9795 }, radius: 50000 } });
  assert.equal(sent.locationRestriction, undefined, 'bias, never a restriction');
  await googlePlacesRequest('autocomplete', { input: 'Gold Gym', sessionToken: TOKEN }, 'secret', async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, text: async () => '{"suggestions":[]}' }; });
  assert.equal(sent.locationBias, undefined, 'no location -> no bias (Build 48 behaviour)');
}

// 3. Nearby request parsing.
assert.deepEqual(parsePlaceRequest({ latitude: 41.015137, longitude: 28.97953 }, 'nearby'), { latitude: 41.0151, longitude: 28.9795 });
assert.deepEqual(parsePlaceRequest({ latitude: 1, longitude: 2, languageCode: 'tr-TR', regionCode: 'TR' }, 'nearby'), { latitude: 1, longitude: 2, languageCode: 'tr', regionCode: 'tr' });
for (const bad of [{ latitude: 1 }, { latitude: 1, longitude: 2, input: 'x' }, { latitude: 1, longitude: 2, sessionToken: TOKEN }, { latitude: 1, longitude: 2, radius: 99999 }, { latitude: 1, longitude: 2, languageCode: 5 }, { latitude: 'a', longitude: 2 }, null, []])
  assert.equal(parsePlaceRequest(bad, 'nearby'), null, JSON.stringify(bad));

// 4. Upstream request + response shaping: minimal Pro mask, fixed 5 km / DISTANCE / gym types, distance-sorted, IDs only.
{
  const origin = { latitude: 41.0151, longitude: 28.9795 };
  const place = (id, name, lat, lon, extra = {}) => ({ id, displayName: { text: name, languageCode: 'tr' }, formattedAddress: name + ' Cd.', location: { latitude: lat, longitude: lon }, ...extra });
  const google = { places: [place('ChIJfar00000000000001', 'Uzak', 41.05, 28.98), place('ChIJnear0000000000001', 'Yakın', 41.0155, 28.9797), place('bad id', 'Geçersiz', 41.0152, 28.9796), place('ChIJnoloc000000000001', 'Konumsuz', 0, 0, { location: null }), place('ChIJmid00000000000001', 'Orta', 41.02, 28.98, { rating: 5 })] };
  let seen;
  const result = await googlePlacesRequest('nearby', origin, 'secret', async (url, opts) => { seen = { url, opts, body: JSON.parse(opts.body) }; assert.ok(!url.includes('secret')); return { ok: true, text: async () => JSON.stringify(google) }; });
  assert.equal(seen.url, 'https://places.googleapis.com/v1/places:searchNearby');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['X-Goog-FieldMask'], 'places.id,places.displayName,places.formattedAddress,places.location', 'Pro SKU fields only');
  assert.deepEqual(seen.body, { includedTypes: ['gym', 'fitness_center'], maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: origin, radius: 5000 } } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.places.map(p => p.placeId), ['ChIJnear0000000000001', 'ChIJmid00000000000001', 'ChIJfar00000000000001'], 'closest first; invalid ids / missing coordinates dropped');
  assert.ok(result.body.places.every(p => Number.isInteger(p.distanceMeters) && p.distanceMeters >= 0));
  assert.ok(result.body.places[0].distanceMeters < result.body.places[1].distanceMeters);
  assert.deepEqual(Object.keys(result.body.places[0]).sort(), ['address', 'distanceMeters', 'name', 'placeId'], 'Google coordinates and ratings are not passed on');
  assert.equal(result.body.attribution, 'Google Maps');
  assert.ok(Math.abs(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 111195) < 200, 'haversine sanity');
  for (const [status, code, expected] of [[429, 'PLACES_RATE_LIMITED', 429], [403, 'PLACES_UPSTREAM_ERROR', 502], [500, 'PLACES_UPSTREAM_ERROR', 502]]) {
    const r = await googlePlacesRequest('nearby', origin, 'secret', async () => ({ ok: false, status }));
    assert.equal(r.status, expected); assert.equal(r.body.code, code);
  }
  assert.equal((await googlePlacesRequest('nearby', origin, 'secret', async () => { throw new Error('net'); })).status, 503);
  assert.equal((await googlePlacesRequest('nearby', origin, 'secret', async () => ({ ok: true, text: async () => 'not json' }))).status, 502);
  const twentyFive = { places: Array.from({ length: 25 }, (_, i) => place('ChIJmany' + String(i).padStart(14, '0'), 'G' + i, 41.0151 + i * 0.0001, 28.9795)) };
  assert.equal((await googlePlacesRequest('nearby', origin, 'secret', async () => ({ ok: true, text: async () => JSON.stringify(twentyFive) }))).body.places.length, 20);
}

// 5. Config gate: both release-gated settings are required; anything else is closed.
assert.deepEqual(placesNearbyConfig({}), { enabled: false });
assert.deepEqual(placesNearbyConfig({ PLACES_NEARBY_QUOTA_POLICY: 'first-use-24h' }), { enabled: false });
assert.deepEqual(placesNearbyConfig({ PLACES_NEARBY_PROJECT_DAILY_CAP: '100' }), { enabled: false });
assert.deepEqual(placesNearbyConfig({ PLACES_NEARBY_QUOTA_POLICY: 'utc-day', PLACES_NEARBY_PROJECT_DAILY_CAP: '100' }), { enabled: false });
for (const cap of ['0', '-1', '1.5', 'abc', '', '100001', 'NaN', ' 5', 1e9]) assert.deepEqual(placesNearbyConfig({ PLACES_NEARBY_QUOTA_POLICY: 'first-use-24h', PLACES_NEARBY_PROJECT_DAILY_CAP: cap }), { enabled: false }, String(cap));
assert.deepEqual(placesNearbyConfig({ PLACES_NEARBY_QUOTA_POLICY: 'first-use-24h', PLACES_NEARBY_PROJECT_DAILY_CAP: '250' }), { enabled: true, projectCap: 250 });

// 6. Real route + real migrations: auth, order, allowance, project cap, races, persistence, erasure.
let upstream = 0, lastBody = null;
globalThis.fetch = async (url, init) => {
  upstream++; lastBody = init?.body ?? null;
  return { ok: true, text: async () => JSON.stringify({ places: [{ id: 'ChIJnear0000000000001', displayName: { text: 'Yakın' }, formattedAddress: 'X', location: { latitude: 41.0155, longitude: 28.9797 } }] }) };
};
async function fixture({ migrationsUpTo, foreignKeys } = {}) {
  const db = createD1({ migrationsUpTo, foreignKeys });
  const tokens = {};
  for (const id of ['na', 'nb']) {
    db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,'h','s','now')").run(id, id + '@x');
    for (const device of ['phone', 'ipad']) {
      db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'now','2099-01-01')").run(`${id}-${device}`, id, await tokenDigest(`${id}-${device}`));
      tokens[`${id}:${device}`] = `${id}-${device}`;
    }
  }
  let limiterOk = true, limiter = 0;
  const base = { DB: db, GOOGLE_MAPS_PLACES_API_KEY: 'secret', PLACES_LIMITER: { limit: async () => { limiter++; return { success: limiterOk }; } }, PLACES_NEARBY_QUOTA_POLICY: 'first-use-24h', PLACES_NEARBY_PROJECT_DAILY_CAP: '1000' };
  const call = (who, { body = { latitude: 41.0151, longitude: 28.9795 }, env = {}, method = 'POST', headers = {} } = {}) =>
    worker.fetch(new Request('https://x/api/places/nearby', { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[who], ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined }), { ...base, ...env });
  return { db, call, setLimiter: v => { limiterOk = v; }, limiterCount: () => limiter,
    usage: id => db.raw.prepare('SELECT window_start_ms,window_end_ms,dispatched FROM places_nearby_usage WHERE user_id=?').get(id),
    project: () => db.raw.prepare('SELECT day_start_ms,dispatched FROM places_nearby_project_usage').all() };
}

// 6a. Fail-closed config: no D1 row, no Google call.
{
  const f = await fixture();
  for (const env of [{ PLACES_NEARBY_QUOTA_POLICY: undefined }, { PLACES_NEARBY_PROJECT_DAILY_CAP: undefined }, { PLACES_NEARBY_QUOTA_POLICY: 'utc-day' }]) {
    upstream = 0;
    const r = await f.call('na:phone', { env }); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'PLACES_NOT_CONFIGURED');
    assert.equal(upstream, 0); assert.equal(f.usage('na'), undefined); assert.deepEqual(f.project(), []);
  }
}
// 6b. Auth/method/body order: nothing counted before everything validates.
{
  const f = await fixture(); upstream = 0;
  const noAuth = await worker.fetch(new Request('https://x/api/places/nearby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"latitude":1,"longitude":2}' }), { DB: f.db, GOOGLE_MAPS_PLACES_API_KEY: 'secret', PLACES_LIMITER: { limit: async () => ({ success: true }) }, PLACES_NEARBY_QUOTA_POLICY: 'first-use-24h', PLACES_NEARBY_PROJECT_DAILY_CAP: '10' });
  assert.equal(noAuth.status, 401);
  assert.equal((await f.call('na:phone', { method: 'GET' })).status, 405);
  assert.equal((await f.call('na:phone', { body: { latitude: 'x', longitude: 2 } })).status, 400);
  assert.equal((await f.call('na:phone', { body: { latitude: 1, longitude: 2, radius: 1e6 } })).status, 400);
  assert.equal((await f.call('na:phone', { env: { GOOGLE_MAPS_PLACES_API_KEY: '' } })).status, 503);
  f.setLimiter(false); assert.equal((await f.call('na:phone')).status, 429); f.setLimiter(true);
  assert.equal(upstream, 0, 'no refused request reached Google'); assert.equal(f.usage('na'), undefined, 'and none consumed allowance'); assert.deepEqual(f.project(), []);
}
// 6c. Allowance: exactly five per account across devices, then 429 with no Google call; other account independent; Autocomplete unaffected.
{
  const f = await fixture(); upstream = 0;
  const statuses = [];
  for (const who of ['na:phone', 'na:ipad', 'na:phone', 'na:ipad', 'na:phone', 'na:ipad', 'na:phone']) statuses.push((await f.call(who)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(upstream, 5, 'exactly five Google calls'); assert.equal(f.usage('na').dispatched, 5);
  const refused = await f.call('na:phone'); assert.equal((await refused.json()).code, 'PLACES_NEARBY_DAILY_LIMIT');
  assert.equal((await f.call('nb:phone')).status, 200, 'other account has its own allowance');
  assert.equal(f.project()[0].dispatched, 6, 'project counter counts only dispatched calls');
  // Parallel burst for a fresh account: still exactly five.
  const g = await fixture(); upstream = 0;
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => g.call(i % 2 ? 'nb:phone' : 'nb:ipad')));
  assert.equal(burst.filter(r => r.status === 200).length, 5); assert.equal(upstream, 5);
}
// 6d. Project-wide daily ceiling (UTC day): later requests from any account are refused with no Google call.
{
  const f = await fixture(); upstream = 0;
  const env = { PLACES_NEARBY_PROJECT_DAILY_CAP: '3' };
  const out = [];
  for (const who of ['na:phone', 'nb:phone', 'na:ipad', 'nb:ipad', 'na:phone']) { const r = await f.call(who, { env }); out.push([r.status, r.status === 200 ? '' : (await r.json()).code]); }
  assert.deepEqual(out.map(o => o[0]), [200, 200, 200, 503, 503]); assert.equal(out[3][1], 'PLACES_NEARBY_CAPACITY');
  assert.equal(upstream, 3); assert.equal(f.project()[0].dispatched, 3, 'cap is never exceeded');
}
// 6d2. Window boundary: the 24h window rolls over at exactly its end (ms), an earlier clock (skew) never resets it.
{
  const f = await fixture(); const cfg = { enabled: true, projectCap: 1000 };
  const { reservePlacesNearby } = await import('../worker/places-nearby-quota.js');
  for (let i = 0; i < 5; i++) assert.equal(await reservePlacesNearby(f.db, 'na', cfg, T0 + i), 'ok');
  assert.equal(await reservePlacesNearby(f.db, 'na', cfg, T0 + DAY - 1), 'USER_LIMIT', 'one ms before the window ends');
  assert.equal(await reservePlacesNearby(f.db, 'na', cfg, T0 - 5000), 'USER_LIMIT', 'a clock earlier than the window start never resets it');
  assert.equal(await reservePlacesNearby(f.db, 'na', cfg, T0 + DAY), 'ok', 'exactly at the end a fresh window opens');
  assert.equal(f.usage('na').dispatched, 1);
  assert.equal(f.usage('na').window_start_ms, T0 + DAY);
}
// 6e. Persistence: no coordinates, text or Google content anywhere in D1; request body to Google carries no user id.
{
  const f = await fixture(); upstream = 0;
  await f.call('na:phone', { body: { latitude: 41.015137, longitude: 28.97953 } });
  assert.ok(!/41\.01|28\.97/.test(JSON.stringify(f.db.raw.prepare("SELECT * FROM places_nearby_usage").all()) + JSON.stringify(f.project())));
  const tables = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of tables) for (const row of f.db.raw.prepare(`SELECT * FROM "${t}"`).all()) assert.ok(!/41\.015|28\.979|Yakın/.test(JSON.stringify(row)), 'no coordinates/Google content in ' + t);
  assert.ok(!/na@x|"na"/.test(lastBody), 'no account identifier sent to Google');
}
// 6f. Account erasure removes the allowance row (FK on and off); additive, idempotent migration.
{
  // Erasure must not depend on the FK pragma (the project's purge tests also run FK-off): the migration's AFTER DELETE ON users
  // trigger removes the row; an explicit application DELETE would exceed the 40-query final-erase budget.
  for (const foreignKeys of [true, false]) {
    const f = await fixture({ foreignKeys }); await f.call('na:phone'); await f.call('nb:phone');
    assert.equal(f.usage('na').dispatched, 1);
    f.db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',deletion_requested_at='2026-09-01T00:00:00.000Z',purge_at='2026-10-01T00:00:00.000Z' WHERE id='na'").run();
    let outcome; for (let i = 0; i < 5; i++) { outcome = await executePurge({ DB: f.db }, 'na'); if (outcome.ok) break; }
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(f.usage('na'), undefined, 'erased with the account, FK=' + foreignKeys);
    assert.equal(f.usage('nb').dispatched, 1, 'other account kept');
  }
  const f = await fixture({ migrationsUpTo: '0017_places_autocomplete_quota.sql' });
  const before = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const sql = readFileSync(new URL('../migrations/0018_places_nearby_quota.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql.replace(/--.*$/gm, '').replace(/ON DELETE CASCADE/gi, '').replace(/CREATE TRIGGER[\s\S]*?END;/i, ''), /\b(DROP|DELETE|UPDATE|ALTER|INSERT)\b/i, 'additive only (the erase trigger is the only DELETE)');
  f.db.raw.exec(sql); f.db.raw.exec(sql);
  const after = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(after.filter(n => !before.includes(n)), ['places_nearby_project_usage', 'places_nearby_usage']);
  assert.deepEqual(f.db.raw.prepare('PRAGMA table_info(places_nearby_usage)').all().map(c => c.name), ['user_id', 'window_start_ms', 'window_end_ms', 'dispatched', 'updated_ms']);
  assert.deepEqual(f.db.raw.prepare('PRAGMA table_info(places_nearby_project_usage)').all().map(c => c.name), ['day_start_ms', 'dispatched']);
}
console.log('PASS: Places Nearby — validated device coordinates, Autocomplete locationBias (old bodies unchanged), Pro-only field mask, 5/24h per account + project daily ceiling, fail-closed config, no coordinate persistence, erasure, additive migration');
