// Build 51 (B51-004): mobile active-workout set deletion through the real Worker push/pull on SQLite D1.
// Every deletion is an entry of `setDeletionLog[row]` ({id, key}). For the same draft id the server's log must be a prefix of
// the incoming log (else SYNC_DRAFT_LAYOUT_STALE: a copy without a deletion the server holds could bring the set back); the new
// entries map previous keys to new keys exactly; removed sets must be fully known, kept sets keep every field under their new
// key, only additions follow. Rows without new entries keep the per-key rule (older clients unchanged).
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { compatible, compatibleStorageRow } from '../worker/record-sync-storage.js';
import { createD1 } from './lib/d1-sqlite.mjs';

const ORIGIN = 'https://fixtures.example';
const clone = value => structuredClone(value);
let sequence = 0;
async function fixture(options = {}) {
  const db = createD1(options); const id = `u-${++sequence}`; const token = `local-token-${sequence}`;
  db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'h','s','2026-10-08')").run(id,`${id}@example.test`);
  db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'2026-10-08','2099-01-01')").run(`auth-${id}`,id,await tokenDigest(token));
  const call = (route, init = {}, level = '1', env = {}) => worker.fetch(new Request(`${ORIGIN}/api/sync/${route}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(level ? { 'X-Reptrio-Data-Level': level } : {}), ...init.headers } }), { DB: db, ...env }, { waitUntil() {} });
  const push = (data, syncVersion, level) => call('push',{method:'POST',body:JSON.stringify({data,syncVersion})},level);
  const pull = async () => { const r = await call('pull'); assert.equal(r.status,200); return r.json(); };
  const dump = () => JSON.stringify(db.rows('SELECT * FROM sync_records ORDER BY kind,record_key'));
  return { db, push, pull, call, dump };
}
const code = async response => [response.status,(await response.json()).code];
const refused = async (f, action, expected = 'SYNC_SCHEMA_LOSS_RISK') => { const before = f.dump(); assert.deepEqual(await code(await action()),[expected === 'SYNC_PAYLOAD_INVALID' ? 400 : 409, expected]); assert.equal(f.dump(),before,'nothing written'); };

const set = (n, over = {}) => ({ exerciseId: 'bench', setNumber: n, weight: String(60 + n * 5), reps: '8', rir: '', rpe: '', rest: '', tempo: '', note: '', completed: true, startedAt: `2026-10-29T08:0${n}:00.000Z`, completedAt: `2026-10-29T08:0${n}:30.000Z`, ...over });
const strip = value => JSON.parse(JSON.stringify(value));
const base = () => strip({
  schemaVersion: 8, programs: [], sessions: [], measurements: [],
  draft: { id: 'draft-1', programId: null, dayId: null, dayName: 'Push', startedAt: '2026-10-29T08:00:00.000Z', lastEditedAt: '2026-10-29T08:05:00.000Z', watchStateRevision: 4,
    exercises: [{ id: 'row-bench', exerciseId: 'bench' }, { id: 'row-ohp', exerciseId: 'ohp' }],
    sets: { 'row-bench': { 1: set(1), 2: set(2, { note: 'grip' }), 3: set(3, { completed: false, completedAt: undefined, startedAt: undefined }) }, 'row-ohp': { 1: set(1, { exerciseId: 'ohp' }) } },
    restTimer: null },
});
let ids = 0;
// Mobile deleteSetFromDraft: drop key, later sets move down one key with their own values, the log gets one entry.
function deleteSet(data, row, key, revision = (data.draft.watchStateRevision || 0) + 1) {
  const next = clone(data); const rows = next.draft.sets[row]; const keys = Object.keys(rows).map(Number).sort((a,b) => a-b);
  const out = {};
  for (const k of keys) { if (k === key) continue; const target = k > key ? k - 1 : k; out[target] = { ...rows[k], setNumber: target }; }
  next.draft.sets[row] = out;
  next.draft.watchStateRevision = revision;
  next.draft.setLayoutFence = { ...(next.draft.setLayoutFence || {}), [row]: revision };
  next.draft.setDeletionLog = { ...(next.draft.setDeletionLog || {}), [row]: [...((next.draft.setDeletionLog || {})[row] || []), { id: `del-${++ids}`, key }] };
  return strip(next);
}
const addSet = (data, row) => { const next = clone(data); const n = Object.keys(next.draft.sets[row]).length + 1; next.draft.sets[row][n] = { exerciseId: 'bench', setNumber: n, weight: '75', reps: '8', rir: '', rpe: '', rest: '', tempo: '', note: '', completed: false }; return next; };

// 1. Middle set deleted, set 3 becomes 2 with its own values; another deletion; the LAST set (row stays {}); finish.
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d,0)).status,200);
  const deleted = deleteSet(d,'row-bench',2); assert.equal((await f.push(deleted,1)).status,200);
  assert.deepEqual((await f.pull()).data,deleted);
  const again = deleteSet(deleted,'row-bench',1); assert.equal((await f.push(again,2)).status,200);
  const empty = deleteSet(again,'row-bench',1); assert.deepEqual(empty.draft.sets['row-bench'], {}, 'last set deleted, row kept');
  assert.equal((await f.push(empty,3)).status,200,'the last set of an exercise can be deleted');
  assert.deepEqual((await f.pull()).data.draft.sets['row-bench'], {});
  const refill = addSet(empty,'row-bench'); assert.equal((await f.push(refill,4)).status,200,'a set added to the empty row');
  const finished = clone(refill); finished.draft = null; finished.sessions = [{ id: 's1', title: 'Push', startedAt: refill.draft.startedAt, completedAt: '2026-10-29T09:00:00.000Z', sets: refill.draft.sets }];
  assert.equal((await f.push(finished,5)).status,200,'finish clears a draft carrying setLayoutFence / setDeletionLog');
  assert.deepEqual((await f.pull()).data,finished);
}
// 2. Stale copies: a push whose log lacks a deletion the server holds is refused (another phone / older copy), whether the
//    log is missing, shorter, or of equal length but different; nothing written.
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d,0)).status,200);
  const deleted = deleteSet(d,'row-bench',2); assert.equal((await f.push(deleted,1)).status,200);
  const staleOld = clone(d); staleOld.draft.sets['row-ohp'][1].reps = '12'; // phone B's unrelated edit on the old copy
  await refused(f,() => f.push(staleOld,2),'SYNC_DRAFT_LAYOUT_STALE');
  const dropped = clone(deleted); delete dropped.draft.setDeletionLog;
  await refused(f,() => f.push(dropped,2),'SYNC_DRAFT_LAYOUT_STALE');
  const other = deleteSet(d,'row-bench',1); // phone B deleted a different set from the same base: equal length, different log
  await refused(f,() => f.push(other,2),'SYNC_DRAFT_LAYOUT_STALE');
  const otherRow = clone(deleted); otherRow.draft.setDeletionLog = { 'row-ohp': deleted.draft.setDeletionLog['row-bench'] };
  await refused(f,() => f.push(otherRow,2),'SYNC_DRAFT_LAYOUT_STALE');
  const tampered = clone(deleted); tampered.draft.setDeletionLog['row-bench'] = [{ ...deleted.draft.setDeletionLog['row-bench'][0], key: 3 }];
  await refused(f,() => f.push(tampered,2),'SYNC_DRAFT_LAYOUT_STALE'); // same entry id, another removed key: not the same history
  // The server copy plus a new deletion on top is accepted.
  assert.equal((await f.push(deleteSet(deleted,'row-ohp',1),2)).status,200);
}
// 3. Mapping exactness: kept sets may not lose a known or unknown field; a removed set with an unknown field is never
//    discarded; a deletion not reflected in the sets (row unchanged) is refused; malformed logs are invalid.
{
  const f = await fixture(); const d = base(); d.draft.sets['row-bench'][3].privateFuture = { keep: true }; assert.equal((await f.push(d,0)).status,200);
  const lostKnown = deleteSet(d,'row-bench',1); delete lostKnown.draft.sets['row-bench'][1].note;
  await refused(f,() => f.push(lostKnown,1));
  const lostUnknown = deleteSet(d,'row-bench',1); delete lostUnknown.draft.sets['row-bench'][2].privateFuture;
  await refused(f,() => f.push(lostUnknown,1));
  await refused(f,() => f.push(deleteSet(d,'row-bench',3),1));
  const notApplied = clone(d); notApplied.draft.setDeletionLog = { 'row-bench': [{ id: 'x1', key: 1 }] };
  await refused(f,() => f.push(notApplied,1));
  const swapped = deleteSet(d,'row-bench',1); const rows = swapped.draft.sets['row-bench']; swapped.draft.sets['row-bench'] = { 1: { ...rows[2], setNumber: 1 }, 2: { ...rows[1], setNumber: 2 } };
  await refused(f,() => f.push(swapped,1));
  const dup = clone(d); dup.draft.setDeletionLog = { 'row-bench': [{ id: 'a', key: 9 }, { id: 'a', key: 9 }] };
  await refused(f,() => f.push(dup,1),'SYNC_PAYLOAD_INVALID');
  const bad = clone(d); bad.draft.setDeletionLog = { 'row-bench': [{ id: 'a', key: 0 }] };
  await refused(f,() => f.push(bad,1),'SYNC_PAYLOAD_INVALID');
  const long = clone(d); long.draft.setDeletionLog = { 'row-bench': Array.from({ length: 201 }, (_, i) => ({ id: `l${i}`, key: 99 })) };
  await refused(f,() => f.push(long,1),'SYNC_PAYLOAD_INVALID');
}
// 4. Offline sequences between pushes: two deletions; delete + add; add + delete the added set (key beyond the mapped sets);
//    a completion undone on a renumbered set; ten-plus sets (numeric order).
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d,0)).status,200);
  assert.equal((await f.push(deleteSet(deleteSet(d,'row-bench',1),'row-bench',1),1)).status,200);
  const g = await fixture(); assert.equal((await g.push(d,0)).status,200);
  assert.equal((await g.push(addSet(deleteSet(d,'row-bench',2),'row-bench'),1)).status,200,'deleted then added');
  const h = await fixture(); assert.equal((await h.push(d,0)).status,200);
  assert.equal((await h.push(deleteSet(addSet(d,'row-bench'),'row-bench',4),1)).status,200,'added then deleted the added set');
  // Deleting a post-sync addition never makes an earlier set unprotected: set 3 losing an unknown field is still refused.
  const p = await fixture(); const withFuture = base(); withFuture.draft.sets['row-bench'][3].privateFuture = { keep: true }; assert.equal((await p.push(withFuture,0)).status,200);
  const sneaky = deleteSet(addSet(withFuture,'row-bench'),'row-bench',4); delete sneaky.draft.sets['row-bench'][3].privateFuture;
  await refused(p,() => p.push(sneaky,1));
  const u = await fixture(); assert.equal((await u.push(d,0)).status,200);
  const undo = deleteSet(d,'row-bench',1); const moved = undo.draft.sets['row-bench'][1]; delete moved.completedAt; moved.completed = false;
  assert.equal((await u.push(undo,1)).status,200,'true→false completion undo keeps working on the new key');
  const t = await fixture(); const big = base(); big.draft.sets['row-bench'] = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, set(i + 1)]));
  big.draft.sets['row-bench'][11].privateFuture = { keep: true };
  assert.equal((await t.push(big,0)).status,200);
  const bigDeleted = deleteSet(big,'row-bench',2); assert.equal((await t.push(bigDeleted,1)).status,200);
  assert.deepEqual((await t.pull()).data.draft.sets['row-bench'][10].privateFuture, { keep: true }, 'former set 11 is now set 10');
}
// 5. Older client: one that pulled after the deletion keeps the log (Build 50 keeps unknown draft fields) and is accepted;
//    a stale one without it is refused (blocked, never corrupting); it still cannot delete sets without a log entry.
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d,0)).status,200);
  const deleted = deleteSet(d,'row-bench',2); assert.equal((await f.push(deleted,1)).status,200);
  const pulledOld = clone(deleted); pulledOld.draft.sets['row-ohp'][1].reps = '10';
  assert.equal((await f.push(pulledOld,2,'1')).status,200,'old client that pulled the log');
  const oldDelete = clone(pulledOld); delete oldDelete.draft.sets['row-bench'][2];
  await refused(f,() => f.push(oldDelete,3));
  const z = await fixture(); assert.equal((await z.push(d,0,null)).status,200); assert.equal((await z.push(deleteSet(d,'row-bench',2),1,null)).status,200,'level 0 shape knows the bookkeeping');
}
// 6. A different draft (new workout) is not a relayout; a new draft id with its own log starts fresh.
{
  const f = await fixture(); const d = base(); assert.equal((await f.push(d,0)).status,200);
  const other = deleteSet(d,'row-bench',2); other.draft.id = 'draft-2';
  await refused(f,() => f.push(other,1));
  const fresh = base(); fresh.draft.id = 'draft-3'; assert.equal((await f.push(fresh,1)).status,200);
}
// 7. Pure rule, staged transport (metadata row → compatible) and capability (+ operational switch).
{
  const d = base(); const next = deleteSet(d,'row-bench',2);
  assert.deepEqual(compatible(d,next,1).draft.sets['row-bench'],next.draft.sets['row-bench']);
  assert.throws(() => compatible(next,d,1),{ code: 'SYNC_DRAFT_LAYOUT_STALE' });
  const row = data => ({ kind: 'metadata', address_json: JSON.stringify({ field: 'draft' }), payload_json: JSON.stringify(data.draft) });
  assert.deepEqual(compatibleStorageRow(row(d),row(next),8,1).sets['row-bench'], next.draft.sets['row-bench'], 'staged transport accepts the same relayout');
  assert.throws(() => compatibleStorageRow(row(next),row(d),8,1),{ code: 'SYNC_DRAFT_LAYOUT_STALE' }, 'and refuses the same stale copy');
  const f = await fixture(); assert.equal((await (await f.call('capabilities')).json()).draftSetDeletion,1);
  const off = await f.call('capabilities',{},'1',{ DRAFT_SET_DELETION_ENABLED: 'false' }); const offBody = await off.json();
  assert.equal(off.status,200); assert.equal(offBody.writable,true); assert.equal(offBody.draftSetDeletion, undefined, 'switched off: not offered');
  const missing = await fixture({ migrationsUpTo: '0007_password_reset_tokens.sql' }); assert.equal((await (await missing.call('capabilities')).json()).draftSetDeletion,undefined,'not writable → no capability');
}
console.log('Draft set deletion PASS: deletion log prefix guard (stale copies refused), exact key mapping, last set / empty row, unknown never discarded, offline sequences, older clients, staged transport, capability.');
