// Build 57 (B57-002): removing an exercise from the active workout through the real Worker push/pull on SQLite D1.
// A removal is: every set of the row deleted through `setDeletionLog`, the exercise leaves `exercises`, its row stays `{}` and its
// row id is added to `draft.removedExercises`. The marker raises the account to data level 3 in the same CAS batch, so a
// Build <= 56 client (level 2) can no longer write (it would merge its stale copy and put sets back under the removed row).
// For the same draft id a removed row is never listed again, holds no set and the list only grows (SYNC_DRAFT_LAYOUT_STALE).
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { accountDataLevel, dataLevelCase, payloadDataLevel, EXERCISE_REMOVAL_LEVEL, DATA_FEATURE_LEVEL } from '../worker/data-feature-guard.js';
import { createD1 } from './lib/d1-sqlite.mjs';

const ORIGIN = 'https://fixtures.example';
const strip = value => JSON.parse(JSON.stringify(value));
const clone = value => structuredClone(value);
let sequence = 0;
async function fixture() {
  const db = createD1(); const id = `u-${++sequence}`; const token = `local-token-${sequence}`;
  db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'h','s','2026-10-08')").run(id, `${id}@example.test`);
  db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'2026-10-08','2099-01-01')").run(`auth-${id}`, id, await tokenDigest(token));
  const call = (route, init = {}, level = '3', env = {}) => worker.fetch(new Request(`${ORIGIN}/api/sync/${route}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(level ? { 'X-Reptrio-Data-Level': level } : {}), ...init.headers } }), { DB: db, ...env }, { waitUntil() {} });
  const push = (data, syncVersion, level = '3') => call('push', { method: 'POST', body: JSON.stringify({ data, syncVersion }) }, level);
  const pull = async (level = '3') => { const r = await call('pull', {}, level); assert.equal(r.status, 200); return r.json(); };
  const dump = () => JSON.stringify(db.rows('SELECT * FROM sync_records ORDER BY kind,record_key'));
  const level = () => { const row = db.raw.prepare('SELECT level, raised_revision FROM sync_account_data_features WHERE user_id=?').get(id); return row ? { ...row } : null; };
  return { db, id, push, pull, call, dump, level };
}
const code = async response => [response.status, (await response.json()).code];
const refused = async (f, action, expected) => {
  const before = f.dump(); const level = JSON.stringify(f.level());
  assert.deepEqual(await code(await action()), [expected === 'SYNC_PAYLOAD_INVALID' ? 400 : 409, expected]);
  assert.equal(f.dump(), before, 'nothing written'); assert.equal(JSON.stringify(f.level()), level, 'level unchanged');
};

const set = (n, over = {}) => ({ exerciseId: 'row-x', setNumber: n, weight: String(60 + n * 5), reps: '8', rir: '', rpe: '', rest: '', tempo: '', note: '', completed: true, startedAt: `2026-11-17T08:0${n}:00.000Z`, completedAt: `2026-11-17T08:0${n}:30.000Z`, ...over });
const base = () => strip({
  schemaVersion: 8, programs: [], sessions: [], measurements: [],
  draft: { id: 'draft-1', programId: null, dayId: null, dayName: 'Push', startedAt: '2026-11-17T08:00:00.000Z', lastEditedAt: '2026-11-17T08:05:00.000Z', watchStateRevision: 4,
    exercises: [{ id: 'row-x', exerciseId: 'bench' }, { id: 'row-y', exerciseId: 'ohp' }, { id: 'row-empty', exerciseId: 'dip' }],
    sets: { 'row-x': { 1: set(1), 2: set(2) }, 'row-y': { 1: set(1, { exerciseId: 'row-y' }) }, 'row-empty': {} },
    restTimer: null },
});
let ids = 0;
// Mobile removeExerciseFromDraft: every set through the log (highest key first), the row stays {}, the id joins the marker.
function removeExercise(data, row) {
  const next = clone(data); const d = next.draft; const keys = Object.keys(d.sets[row] || {}).map(Number).sort((a, b) => b - a);
  d.setDeletionLog = { ...(d.setDeletionLog || {}) };
  d.setDeletionLog[row] = [...(d.setDeletionLog[row] || []), ...keys.map(key => ({ id: `del-${++ids}`, key }))];
  if (!d.setDeletionLog[row].length) delete d.setDeletionLog[row];
  if (!Object.keys(d.setDeletionLog).length) delete d.setDeletionLog;
  d.watchStateRevision += 1;
  d.setLayoutFence = { ...(d.setLayoutFence || {}), [row]: d.watchStateRevision };
  d.exercises = d.exercises.filter(item => item.id !== row);
  d.sets[row] = {};
  d.removedExercises = [...(d.removedExercises || []), row];
  return strip(next);
}
const addSet = (data, row) => { const next = clone(data); const n = Object.keys(next.draft.sets[row] || {}).length + 1; next.draft.sets[row] = { ...(next.draft.sets[row] || {}), [n]: { exerciseId: row, setNumber: n, weight: '75', reps: '8', rir: '', rpe: '', rest: '', tempo: '', note: 'phone B', completed: false } }; return strip(next); };

// 0. Constants, row levels and the SQL CASE agree.
{
  assert.equal(EXERCISE_REMOVAL_LEVEL, 3); assert.equal(DATA_FEATURE_LEVEL, 3);
  const draftWith = JSON.stringify({ id: 'd', removedExercises: ['r'] });
  assert.equal(payloadDataLevel('metadata', '["draft"]', draftWith), 3);
  assert.equal(payloadDataLevel('metadata', '["draft"]', JSON.stringify({ id: 'd', exercises: [] })), 0);
  assert.equal(payloadDataLevel('metadata', '["draft"]', JSON.stringify({ id: 'd', sets: { r: { 1: { note: '"removedExercises":' } } } })), 0, 'free text cannot raise the level');
  assert.equal(payloadDataLevel('metadata', '["programBuilderDraft"]', draftWith), 0, 'only the active workout draft row');
  const f = await fixture();
  f.db.raw.prepare("INSERT INTO sync_records (user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision,tombstone,deleted_revision) VALUES (?,?,?,NULL,0,'{}',?,1,1,0,NULL)").run(f.id, 'metadata', '["draft"]', draftWith);
  assert.equal(f.db.raw.prepare(`SELECT ${dataLevelCase()} AS level FROM sync_records WHERE user_id=?`).get(f.id).level, 3);
  assert.equal(await accountDataLevel(f.db, f.id), 3);
}

// 1. Capability: advertised by default; absent when either flag is off (the Build 57 client keeps the action hidden).
{
  const f = await fixture();
  const caps = async env => (await f.call('capabilities', {}, '3', env)).json();
  assert.equal((await caps({})).draftExerciseRemoval, 1);
  assert.equal((await caps({})).accountDataLevel, 0, 'the account level is reported with the capability (first-removal notice)');
  assert.equal((await caps({ DRAFT_EXERCISE_REMOVAL_ENABLED: 'false' })).draftExerciseRemoval, undefined);
  assert.equal((await caps({ DRAFT_SET_DELETION_ENABLED: 'false' })).draftExerciseRemoval, undefined, 'removal rides on set deletion');
}

// 2. A level-3 client removes an exercise: accepted, the account becomes level 3 in that same revision; finish clears the draft.
{
  const f = await fixture(); const d = base();
  assert.equal((await f.push(d, 0)).status, 200); assert.equal(f.level(), null, 'no marker yet');
  const removed = removeExercise(d, 'row-x');
  assert.equal((await f.push(removed, 1)).status, 200);
  assert.deepEqual(f.level(), { level: 3, raised_revision: 2 }, 'raised with the write that stored the marker');
  assert.equal((await (await f.call('capabilities')).json()).accountDataLevel, 3);
  assert.deepEqual((await f.pull()).data, removed, 'stored exactly');
  // An exercise whose row was already empty (no deletion log) and a second removal.
  const two = removeExercise(removed, 'row-empty'); assert.equal((await f.push(two, 2)).status, 200);
  // Re-adding the same catalog exercise gets a new row id and is accepted.
  const readd = clone(two); readd.draft.exercises.push({ id: 'row-x2', exerciseId: 'bench' }); readd.draft.sets['row-x2'] = { 1: set(1, { exerciseId: 'row-x2', completed: false, completedAt: undefined }) };
  assert.equal((await f.push(strip(readd), 3)).status, 200);
  // Finish: the draft becomes null (a known level-3 shape may be cleared).
  const finished = clone(readd); finished.draft = null; finished.sessions = [{ id: 's1', programId: null, dayId: null, workoutDayId: null, title: 'Push', startedAt: d.draft.startedAt, completedAt: '2026-11-17T09:00:00.000Z', updatedAt: '2026-11-17T09:00:00.000Z', status: 'completed', gymId: null, excludedFromStats: false, summary: { totalSets: 2, completedSets: 1 }, sets: { 'row-y': readd.draft.sets['row-y'], 'row-x2': readd.draft.sets['row-x2'] } }];
  assert.equal((await f.push(strip(finished), 4)).status, 200, 'finish accepted');
  assert.equal((await f.pull()).data.draft, null);
  assert.equal(f.level().level, 3, 'monotonic: the level stays after the draft is gone');
  // A new workout (another draft id) without any removal.
  const next = base(); next.draft.id = 'draft-2'; next.sessions = finished.sessions;
  assert.equal((await f.push(next, 5)).status, 200);
}

// 3. Build <= 56 (level 2) after a removal: every write AND read refused with SYNC_CLIENT_UPGRADE_REQUIRED, nothing written.
{
  const f = await fixture(); const d = base();
  assert.equal((await f.push(d, 0, '2')).status, 200, 'old client works before any removal');
  assert.equal((await f.call('pull', {}, '2')).status, 200, 'and reads before any removal (levels 1–2 policy unchanged)');
  assert.equal((await f.call('records', {}, '2')).status, 200);
  const removed = removeExercise(d, 'row-x');
  await refused(f, () => f.push(removed, 1, '2'), 'SYNC_CLIENT_UPGRADE_REQUIRED');   // an old client cannot store the marker itself
  assert.equal((await f.push(removed, 1, '3')).status, 200);
  // The old phone's stale copy: X listed with a new set (exactly what its reconcile would build) — refused before any rule.
  const stale = addSet(d, 'row-x');
  await refused(f, () => f.push(stale, 2, '2'), 'SYNC_CLIENT_UPGRADE_REQUIRED');
  // Even a harmless edit of the old client is refused (it would drop `removedExercises`).
  const harmless = clone((await f.pull('3')).data); delete harmless.draft.removedExercises; harmless.draft.dayName = 'Push 2';
  await refused(f, () => f.push(strip(harmless), 2, '2'), 'SYNC_CLIENT_UPGRADE_REQUIRED');
  // User decision 2026-11-18: from level 3 an older client may not READ either (pull and paged records), so it never sees a level-3
  // draft to merge; a current client reads normally.
  for (const header of ['2', '1', null]) {
    assert.deepEqual(await code(await f.call('pull', {}, header)), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED'], 'pull refused, level ' + header);
    assert.deepEqual(await code(await f.call('records', {}, header)), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED'], 'paged read refused, level ' + header);
  }
  assert.equal((await f.call('pull', {}, '3')).status, 200);
  assert.equal((await f.call('records', {}, '3')).status, 200);
  assert.equal((await f.call('capabilities', {}, '2')).status, 200, 'capabilities stay readable (no account data)');
  // Without the header at all (pre-Build-47).
  await refused(f, () => f.push(stale, 2, null), 'SYNC_CLIENT_UPGRADE_REQUIRED');
  // Guardian MAJOR-A: a STALE old client (old revision) gets the upgrade code too, never SYNC_CONFLICT — a conflict would send it into
  // its old merge, which can put its set under the removed exercise.
  await refused(f, () => f.push(stale, 1, '2'), 'SYNC_CLIENT_UPGRADE_REQUIRED');
  await refused(f, () => f.push(stale, 0, '2'), 'SYNC_CLIENT_UPGRADE_REQUIRED');
  // A current client on a stale revision still gets the ordinary conflict.
  await refused(f, () => f.push(stale, 1, '3'), 'SYNC_CONFLICT');
}

// 3b. No removal is ever stored without its marker (so never without the level-3 raise of the same batch).
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
  const unmarked = removeExercise(d, 'row-x'); delete unmarked.draft.removedExercises;
  await refused(f, () => f.push(unmarked, 1), 'SYNC_DRAFT_LAYOUT_STALE');
  const unmarkedEmpty = removeExercise(d, 'row-empty'); delete unmarkedEmpty.draft.removedExercises;
  await refused(f, () => f.push(unmarkedEmpty, 1), 'SYNC_DRAFT_LAYOUT_STALE');
  // A level-2 client on a level-0 account: the same rule (the account is not level 3 yet, so the content rule answers).
  await refused(f, () => f.push(unmarked, 1, '2'), 'SYNC_DRAFT_LAYOUT_STALE');
  assert.equal(f.level(), null, 'no level raise, nothing stored');
  // A new workout (another draft id) may have other exercises: no removal rule across drafts.
  const other = base(); other.draft.id = 'draft-2'; other.draft.exercises = [other.draft.exercises[1]];
  assert.equal((await f.push(other, 1)).status, 200);
}

// 4. Two phones, both orders, on the real Worker (stale revision → SYNC_CONFLICT, then the merged push is checked).
{
  // 4a. Phone B (any level) adds a set to X and pushes first; phone A removes X on the old revision.
  for (const levelB of ['3', '2']) {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    const b = addSet(d, 'row-x'); assert.equal((await f.push(b, 1, levelB)).status, 200);
    const a = removeExercise(d, 'row-x');
    await refused(f, () => f.push(a, 1), 'SYNC_CONFLICT');
    // The pre-fix reconcile: B's set appended under the removed row (X unlisted, marker kept).
    const orphan = clone(a); orphan.draft.sets['row-x'] = { 1: { ...b.draft.sets['row-x'][3], setNumber: 1 } };
    await refused(f, () => f.push(strip(orphan), 2), 'SYNC_DRAFT_LAYOUT_STALE');
    // Without the marker the deletion log alone makes the row the phone A layout: X re-listed with B's set is the server draft.
    const relisted = clone(orphan); relisted.draft.exercises.unshift({ id: 'row-x', exerciseId: 'bench' });
    await refused(f, () => f.push(strip(relisted), 2), 'SYNC_DRAFT_LAYOUT_STALE');
    assert.deepEqual((await f.pull()).data, b, 'phone B set kept on the server, nothing lost');
    assert.equal(f.level(), null, 'no removal stored, no level raise');
  }
  // 4b. Phone A removes X first; phone B (level 3, stale) adds a set to X on the old revision.
  {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    const a = removeExercise(d, 'row-x'); assert.equal((await f.push(a, 1)).status, 200);
    const b = addSet(d, 'row-x');
    await refused(f, () => f.push(b, 1), 'SYNC_CONFLICT');
    // B pushes its stale copy on the new revision: lacks the server's deletions → stale; with the marker but sets → stale.
    await refused(f, () => f.push(b, 2), 'SYNC_DRAFT_LAYOUT_STALE');
    const orphan = clone(a); orphan.draft.sets['row-x'] = { 1: { ...b.draft.sets['row-x'][3], setNumber: 1 } };
    await refused(f, () => f.push(strip(orphan), 2), 'SYNC_DRAFT_LAYOUT_STALE');
    assert.deepEqual((await f.pull()).data, a, 'the removal stands');
  }
  // 4c. Removing an exercise with no sets has no deletion log: the marker alone keeps a stale copy from listing it again.
  {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    const a = removeExercise(d, 'row-empty'); assert.equal((await f.push(a, 1)).status, 200);
    const stale = clone(d); stale.draft.dayName = 'Push (B)';
    await refused(f, () => f.push(strip(stale), 2), 'SYNC_DRAFT_LAYOUT_STALE');
    const dropMarker = clone(a); delete dropMarker.draft.removedExercises;
    await refused(f, () => f.push(strip(dropMarker), 2), 'SYNC_DRAFT_LAYOUT_STALE');
    const relist = clone(a); relist.draft.exercises.push({ id: 'row-empty', exerciseId: 'dip' });
    await refused(f, () => f.push(strip(relist), 2), 'SYNC_DRAFT_LAYOUT_STALE');
  }
}

// 5. Malformed markers are invalid payloads (never stored).
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
  for (const bad of ['row-x', [''], ['row-y', 'row-y'], [7], Array.from({ length: 201 }, (_, i) => `r${i}`), ['x'.repeat(129)]]) {
    const next = clone(d); next.draft.removedExercises = bad;
    await refused(f, () => f.push(strip(next), 1), 'SYNC_PAYLOAD_INVALID');
  }
  // A marker for a row the draft does not hold at all is valid (nothing to keep empty) — e.g. an exercise added then removed offline.
  const ghost = clone(d); ghost.draft.removedExercises = ['row-never-synced'];
  assert.equal((await f.push(strip(ghost), 1)).status, 200);
}

// 6. Record transport (root delta mutations) enforces the same level gate through the same SQL CASE.
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
  assert.equal((await f.push(removeExercise(d, 'row-x'), 1)).status, 200);
  // Even without the stored marker row the live draft row alone is level 3 (the CASE over sync_records).
  f.db.raw.prepare('DELETE FROM sync_account_data_features WHERE user_id=?').run(f.id);
  const caps = await (await f.call('capabilities', {}, '2')).json();
  assert.equal(caps.rootDeltaSync, true, 'transport available in the fixture');
  const mutation = (level, rev) => f.call('records/mutations', { method: 'POST', body: JSON.stringify({ mutationId: `mu-${++ids}`, baseRevision: rev, clientSchemaVersion: 8, upserts: { measurements: [{ id: 'm1', recordedAt: '2026-11-17T07:00:00.000Z', weightKg: 80 }] } }) }, level);
  await refused(f, () => mutation('2', 2), 'SYNC_CLIENT_UPGRADE_REQUIRED');
  await refused(f, () => mutation('2', 1), 'SYNC_CLIENT_UPGRADE_REQUIRED');   // stale old client: upgrade, not conflict (MAJOR-A)
  const ok = await mutation('3', 2); assert.equal(ok.status, 200, 'a level-3 client edits other roots normally');
  assert.equal(f.level().level, 3, 'the observed level is recorded with that write');
}

// 7. Guardian round 3 MAJOR-R3-1: the old client's write reads the account at level 0, then an exercise removal commits before its
// batch (the CAS loses). The answer must be the upgrade code, not SYNC_CONFLICT — on the push path and on the transport path.
{
  const interleave = f => f.db.setBeforeBatch(statements => {
    if (!statements[0]?.sql?.trimStart().startsWith('UPDATE sync_account_state')) return;
    f.db.setBeforeBatch(null);
    // Another phone's first removal committed meanwhile: revision moved on, level 3 stored (as its own CAS batch does).
    f.db.raw.prepare('UPDATE sync_account_state SET revision = revision + 1 WHERE user_id = ?').run(f.id);
    f.db.raw.prepare("INSERT INTO sync_account_data_features(user_id,level,raised_revision,raised_at) VALUES (?,3,99,'2026-11-18T00:00:00.000Z') ON CONFLICT(user_id) DO UPDATE SET level=3").run(f.id);
  });
  for (const [levelHeader, expected] of [['2', 'SYNC_CLIENT_UPGRADE_REQUIRED'], ['3', 'SYNC_CONFLICT']]) {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    interleave(f);
    const r = await f.push(addSet(d, 'row-x'), 1, levelHeader);
    assert.deepEqual(await code(r), [409, expected], `push race, client level ${levelHeader}`);
    const g = await fixture(); assert.equal((await g.push(base(), 0)).status, 200);
    interleave(g);
    const m = await g.call('records/mutations', { method: 'POST', body: JSON.stringify({ mutationId: `race-${++ids}`, baseRevision: 1, clientSchemaVersion: 8, upserts: { measurements: [{ id: 'm1', recordedAt: '2026-11-17T07:00:00.000Z', weightKg: 80 }] } }) }, levelHeader);
    assert.deepEqual(await code(m), [409, expected], `transport race, client level ${levelHeader}`);
  }
}

// 8. Read gate sources (the read RACE itself — removal committing inside the old client's pull — is in the mobile cross-repo test
// test-b57-exercise-removal-cross-repo.mjs): rows alone refuse, the stored level alone refuses, an old client never gets a marker.
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
  // Marker present in the rows but the stored level row missing (e.g. written by an older path): rows alone refuse.
  assert.equal((await f.push(removeExercise(d, 'row-x'), 1)).status, 200);
  f.db.raw.prepare('DELETE FROM sync_account_data_features WHERE user_id=?').run(f.id);
  assert.deepEqual(await code(await f.call('pull', {}, '2')), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED'], 'rows alone are enough');
  assert.deepEqual(await code(await f.call('records', {}, '2')), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED']);
  // Stored level 3 but the draft finished (no marker left in the rows): still refused (permanent level).
  const g = await fixture(); assert.equal((await g.push(d, 0)).status, 200);
  const removed = removeExercise(d, 'row-x'); assert.equal((await g.push(removed, 1)).status, 200);
  const done = clone(removed); done.draft = null; assert.equal((await g.push(strip(done), 2)).status, 200);
  assert.deepEqual(await code(await g.call('pull', {}, '2')), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED'], 'permanent: refused after the draft is gone');
  // Every successful old-client read in this file returned no marker.
  for (const fx of [await fixture()]) {
    assert.equal((await fx.push(d, 0)).status, 200);
    const body = await (await fx.call('pull', {}, '2')).json();
    assert.equal(JSON.stringify(body.data).includes('removedExercises'), false);
  }
}

// 9. Hardening (Guardian r4 BM5): a stored exercise without a string id never makes later pushes of that draft stale.
{
  const f = await fixture(); const d = base(); d.draft.exercises.push({ exerciseId: 'legacy-no-id' });
  assert.equal((await f.push(strip(d), 0)).status, 200);
  const next = clone(d); next.draft.exercises = next.draft.exercises.filter(item => item.id); next.draft.dayName = 'Push again';
  assert.equal((await f.push(strip(next), 1)).status, 200, 'an id-less entry is not a removal');
}
// 10. Receipt replay keeps precedence (Guardian r4 BM7): a mutation an old client committed BEFORE level 3 is answered from its receipt
// when replayed after the raise (it changes nothing); a NEW mutation of that client is refused.
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
  const body = { mutationId: 'replay-1', baseRevision: 1, clientSchemaVersion: 8, upserts: { measurements: [{ id: 'm1', recordedAt: '2026-11-17T07:00:00.000Z', weightKg: 80 }] } };
  const first = await f.call('records/mutations', { method: 'POST', body: JSON.stringify(body) }, '2');
  assert.equal(first.status, 200);
  const committed = await first.json();
  assert.equal((await f.push(removeExercise(clone((await f.pull()).data), 'row-x'), 2)).status, 200);
  assert.equal(f.level().level, 3);
  const replay = await f.call('records/mutations', { method: 'POST', body: JSON.stringify(body) }, '2');
  assert.equal(replay.status, 200, 'the receipt answers the replay');
  assert.deepEqual(await replay.json(), committed);
  await refused(f, () => f.call('records/mutations', { method: 'POST', body: JSON.stringify({ ...body, mutationId: 'replay-2', baseRevision: 3 }) }, '2'), 'SYNC_CLIENT_UPGRADE_REQUIRED');
}

// 11. Read gate completeness (Guardian r5 MINOR-R5-4 / R5-1 / R5-2).
{
  // Paged read with the stored level only (draft finished, no marker left): refused; and the level really comes from the page statement.
  const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
  const removed = removeExercise(d, 'row-x'); assert.equal((await f.push(removed, 1)).status, 200);
  const done = clone(removed); done.draft = null; assert.equal((await f.push(strip(done), 2)).status, 200);
  assert.equal(JSON.stringify((await f.pull()).data).includes('removedExercises'), false, 'premise: no marker left');
  assert.deepEqual(await code(await f.call('records', {}, '2')), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED'], 'paged read: stored level alone refuses');
  assert.equal((await f.call('records', {}, '3')).status, 200);
  // Legacy-authority account (user_data document) whose draft carries the marker: refused for an old client, served to Build 57.
  const g = await fixture();
  const legacy = removeExercise(base(), 'row-x');
  g.db.raw.prepare('INSERT INTO user_data (user_id,payload_json,sync_version,updated_at) VALUES (?,?,3,?)').run(g.id, JSON.stringify(legacy), '2026-11-18T00:00:00.000Z');
  assert.deepEqual(await code(await g.call('pull', {}, '2')), [409, 'SYNC_CLIENT_UPGRADE_REQUIRED'], 'legacy document with the marker: refused');
  assert.equal((await g.call('pull', {}, '3')).status, 200);
  // A legacy document the record split would reject (a session without an id) still pulls for every client (as on 8f49687).
  const h = await fixture();
  const odd = base(); odd.sessions = [{ title: 'no id', sets: [] }];
  h.db.raw.prepare('INSERT INTO user_data (user_id,payload_json,sync_version,updated_at) VALUES (?,?,1,?)').run(h.id, JSON.stringify(odd), '2026-11-18T00:00:00.000Z');
  for (const header of ['2', '3']) assert.equal((await h.call('pull', {}, header)).status, 200, 'odd legacy document pulls, level ' + header);
  // Fail closed: a database error while reading the stored level refuses the old client's read (never served by accident).
  const k = await fixture(); assert.equal((await k.push(d, 0)).status, 200);
  const original = k.db.prepare.bind(k.db);
  k.db.prepare = sql => { if (/SELECT level FROM sync_account_data_features WHERE user_id=\?$/.test(sql.trim())) throw new Error('D1_ERROR: database is locked'); return original(sql); };
  const broken = await k.call('pull', {}, '2');
  assert.notEqual(broken.status, 200, 'a failing level read never serves an old client');
  assert.equal((await k.call('pull', {}, '3')).status, 200, 'Build 57 does not need the level read');
  k.db.prepare = original;
}

// 12. Release safety: with DRAFT_EXERCISE_REMOVAL_ENABLED=false (or set deletion off) the server refuses every NEW removal marker —
// direct API push, record mutation and staged publication — so no account reaches level 3; an account already at level 3 keeps
// syncing and finishing its existing draft.
{
  const OFF = { DRAFT_EXERCISE_REMOVAL_ENABLED: 'false' };
  const pushEnv = (f, data, v, env) => f.call('push', { method: 'POST', body: JSON.stringify({ data, syncVersion: v }) }, '3', env);
  const mutate = (f, rev, metadata, env) => f.call('records/mutations', { method: 'POST', body: JSON.stringify({ mutationId: `off-${++ids}`, baseRevision: rev, clientSchemaVersion: 8, metadata }) }, '3', env);
  const marked = f => f.dump().includes('removedExercises');

  // (a) Direct API push of a first removal, a new draft carrying an (empty) marker, and a marker nested deeper in the draft row.
  for (const env of [OFF, { DRAFT_SET_DELETION_ENABLED: 'false' }]) {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    await refused(f, () => pushEnv(f, removeExercise(d, 'row-x'), 1, env), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    const fresh = clone(d); fresh.draft.id = 'draft-2'; fresh.draft.removedExercises = [];
    await refused(f, () => pushEnv(f, strip(fresh), 1, env), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    const nested = clone(d); nested.draft.exercises[0].removedExercises = [];
    await refused(f, () => pushEnv(f, strip(nested), 1, env), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    assert.equal(f.level(), null); assert.equal(marked(f), false);
    // Everything else still syncs with the switch off: a normal edit and the finish.
    assert.equal((await pushEnv(f, addSet(d, 'row-y'), 1, env)).status, 200, 'normal draft edit accepted');
    const done = clone(d); done.draft = null; assert.equal((await pushEnv(f, strip(done), 2, env)).status, 200, 'finish accepted');
    // Capability and enforcement read the same switch.
    assert.equal((await (await f.call('capabilities', {}, '3', env)).json()).draftExerciseRemoval, undefined);
  }
  // (b) An account already at level 3 (removal made while the switch was on) keeps its draft working after the switch is off.
  {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    const removed = removeExercise(d, 'row-x'); assert.equal((await f.push(removed, 1)).status, 200);
    assert.deepEqual(f.level(), { level: 3, raised_revision: 2 });
    const edited = addSet(removed, 'row-y'); assert.equal((await pushEnv(f, edited, 2, OFF)).status, 200, 'existing marked draft: edit accepted');
    assert.equal((await pushEnv(f, clone(edited), 3, OFF)).status, 200, 'same marker list re-sent (second phone union): accepted');
    await refused(f, () => pushEnv(f, removeExercise(edited, 'row-y'), 4, OFF), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    const swapped = clone(edited); swapped.draft.removedExercises = ['row-empty']; swapped.draft.exercises = swapped.draft.exercises.filter(item => item.id !== 'row-empty');
    await refused(f, () => pushEnv(f, strip(swapped), 4, OFF), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    const other = clone(edited); other.draft.id = 'draft-9';
    await refused(f, () => pushEnv(f, strip(other), 4, OFF), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    // Record mutation path, same account: the existing marker passes, a new id is refused.
    assert.equal((await mutate(f, 4, { draft: addSet(edited, 'row-y').draft }, OFF)).status, 200, 'mutation: existing marked draft accepted');
    const current = (await f.pull()).data;
    await refused(f, () => mutate(f, 5, { draft: removeExercise(current, 'row-y').draft }, OFF), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    const finished = clone(current); finished.draft = null; assert.equal((await pushEnv(f, strip(finished), 5, OFF)).status, 200, 'finish accepted');
    const next = clone(base()); next.draft.id = 'draft-new';
    assert.equal((await pushEnv(f, strip(next), 6, OFF)).status, 200, 'a new workout without a marker starts normally');
    assert.equal((await f.pull()).data.draft.removedExercises, undefined);
  }
  // (c) Record mutation path on a level-0 account: the first removal is refused; with the switch on it is accepted (same request shape).
  {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    await refused(f, () => mutate(f, 1, { draft: removeExercise(d, 'row-x').draft }, OFF), 'SYNC_EXERCISE_REMOVAL_DISABLED');
    assert.equal(f.level(), null);
    const on = await mutate(f, 1, { draft: removeExercise(d, 'row-x').draft }, {});
    assert.equal(on.status, 200, 'switch on: the mutation removal is accepted ' + JSON.stringify(await on.clone().json()));
    assert.equal(f.level().level, 3);
  }
  // (d) Race: a normal edit and a direct-API removal on the same base revision, both orders and concurrently — never a marker.
  for (const order of ['edit-first', 'removal-first', 'concurrent']) {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    const edit = () => pushEnv(f, addSet(d, 'row-y'), 1, OFF); const removal = () => pushEnv(f, removeExercise(d, 'row-x'), 1, OFF);
    let results;
    if (order === 'concurrent') results = await Promise.all([edit(), removal()]);
    else if (order === 'edit-first') { const e = await edit(); results = [e, await removal()]; }
    else { const r = await removal(); results = [await edit(), r]; }
    assert.equal(results[0].status, 200, `${order}: the edit lands`);
    assert.equal(results[1].status, 409, `${order}: the removal is refused`);
    assert.equal(marked(f), false); assert.equal(f.level(), null);
  }
  // (e) Staged SYNC publication (records/operations): a snapshot whose draft brings a new marker is refused at commit; the same
  // snapshot is published with the switch on (proves the refusal is this rule).
  // Stages `data` as a SYNC publication on revision `rev` and commits it; returns [status, body] of the commit.
  const stagedCommit = async (f, env, data, rev) => {
    const op = async (action, body, id) => { const r = await f.call(`records/operations${id ? `/${id}/${action}` : ''}`, { method: 'POST', body: JSON.stringify(body) }, '3', env); return [r.status, await r.json()]; };
    const roots = Object.entries(data).map(([field, record]) => ({ kind: 'metadata', field, record }));
    const zero = { sessions: 0, sets: 0, programs: 0, days: 0, sections: 0, exercises: 0, measurements: 0, gyms: 0, importHistory: 0 };
    const [s, started] = await op('start', { sourceNamespace: 'src', archiveRetryHash: 'a'.repeat(64), localBinding: 'l', dataSchemaVersion: 8, expectedChunks: 1, expectedCounts: zero, baseRevision: rev });
    assert.equal(s, 200, JSON.stringify(started));
    const [c, chunked] = await op('chunks', { localBinding: 'l', index: 0, roots }, started.operationId); assert.equal(c, 200, JSON.stringify(chunked));
    let ready; for (let i = 0; i < 50; i++) { const [status, body] = await op('finalize', { localBinding: 'l', generationId: ready?.generationId }, started.operationId); assert.equal(status, 200, JSON.stringify(body)); ready = body; if (body.status === 'READY') break; }
    assert.equal(ready.status, 'READY');
    return op('commit', { localBinding: 'l', confirm: true, confirmationDigest: ready.confirmationDigest, semanticDigest: ready.semanticDigest, baseRevision: rev }, started.operationId);
  };
  for (const env of [OFF, {}]) {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    const before = f.dump(); const [status, body] = await stagedCommit(f, env, removeExercise(d, 'row-x'), 1);
    if (env === OFF) {
      assert.deepEqual([status, body.code], [409, 'SYNC_EXERCISE_REMOVAL_DISABLED']); assert.equal(f.dump(), before); assert.equal(f.level(), null);
    } else {
      assert.equal(status, 200, JSON.stringify(body)); assert.equal(f.level().level, 3);
    }
  }
  // (f) Guardian r1 MINOR-1: a level-3 account with the switch off publishes its EXISTING marked draft through the staged path;
  // the same draft id with a new removed id is refused there.
  {
    const f = await fixture(); const d = base(); assert.equal((await f.push(d, 0)).status, 200);
    const removed = removeExercise(d, 'row-x'); assert.equal((await f.push(removed, 1)).status, 200);
    const edited = addSet(removed, 'row-y');
    const [ok, okBody] = await stagedCommit(f, OFF, edited, 2);
    assert.equal(ok, 200, 'staged publication of the existing marked draft ' + JSON.stringify(okBody));
    assert.deepEqual((await f.pull()).data.draft, edited.draft);
    const before = f.dump(); const [status, body] = await stagedCommit(f, OFF, removeExercise(edited, 'row-y'), 3);
    assert.deepEqual([status, body.code], [409, 'SYNC_EXERCISE_REMOVAL_DISABLED']); assert.equal(f.dump(), before);
  }
}

console.log('draft exercise removal (B57-002) tests passed');
