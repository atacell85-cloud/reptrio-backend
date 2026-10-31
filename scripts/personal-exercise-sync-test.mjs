// Build 52 B52-002 (personal exercise cards): server contract for the account-level `personalExercises` root.
// - data level 2 is derived on the SERVER from stored cards, raised monotonically inside the CAS batch; a client that declares a
//   lower level may not write to such an account (pull stays open) and cannot introduce cards;
// - a live card never disappears from the array (only a tombstone may be released); fields of a surviving card cannot vanish;
// - the capability flag is advertised unless PERSONAL_EXERCISES_ENABLED='false';
// - every rejected write leaves no partial state; level-1 (Build 47) behaviour is unchanged.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { payloadDataLevel, rowsDataLevel, dataLevelPredicate, dataLevelCase, clientDataLevel, raiseDataLevelStatement, DATA_FEATURE_LEVEL } from '../worker/data-feature-guard.js';
import { createD1 } from './lib/d1-sqlite.mjs';

const ORIGIN = 'https://fixtures.example';
const clone = value => structuredClone(value);
let sequence = 0;
async function fixture(options = {}) {
  const db = options.db || createD1(options); const id = `pex-${++sequence}`; const token = `pex-token-${sequence}`;
  db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'h','s','2026-10-21')").run(id, `${id}@example.test`);
  db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'2026-10-21','2099-01-01')").run(`auth-${id}`, id, await tokenDigest(token));
  const env = { DB: db, ...(options.env || {}) };
  const call = (path, init = {}, level = null) => worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(level === null ? {} : { 'X-Reptrio-Data-Level': String(level) }), ...init.headers } }), env, { waitUntil() {} });
  const push = (data, syncVersion, level = null) => call('/api/sync/push', { method: 'POST', body: JSON.stringify({ data, syncVersion }) }, level);
  const pull = async () => { const r = await call('/api/sync/pull'); assert.equal(r.status, 200); return r.json(); };
  const mutate = (envelope, level = null) => call('/api/sync/records/mutations', { method: 'POST', body: JSON.stringify(envelope) }, level);
  const level = () => { const row = db.rows('SELECT level,raised_revision FROM sync_account_data_features WHERE user_id=?', id)[0]; return row ? { ...row } : null; };
  const dump = () => JSON.stringify({ state: db.rows('SELECT * FROM sync_account_state WHERE user_id=?', id), records: db.rows('SELECT * FROM sync_records WHERE user_id=? ORDER BY kind,record_key', id), features: db.rows('SELECT * FROM sync_account_data_features WHERE user_id=?', id) });
  return { db, id, call, push, pull, mutate, level, dump };
}
const code = async response => [response.status, (await response.json()).code];
async function rejected(f, action, expected) {
  const before = f.dump(); f.db.resetMetrics();
  assert.deepEqual(await code(await action()), expected);
  assert.equal(f.dump(), before, 'a rejected write leaves no partial state');
  assert.equal(f.db.metrics.writes, 0);
}
const base = () => ({ schemaVersion: 8, programs: [], sessions: [], measurements: [{ id: 'm-old', recordedAt: '2026-10-01T10:00:00.000Z', weightKg: 80, waistCm: null, bodyFatPercent: null }], settings: { rest: 90, weightUnit: 'kg', gyms: [{ id: 'g1', name: 'Merkez', note: null }], defaultGymId: 'g1' } });
const card = (id, over = {}) => ({ id: `custom:card:${id}`, v: 1, name: `Kart ${id}`, primaryMuscle: 'lats', assistingMuscles: ['biceps'], equipment: 'cable', description: null, legacyCustomIds: [], catalogMatch: null,
  createdAt: '2026-10-31T10:00:00.000Z', updatedAt: '2026-10-31T10:00:00.000Z', rev: 1, deletedAt: null, displaced: [], ...over });
const withCards = (cards, over = {}) => ({ ...base(), personalExercises: cards, ...over });
const build47 = () => { const d = base(); d.settings.gyms.push({ id: 'g2', name: 'Eski', note: null, archivedAt: '2026-10-20T08:00:00.000Z', googlePlaceId: 'ChIJ_x' }); return d; };

// ---- Constants and header parsing.
assert.equal(DATA_FEATURE_LEVEL, 2);
for (const [value, expected] of [[null, 0], ['0', 0], ['1', 1], ['2', 2], [' 2 ', 2], ['3', 2], ['999', 2], ['abc', 0], ['-1', 0], ['2.5', 0]]) {
  assert.equal(clientDataLevel(new Request(ORIGIN, value === null ? {} : { headers: { 'X-Reptrio-Data-Level': value } })), expected, String(value));
}

// ---- Detection: JS and SQL agree; only the personalExercises row holding a card counts; free text cannot impersonate it.
{
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE sync_records(kind TEXT,record_key TEXT,payload_json TEXT,tombstone INTEGER)');
  const cards = JSON.stringify([card('a')]);
  const cases = [
    ['metadata', '["personalExercises"]', cards, 2],
    ['metadata', '["personalExercises"]', JSON.stringify([card('t', { deletedAt: '2026-10-31T11:00:00.000Z' })]), 2],   // a tombstone-only list still means "cards exist"
    ['metadata', '["personalExercises"]', '[]', 0],
    ['metadata', '["personalExercises"]', 'null', 0],
    ['metadata', '["otherRoot"]', cards, 0],
    ['metadata', '["settings"]', JSON.stringify({ note: 'x "id": y' }), 0],
    ['program', '["personalExercises"]', cards, 0],
    ['metadata', '["settings"]', JSON.stringify({ gyms: [{ id: 'g', archivedAt: null }] }), 1],
    ['measurement', '["m"]', JSON.stringify({ id: 'm', extraCm: [] }), 1],
    ['program', '["p"]', JSON.stringify({ days: [{ sections: [{ items: [{ catalogLink: {} }] }] }] }), 1],
    ['measurement', '["m"]', JSON.stringify({ id: 'm', weightKg: 80 }), 0],
  ];
  for (const [kind, key, payload, expected] of cases) {
    assert.equal(payloadDataLevel(kind, key, payload), expected, `${kind} ${key} ${payload.slice(0, 40)}`);
    sqlite.prepare('DELETE FROM sync_records').run();
    sqlite.prepare('INSERT INTO sync_records VALUES (?,?,?,0)').run(kind, key, payload);
    const sql = sqlite.prepare(`SELECT ${dataLevelCase()} AS level FROM sync_records`).get().level;
    assert.equal(sql, expected, `SQL ${kind} ${key} ${payload.slice(0, 40)}`);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_records WHERE ${dataLevelPredicate('', 2)}`).get().n, expected === 2 ? 1 : 0);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_records WHERE ${dataLevelPredicate()}`).get().n, expected === 1 ? 1 : 0, 'the level-1 predicate text is unchanged and does not match level-2 rows');
  }
  assert.equal(rowsDataLevel([{ kind: 'metadata', record_key: '["personalExercises"]', payload_json: cards, tombstone: 0 }, { kind: 'measurement', record_key: '["m"]', payload_json: '{"extraCm":[]}', tombstone: 0 }]), 2, 'maximum of the rows');
  assert.equal(rowsDataLevel([{ kind: 'metadata', record_key: '["personalExercises"]', payload_json: cards, tombstone: 1 }]), 0, 'tombstoned rows do not count');
}

// ---- Capability advertisement.
{
  const f = await fixture();
  assert.equal((await f.push(base(), 0)).status, 200);
  const caps = await (await f.call('/api/sync/capabilities')).json();
  assert.equal(caps.personalExercises, 1);
  assert.equal(caps.draftSetDeletion, 1, 'the undeployed B51 capability is preserved');
  const off = await fixture({ env: { PERSONAL_EXERCISES_ENABLED: 'false' } });
  const offCaps = await (await off.call('/api/sync/capabilities')).json();
  assert.equal('personalExercises' in offCaps, false, 'the flag withdraws the capability (the mobile app then stops creating/sending cards)');
  assert.equal(offCaps.draftSetDeletion, 1);
}

// ---- Level 2 is raised by a level-2 client, in the CAS batch, atomically and monotonically.
{
  const f = await fixture(); assert.equal((await f.push(base(), 0, 2)).status, 200);
  assert.equal(f.level(), null, 'no cards, no marker: accounts without cards are unaffected');
  const cards = withCards([card('a')]);
  assert.equal((await f.push(cards, 1, 2)).status, 200);
  assert.deepEqual(f.level(), { level: 2, raised_revision: 2 });
  assert.deepEqual((await f.pull()).data, cards, 'cards are stored verbatim and read back');
  // A level-1 client (Build 47..51 mobile) is refused on every write path; pull stays open.
  const edit = clone(cards); edit.settings.rest = 60;
  await rejected(f, () => f.push(edit, 2, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  await rejected(f, () => f.push(edit, 2), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  await rejected(f, () => f.mutate({ mutationId: 'l1', baseRevision: 2, clientSchemaVersion: 8, upserts: { measurements: [base().measurements[0]] } }, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  assert.deepEqual((await f.pull()).data, cards, 'old client read-only pull unchanged');
  // The level-2 client keeps working, including edits that touch cards.
  const edited = clone(cards); edited.personalExercises[0] = card('a', { name: 'Yeni ad', rev: 2, updatedAt: '2026-10-31T12:00:00.000Z' });
  assert.equal((await f.push(edited, 2, 2)).status, 200);
  assert.deepEqual((await f.pull()).data, edited);
  // Monotonic: even after every card is removed from view the old client stays refused (cards remain as tombstones in practice).
  assert.equal(f.level().level, 2);
  assert.throws(() => f.db.raw.prepare('UPDATE sync_account_data_features SET level=1 WHERE user_id=?').run(f.id), /DATA_FEATURE_LEVEL_DECREASE|CHECK/);
  // Stale revision from a level-2 client is a plain conflict without writes.
  await rejected(f, () => f.push(edited, 1, 2), [409, 'SYNC_CONFLICT']);
}

// ---- A level-1 client cannot introduce cards; a level-0 client cannot either.
{
  const f = await fixture(); assert.equal((await f.push(base(), 0, 1)).status, 200);
  await rejected(f, () => f.push(withCards([card('x')]), 1, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  await rejected(f, () => f.push(withCards([card('x')]), 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  assert.equal(f.level(), null);
}

// ---- Raising from level 1 to 2 (account already pinned by Build 47 data); the stored row is upgraded, never lowered.
{
  const f = await fixture(); assert.equal((await f.push(build47(), 0, 1)).status, 200);
  assert.deepEqual(f.level(), { level: 1, raised_revision: 1 });
  const next = { ...build47(), personalExercises: [card('up')] };
  assert.equal((await f.push(next, 1, 2)).status, 200);
  assert.deepEqual(f.level(), { level: 2, raised_revision: 2 });
  // A later level-2 write without new level-2 data does not touch the marker.
  next.settings.rest = 45; assert.equal((await f.push(next, 2, 2)).status, 200);
  assert.deepEqual(f.level(), { level: 2, raised_revision: 2 });
}

// ---- Mutation transport (root metadata path) raises and enforces the same way.
{
  const f = await fixture(); assert.equal((await f.push(base(), 0, 2)).status, 200);
  const envelope = (mutationId, revision, cards) => ({ mutationId, baseRevision: revision, clientSchemaVersion: 8, metadata: { personalExercises: cards } });
  await rejected(f, () => f.mutate(envelope('lvl1', 1, [card('m')]), 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const ok = await f.mutate(envelope('lvl2', 1, [card('m')]), 2); assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.deepEqual(f.level(), { level: 2, raised_revision: 2 });
  assert.deepEqual((await f.pull()).data.personalExercises.map(c => c.id), ['custom:card:m']);
  await rejected(f, () => f.mutate({ mutationId: 'lvl1b', baseRevision: 2, clientSchemaVersion: 8, upserts: { measurements: [base().measurements[0]] } }, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
}

// ---- Deletion and field-loss rules for the cards root.
{
  const f = await fixture();
  const live = card('live'); const dead = card('dead', { deletedAt: '2026-10-31T11:00:00.000Z', rev: 2 });
  assert.equal((await f.push(withCards([live, dead]), 0, 2)).status, 200);
  // A live card cannot be dropped from the array (a stale or buggy client); a tombstone can be released (the client's 500-tombstone cap).
  await rejected(f, () => f.push(withCards([dead]), 1, 2), [409, 'SYNC_SCHEMA_LOSS_RISK']);
  await rejected(f, () => f.push(withCards([]), 1, 2), [409, 'SYNC_SCHEMA_LOSS_RISK']);
  await rejected(f, () => f.push({ ...base(), personalExercises: null }, 1, 2), [400, 'SYNC_PAYLOAD_INVALID']);   // an explicit null is an invalid shape, never a clear
  assert.equal((await f.push(withCards([live]), 1, 2)).status, 200, 'releasing a tombstone is allowed');
  assert.deepEqual((await f.pull()).data.personalExercises.map(c => c.id), ['custom:card:live']);
  // Fields of a surviving card cannot vanish; an unknown future field on a card is protected too.
  const future = withCards([{ ...live, futureField: { x: 1 } }]);
  assert.equal((await f.push(future, 2, 2)).status, 200);
  const stripped = clone(future); delete stripped.personalExercises[0].futureField;
  await rejected(f, () => f.push(stripped, 3, 2), [409, 'SYNC_SCHEMA_LOSS_RISK']);
  const missing = clone(future); delete missing.personalExercises[0].description;
  await rejected(f, () => f.push(missing, 3, 2), [409, 'SYNC_SCHEMA_LOSS_RISK']);
  const droppedDisplaced = clone(future); droppedDisplaced.personalExercises[0].displaced = [];
  assert.equal((await f.push(droppedDisplaced, 3, 2)).status, 200, 'the five-version cap may shrink the displaced list (no field vanishes)');
  // An omitted root is re-added by the server (an old client that does not know the key cannot delete it by omission).
  const omitted = clone(future); delete omitted.personalExercises;
  const kept = await f.push(omitted, 4, 2); assert.equal(kept.status, 200);
  assert.equal((await f.pull()).data.personalExercises.length, 1, 'omission never deletes the cards');
  // Sanity limits and shape.
  const dup = withCards([live, live]);
  await rejected(f, () => f.push(dup, 5, 2), [400, 'SYNC_PAYLOAD_INVALID']);
  await rejected(f, () => f.push(withCards([{ name: 'no id' }]), 5, 2), [400, 'SYNC_PAYLOAD_INVALID']);
  await rejected(f, () => f.push(withCards('not an array'), 5, 2), [400, 'SYNC_PAYLOAD_INVALID']);
  await rejected(f, () => f.push(withCards(Array.from({ length: 1001 }, (_, i) => card(`n${i}`))), 5, 2), [400, 'SYNC_PAYLOAD_INVALID']);
}

// ---- The stored marker (not only the live rows) keeps an account at level 2: once every card is gone the old client stays refused.
{
  const f = await fixture();
  const dead = card('only', { deletedAt: '2026-10-31T11:00:00.000Z', rev: 2 });
  assert.equal((await f.push(withCards([dead]), 0, 2)).status, 200);
  assert.deepEqual(f.level(), { level: 2, raised_revision: 1 });
  assert.equal((await f.push(withCards([]), 1, 2)).status, 200, 'the last tombstone may be released');
  assert.equal(payloadDataLevel('metadata', '["personalExercises"]', '[]'), 0, 'no live evidence is left in the rows');
  assert.equal(f.level().level, 2, 'the marker stays');
  await rejected(f, () => f.push(withCards([]), 2, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  await rejected(f, () => f.push(withCards([]), 2), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
}

// ---- Raise statement: monotonic. A lower level never lowers the marker or aborts the batch; a higher level upgrades it.
{
  const f = await fixture(); assert.equal((await f.push(build47(), 0, 1)).status, 200);
  const state = () => f.db.rows('SELECT revision,write_token FROM sync_account_state WHERE user_id=?', f.id)[0];
  const run = (level, force = true) => { const { revision, write_token } = state(); const st = raiseDataLevelStatement(f.db, f.id, revision, write_token, '2026-10-31T12:00:00.000Z', force, level); return f.db.batch([st]); };
  await run(1);                       // equal: no-op
  assert.deepEqual(f.level(), { level: 1, raised_revision: 1 });
  await run(2);                       // higher: upgraded in place
  assert.deepEqual(f.level(), { level: 2, raised_revision: state().revision });
  const at = f.level().raised_revision;
  await run(1);                       // lower: no-op, no trigger abort
  assert.deepEqual(f.level(), { level: 2, raised_revision: at });
  await run(2);                       // equal again: raised_revision untouched
  assert.deepEqual(f.level(), { level: 2, raised_revision: at });
  assert.deepEqual(f.dump().includes('"level":2'), true);
}

// ---- Restore start is refused for a level-1 client on a level-2 account (and for level 0); a level-2 client may start.
{
  const f = await fixture(); assert.equal((await f.push(withCards([card('r')]), 0, 2)).status, 200);
  const start = { sourceNamespace: 'source', archiveRetryHash: 'a'.repeat(64), localBinding: 'local', dataSchemaVersion: 8, expectedChunks: 1, expectedCounts: { sessions: 0, sets: 0, programs: 0, days: 0, sections: 0, exercises: 0, measurements: 0, gyms: 0, importHistory: 0 }, baseRevision: 1 };
  const attempt = level => f.call('/api/backup/restore/operations', { method: 'POST', body: JSON.stringify({ ...start, backupSchemaVersion: 2 }) }, level);
  await rejected(f, () => attempt(null), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  await rejected(f, () => attempt(1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const ok = await attempt(2); assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
}

// ---- Without the marker, the stored card row alone still pins the account at level 2 (restore gate and root-delta mutations).
{
  const f = await fixture(); assert.equal((await f.push(withCards([card('nm')]), 0, 2)).status, 200);
  f.db.raw.prepare('DELETE FROM sync_account_data_features WHERE user_id=?').run(f.id);
  const start = { sourceNamespace: 'source', archiveRetryHash: 'a'.repeat(64), localBinding: 'local', dataSchemaVersion: 8, expectedChunks: 1, expectedCounts: { sessions: 0, sets: 0, programs: 0, days: 0, sections: 0, exercises: 0, measurements: 0, gyms: 0, importHistory: 0 }, baseRevision: 1 };
  await rejected(f, () => f.call('/api/backup/restore/operations', { method: 'POST', body: JSON.stringify({ ...start, backupSchemaVersion: 2 }) }, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  await rejected(f, () => f.mutate({ mutationId: 'nomarker', baseRevision: 1, clientSchemaVersion: 8, upserts: { measurements: [base().measurements[0]] } }, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const ok = await f.mutate({ mutationId: 'nomarker2', baseRevision: 1, clientSchemaVersion: 8, upserts: { measurements: [base().measurements[0]] } }, 2);
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.deepEqual(f.level(), { level: 2, raised_revision: 2 }, 'the next level-2 write records the observed level');
}

// ---- Accounts without cards behave exactly as before (level-0 and level-1 clients unaffected).
{
  const f = await fixture(); const d = base();
  assert.equal((await f.push(d, 0)).status, 200);
  const edited = clone(d); edited.settings.rest = 120; assert.equal((await f.push(edited, 1)).status, 200);
  assert.equal((await f.push(edited, 2, 1)).status, 200);
  assert.equal(f.level(), null);
  assert.equal((await f.push({ ...edited, personalExercises: [] }, 3, 2)).status, 200, 'an empty list is not "cards exist"');
  assert.equal(f.level(), null);
  await rejected(f, () => f.push(edited, 2, 1), [409, 'SYNC_CONFLICT']);
}

// ---- Stored-row detection without a marker (data written before the marker existed is still protected).
{
  const f = await fixture(); assert.equal((await f.push(withCards([card('legacy')]), 0, 2)).status, 200);
  f.db.raw.prepare('DELETE FROM sync_account_data_features WHERE user_id=?').run(f.id);
  await rejected(f, () => f.push(withCards([card('legacy')], { settings: { rest: 70, weightUnit: 'kg', gyms: [{ id: 'g1', name: 'Merkez', note: null }], defaultGymId: 'g1' } }), 1, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const d = withCards([card('legacy')]); d.settings.rest = 75;
  assert.equal((await f.push(d, 1, 2)).status, 200);
  assert.deepEqual(f.level(), { level: 2, raised_revision: 2 }, 'the next level-2 write records the observed level');
}

console.log('Personal exercise sync PASS: level 2 detection (JS = SQL), atomic monotonic raise in push and mutation, old clients read-only, cards never lost (tombstone release only), field-loss and sanity rules, capability flag, no regression for accounts without cards.');
