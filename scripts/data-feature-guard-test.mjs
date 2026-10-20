// Build 47 H1: account-level monotonic data-feature guard against old clients that drop Build 47 fields.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { executePurge } from '../worker/account-lifecycle.js';
import { payloadDataLevel, dataLevelPredicate, clientDataLevel } from '../worker/data-feature-guard.js';
import { createD1 } from './lib/d1-sqlite.mjs';

const ORIGIN = 'https://fixtures.example';
const clone = value => structuredClone(value);
let sequence = 0;
async function fixture(options = {}) {
  const db = options.db || createD1(options); const id = `guard-${++sequence}`; const token = `guard-token-${sequence}`;
  db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'h','s','2026-10-21')").run(id, `${id}@example.test`);
  db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'2026-10-21','2099-01-01')").run(`auth-${id}`, id, await tokenDigest(token));
  const call = (path, init = {}, level = null) => worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(level === null ? {} : { 'X-Reptrio-Data-Level': String(level) }), ...init.headers } }), { DB: db }, { waitUntil() {} });
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
const build47 = () => {
  const d = base();
  d.settings.gyms.push({ id: 'g2', name: 'Eski Salon', note: null, archivedAt: '2026-10-20T08:00:00.000Z', googlePlaceId: 'ChIJ_test_place_1' });
  d.measurements.push({ id: 'm-new', recordedAt: '2026-10-20T10:00:00.000Z', weightKg: 79.5, waistCm: 84, bodyFatPercent: null, neckCm: 38, hipCm: 98,
    extraCm: [{ id: 'x1', label: 'Bilek', cm: 17.5 }], profileAtRecord: { heightCm: 180, gender: 'male', birthYear: 1990 },
    derived: { version: 1, bmi: 24.5, waistToHeight: 0.467, waistToHip: 0.857, navyBodyFatPercent: 17.1, bodyFatBasis: 'estimated', fatMassKg: 13.6, leanMassKg: 65.9, ffmi: 20.3, estimatedRestingKcal: 1748 } });
  return d;
};

// Detection predicate: JS and SQL agree; free text cannot impersonate a key; settings keys only on the settings row.
{
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE sync_records(kind TEXT,record_key TEXT,payload_json TEXT,tombstone INTEGER)');
  const cases = [
    ['measurement', '["m"]', JSON.stringify({ id: 'm', extraCm: [] }), 1],
    ['measurement', '["m"]', JSON.stringify({ id: 'm', note: '"extraCm":' }), 0],
    ['measurement', '["m"]', JSON.stringify({ id: 'm', weightKg: 80 }), 0],
    ['metadata', '["settings"]', JSON.stringify({ gyms: [{ id: 'g', archivedAt: null }] }), 1],
    ['metadata', '["programBuilderDraft"]', JSON.stringify({ archivedAt: 'x' }), 0],
    ['program', '["p"]', JSON.stringify({ days: [{ sections: [{ items: [{ catalogLink: {} }] }] }] }), 1],
    ['session', '["s"]', JSON.stringify({ derived: 1 }), 0],
    ['metadata', '["settings"]', JSON.stringify({ gyms: [{ id: 'g', name: 'Archivedat', note: '"googlePlaceId":' }] }), 0],
  ];
  for (const [kind, key, payload, expected] of cases) {
    assert.equal(payloadDataLevel(kind, key, payload), expected, payload);
    sqlite.prepare('DELETE FROM sync_records').run();
    sqlite.prepare('INSERT INTO sync_records VALUES (?,?,?,0)').run(kind, key, payload);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_records WHERE ${dataLevelPredicate()}`).get().n, expected, 'SQL ' + payload);
  }
  for (const [value, expected] of [[null, 0], ['', 0], ['0', 0], ['1', 1], [' 2 ', 1], ['abc', 0], ['-1', 0], ['1.5', 0]]) {
    assert.equal(clientDataLevel(new Request(ORIGIN, value === null ? {} : { headers: { 'X-Reptrio-Data-Level': value } })), expected, String(value));
  }
}

// Normal Build 46 account: no Build 47 data, old client keeps working and no marker is created.
{
  const f = await fixture(); const d = base();
  assert.equal((await f.push(d, 0)).status, 200);
  const edited = clone(d); edited.settings.rest = 120; assert.equal((await f.push(edited, 1)).status, 200);
  assert.equal(f.level(), null);
}

// Build 47 client raises the account; old full-snapshot client is refused before any write, reads still work.
{
  const f = await fixture(); const d = build47();
  assert.equal((await f.push(d, 0, 1)).status, 200);
  assert.deepEqual(f.level(), { level: 1, raised_revision: 1 });
  const old = await f.pull(); assert.deepEqual(old.data, d, 'old client read-only pull unchanged');
  const dropped = clone(old.data); dropped.settings.gyms = dropped.settings.gyms.map(({ id, name, note }) => ({ id, name, note }));
  dropped.measurements = dropped.measurements.map(({ id, recordedAt, weightKg, waistCm, bodyFatPercent }) => ({ id, recordedAt, weightKg, waistCm, bodyFatPercent }));
  dropped.settings.rest = 60;
  await rejected(f, () => f.push(dropped, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  // Even a lossless old-client edit (nothing dropped) is refused: the account is pinned to Build 47 clients.
  const lossless = clone(old.data); lossless.settings.rest = 60;
  await rejected(f, () => f.push(lossless, 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  // A forged capability header does not authorize loss: content rules still refuse the dropped fields.
  await rejected(f, () => f.push(dropped, 1, 1), [409, 'SYNC_SCHEMA_LOSS_RISK']);
  // Build 47 edit succeeds and the stored data is exactly preserved.
  assert.equal((await f.push(lossless, 1, 1)).status, 200);
  assert.deepEqual((await f.pull()).data, lossless);
  // Monotonic: after all Build 47 fields are gone (unarchive, measurement deleted) the old client stays refused.
  const plain = base(); plain.settings.rest = 60;
  assert.equal((await f.push(plain, 2, 1)).status, 200);
  assert.equal(f.level().level, 1);
  await rejected(f, () => f.push(plain, 3), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  assert.throws(() => f.db.raw.prepare('UPDATE sync_account_data_features SET level=0 WHERE user_id=?').run(f.id), /DATA_FEATURE_LEVEL_DECREASE|CHECK/);
  // Stale revision from a Build 47 client is a plain conflict without writes.
  await rejected(f, () => f.push(plain, 1, 1), [409, 'SYNC_CONFLICT']);
}

// An old client cannot introduce Build 47 fields either (it does not declare them).
{
  const f = await fixture();
  await rejected(f, () => f.push(build47(), 0), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  assert.equal(f.level(), null);
}

// Root-delta mutations: old client cannot touch any root of a Build 47 account, even one without new fields.
{
  const f = await fixture(); assert.equal((await f.push(build47(), 0, 1)).status, 200);
  const session = { id: 's-new', startedAt: '2026-10-21T09:00:00.000Z', sets: {} };
  const envelope = revision => ({ mutationId: `m-${revision}`, baseRevision: revision, clientSchemaVersion: 8, upserts: { sessions: [session] } });
  await rejected(f, () => f.mutate(envelope(1)), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const measurement = { id: 'm-old', recordedAt: '2026-10-01T10:00:00.000Z', weightKg: 81, waistCm: null, bodyFatPercent: null };
  await rejected(f, () => f.mutate({ ...envelope(1), mutationId: 'm-meas', upserts: { measurements: [measurement] } }), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const r = await f.mutate(envelope(1), 1); assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await f.pull()).syncVersion, 2);
}

// Mutation path raises the level itself and refuses an old client creating new Build 47 fields.
{
  const f = await fixture(); assert.equal((await f.push(base(), 0)).status, 200);
  const measurement = build47().measurements[1];
  await rejected(f, () => f.mutate({ mutationId: 'old-new', baseRevision: 1, clientSchemaVersion: 8, upserts: { measurements: [measurement] } }), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const r = await f.mutate({ mutationId: 'b47-new', baseRevision: 1, clientSchemaVersion: 8, upserts: { measurements: [measurement] } }, 1);
  assert.equal(r.status, 200); assert.deepEqual(f.level(), { level: 1, raised_revision: 2 });
}

// Accounts holding Build 47 data written before the guard existed: detected from stored rows without a marker.
{
  const f = await fixture(); assert.equal((await f.push(build47(), 0, 1)).status, 200);
  f.db.raw.prepare('DELETE FROM sync_account_data_features WHERE user_id=?').run(f.id);
  await rejected(f, () => f.push(build47(), 1), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  await rejected(f, () => f.mutate({ mutationId: 'pre', baseRevision: 1, clientSchemaVersion: 8, upserts: { sessions: [{ id: 's', startedAt: '2026-10-21T09:00:00.000Z', sets: {} }] } }), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  // The next Build 47 write records the observed level even if it does not touch those rows.
  const d = build47(); d.settings.rest = 75; assert.equal((await f.push(d, 1, 1)).status, 200);
  assert.deepEqual(f.level(), { level: 1, raised_revision: 2 });
}

// Restore / staged sync: an old client cannot start or commit into a Build 47 account; receipts and cancel stay open.
{
  const f = await fixture(); assert.equal((await f.push(build47(), 0, 1)).status, 200);
  const start = { sourceNamespace: 'source', archiveRetryHash: 'a'.repeat(64), localBinding: 'local', dataSchemaVersion: 8, expectedChunks: 1, expectedCounts: { sessions: 0, sets: 0, programs: 0, days: 0, sections: 0, exercises: 0, measurements: 0, gyms: 0, importHistory: 0 }, baseRevision: 1 };
  for (const path of ['/api/backup/restore/operations', '/api/sync/records/operations']) {
    await rejected(f, () => f.call(path, { method: 'POST', body: JSON.stringify(path.includes('backup') ? { ...start, backupSchemaVersion: 2 } : start) }), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
    const ok = await f.call(path, { method: 'POST', body: JSON.stringify(path.includes('backup') ? { ...start, backupSchemaVersion: 2 } : start) }, 1);
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  }
}

// Build 47's own legitimate removals are accepted for a level-1 client (they were SYNC_SCHEMA_LOSS_RISK before),
// while dropping any other Build 47 field from a surviving record is still refused.
{
  const link = { originalExerciseId: 'custom:name:row', originalDisplayName: 'Row', originalCustomExerciseName: 'Row', catalogId: 'ex_000101', catalogName: 'Barbell Row', changes: [{ sessionId: 's1', groupKey: 'i', storageKey: '1', hadCanonicalExerciseId: true, beforeCanonicalExerciseId: 'custom:name:row', hadExerciseName: false, beforeExerciseName: null }] };
  const program = { id: 'p', schemaVersion: '1.1', name: 'Rutin', description: null, sourceType: 'manual', createdAt: '2026-10-01', updatedAt: '2026-10-20', days: [{ id: 'd', programId: 'p', name: 'Gün 1', order: 1, notes: null, sections: [{ id: 'sec', workoutDayId: 'd', title: 'Ana', sectionType: 'strength', order: 1, notes: null, items: [{ id: 'i', itemType: 'exercise', sectionId: 'sec', exerciseId: 'ex_000101', customExerciseName: null, displayName: 'Barbell Row', order: 1, individualSets: [], catalogLink: link }] }] }] };
  const seed = () => { const d = build47(); d.programs = [clone(program)]; d.programBuilderDraft = clone(program); return d; };
  const flows = {
    'delete extended measurement': d => { d.measurements = d.measurements.filter(m => m.id !== 'm-new'); },
    'reactivate archived gym': d => { delete d.settings.gyms[1].archivedAt; },
    'undo catalog link': d => { const item = d.programs[0].days[0].sections[0].items[0]; delete item.catalogLink; item.exerciseId = 'custom:name:row'; item.customExerciseName = 'Row'; item.displayName = 'Row'; },
    'delete linked routine item': d => { d.programs[0].days[0].sections[0].items = []; },
    'delete linked program': d => { d.programs = []; },
    'clear builder draft holding a link': d => { d.programBuilderDraft = null; },
  };
  for (const [name, change] of Object.entries(flows)) {
    const f = await fixture(); assert.equal((await f.push(seed(), 0, 1)).status, 200, name);
    const next = seed(); change(next); const r = await f.push(next, 1, 1);
    assert.equal(r.status, 200, name + ' ' + JSON.stringify(await r.clone().json()));
    assert.deepEqual((await f.pull()).data, next, name);
  }
  const losses = {
    'drop googlePlaceId': d => { delete d.settings.gyms[1].googlePlaceId; },
    'drop derived snapshot': d => { delete d.measurements[1].derived; },
    'drop profile snapshot field': d => { delete d.measurements[1].profileAtRecord.birthYear; },
    'drop journal change field': d => { delete d.programs[0].days[0].sections[0].items[0].catalogLink.changes[0].hadExerciseName; },
  };
  for (const [name, change] of Object.entries(losses)) {
    const f = await fixture(); assert.equal((await f.push(seed(), 0, 1)).status, 200, name);
    const next = seed(); change(next);
    await rejected(f, () => f.push(next, 1, 1), [409, 'SYNC_SCHEMA_LOSS_RISK']);
  }
}

// Fail closed without migration 0016: writes refuse with 503 and change nothing; reads are unaffected.
{
  const f = await fixture({ migrationsUpTo: '0015_live_activity_end.sql' });
  assert.equal((await f.call('/api/sync/pull')).status, 200);
  const r = await f.push(base(), 0, 1); assert.deepEqual(await code(r), [503, 'SYNC_STORAGE_MIGRATION_REQUIRED']);
  assert.equal(f.db.rows('SELECT COUNT(*) AS n FROM sync_records')[0].n, 0);
}

// Migration 0016 is additive, backfills accounts that already hold Build 47 rows, and is re-runnable.
{
  const db = createD1({ migrationsUpTo: '0015_live_activity_end.sql' });
  const insertUser = id => db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'h','s','2026-10-21')").run(id, `${id}@example.test`);
  const state = (id, revision) => db.raw.prepare("INSERT INTO sync_account_state(user_id,storage_schema_version,revision,write_token,write_status,updated_at) VALUES (?,1,?,'t','ACTIVE','now')").run(id, revision);
  const record = (id, kind, key, payload, tombstone = 0) => db.raw.prepare('INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision,tombstone,deleted_revision) VALUES (?,?,?,NULL,0,?,?,1,1,?,?)').run(id, kind, key, '{}', payload, tombstone, tombstone ? 1 : null);
  insertUser('b47'); state('b47', 4); record('b47', 'metadata', '["settings"]', JSON.stringify({ gyms: [{ id: 'g', name: 'x', note: null, archivedAt: '2026-10-20' }] }));
  insertUser('b46'); state('b46', 3); record('b46', 'measurement', '["m"]', JSON.stringify({ id: 'm', recordedAt: 'x', weightKg: 1, waistCm: null, bodyFatPercent: null }));
  insertUser('gone'); state('gone', 2); record('gone', 'measurement', '["m"]', JSON.stringify({ id: 'm', extraCm: [] }), 1);
  const before = db.rows('SELECT * FROM sync_records ORDER BY user_id,kind,record_key');
  const sql = readFileSync(new URL('../migrations/0016_sync_data_features.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  assert.deepEqual(db.rows('SELECT user_id,level,raised_revision FROM sync_account_data_features ORDER BY user_id').map(row => ({ ...row })), [{ user_id: 'b47', level: 1, raised_revision: 4 }]);
  assert.deepEqual(db.rows('SELECT * FROM sync_records ORDER BY user_id,kind,record_key'), before, 'no record rewritten');
}

// Account erasure removes the marker (explicit delete, also with foreign keys off).
{
  for (const foreignKeys of [true, false]) {
    const f = await fixture({ foreignKeys }); assert.equal((await f.push(build47(), 0, 1)).status, 200); assert.ok(f.level());
    f.db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',deletion_requested_at='2026-09-01T00:00:00.000Z',purge_at='2026-10-01T00:00:00.000Z' WHERE id=?").run(f.id);
    let outcome; for (let i = 0; i < 5; i++) { outcome = await executePurge({ DB: f.db }, f.id); if (outcome.ok) break; }
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(f.db.rows('SELECT COUNT(*) AS n FROM users WHERE id=?', f.id)[0].n, 0);
    assert.equal(f.db.rows('SELECT COUNT(*) AS n FROM sync_account_data_features WHERE user_id=?', f.id)[0].n, 0, 'FK=' + foreignKeys);
  }
}

console.log('Data feature guard PASS: JS/SQL marker parity, normal old accounts unaffected, Build 47 raise in CAS batch, old full-snapshot/root-delta/restore/staged-sync writes refused with zero writes, forged capability still loss-checked, monotonic trigger, pre-guard data detection, fail-closed missing migration, additive re-runnable backfill, erasure.');
