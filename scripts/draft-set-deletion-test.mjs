// Build 51 (B51-004): mobile active-workout set deletion through the real Worker push/pull on SQLite D1.
// A schema 8 draft row may lose sets and renumber the later ones only by exactly the deletions the client declares
// (`deletedSetCount[row]` grows by d); removed sets must be fully known, kept sets keep every field under their new key,
// only additions may follow. Rows without a declared deletion keep the old per-key rule (older clients unchanged).
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { compatible } from '../worker/record-sync-storage.js';
import { createD1 } from './lib/d1-sqlite.mjs';

const ORIGIN = 'https://fixtures.example';
const clone = value => structuredClone(value);
let sequence = 0;
async function fixture(options = {}) {
  const db = createD1(options); const id = `u-${++sequence}`; const token = `local-token-${sequence}`;
  db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'h','s','2026-10-08')").run(id,`${id}@example.test`);
  db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'2026-10-08','2099-01-01')").run(`auth-${id}`,id,await tokenDigest(token));
  const call = (route, init = {}, level = '1') => worker.fetch(new Request(`${ORIGIN}/api/sync/${route}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(level ? { 'X-Reptrio-Data-Level': level } : {}), ...init.headers } }), { DB: db }, { waitUntil() {} });
  const push = (data, syncVersion, level) => call('push',{method:'POST',body:JSON.stringify({data,syncVersion})},level);
  const pull = async () => { const r = await call('pull'); assert.equal(r.status,200); return r.json(); };
  const dump = () => JSON.stringify(db.rows('SELECT * FROM sync_records ORDER BY kind,record_key'));
  return { db, push, pull, call, dump };
}
const code = async response => [response.status,(await response.json()).code];
const refused = async (f,action) => { const before = f.dump(); assert.deepEqual(await code(await action()),[409,'SYNC_SCHEMA_LOSS_RISK']); assert.equal(f.dump(),before,'nothing written'); };

const set = (n, over = {}) => ({ exerciseId: 'bench', setNumber: n, weight: String(60 + n * 5), reps: '8', rir: '', rpe: '', rest: '', tempo: '', note: '', completed: true, startedAt: `2026-10-29T08:0${n}:00.000Z`, completedAt: `2026-10-29T08:0${n}:30.000Z`, ...over });
const base = () => ({
  schemaVersion: 8, programs: [], sessions: [], measurements: [],
  draft: { id: 'draft-1', programId: null, dayId: null, dayName: 'Push', startedAt: '2026-10-29T08:00:00.000Z', lastEditedAt: '2026-10-29T08:05:00.000Z', watchStateRevision: 4,
    exercises: [{ id: 'row-bench', exerciseId: 'bench' }, { id: 'row-ohp', exerciseId: 'ohp' }],
    sets: { 'row-bench': { 1: set(1), 2: set(2, { note: 'grip' }), 3: set(3, { completed: false, completedAt: undefined, startedAt: undefined }) }, 'row-ohp': { 1: set(1, { exerciseId: 'ohp' }) } },
    restTimer: null },
});
// Mobile deleteSetFromDraft: drop key r, later sets move down one key with their own values, bookkeeping grows.
function deleteSet(data, row, key, revision) {
  const next = clone(data); const rows = next.draft.sets[row]; const keys = Object.keys(rows).map(Number).sort((a,b) => a-b);
  const out = {};
  for (const k of keys) { if (k === key) continue; const target = k > key ? k - 1 : k; out[target] = { ...rows[k], setNumber: target }; }
  next.draft.sets[row] = out;
  next.draft.watchStateRevision = revision;
  next.draft.setLayoutFence = { ...(next.draft.setLayoutFence || {}), [row]: revision };
  next.draft.deletedSetCount = { ...(next.draft.deletedSetCount || {}), [row]: ((next.draft.deletedSetCount || {})[row] || 0) + 1 };
  return JSON.parse(JSON.stringify(next));
}
const strip = value => JSON.parse(JSON.stringify(value));

// 1. Middle set deleted, set 3 becomes 2 with its own values; the other row untouched. Pull returns exactly it.
{
  const f = await fixture(); const d = strip(base()); assert.equal((await f.push(d,0)).status,200);
  const deleted = deleteSet(d,'row-bench',2,5);
  assert.equal((await f.push(deleted,1)).status,200);
  assert.deepEqual((await f.pull()).data,deleted);
  // A later delete of set 1 in the same row (count 1 → 2) and finishing the workout (draft cleared with the bookkeeping).
  const again = deleteSet(deleted,'row-bench',1,6); assert.equal((await f.push(again,2)).status,200);
  const finished = clone(again); finished.draft = null; finished.sessions = [{ id: 's1', title: 'Push', startedAt: again.draft.startedAt, completedAt: '2026-10-29T09:00:00.000Z', sets: again.draft.sets }];
  assert.equal((await f.push(finished,3)).status,200,'finish clears a draft carrying setLayoutFence / deletedSetCount');
  assert.deepEqual((await f.pull()).data,finished);
}
// 2. Without a declared deletion (old client / bug) the same shape is refused exactly as before; so is a bump of the
//    fence alone.
{
  const f = await fixture(); const d = strip(base()); assert.equal((await f.push(d,0)).status,200);
  const undeclared = deleteSet(d,'row-bench',2,5); delete undeclared.draft.deletedSetCount;
  await refused(f,() => f.push(undeclared,1));
  const otherRow = deleteSet(d,'row-bench',2,5); otherRow.draft.deletedSetCount = { 'row-ohp': 1 };
  await refused(f,() => f.push(otherRow,1));
  const shrunk = deleteSet(d,'row-bench',2,5); shrunk.draft.deletedSetCount = { 'row-bench': 0 };
  await refused(f,() => f.push(shrunk,1));
}
// 3. Exactly d removals: a kept (renumbered) set that also lost a known or unknown field cannot be explained as a second
//    removal; two sets gone with one declared deletion is refused; a removed set with an unknown field is never discarded.
{
  const f = await fixture(); const d = strip(base()); d.draft.sets['row-bench'][3].privateFuture = { keep: true }; assert.equal((await f.push(d,0)).status,200);
  const lostKnown = deleteSet(d,'row-bench',1,5); delete lostKnown.draft.sets['row-bench'][1].note; lostKnown.draft.sets['row-bench'][1].note = undefined;
  const fieldGone = strip(lostKnown); assert.ok(!('note' in fieldGone.draft.sets['row-bench'][1]));
  await refused(f,() => f.push(fieldGone,1));
  const lostUnknown = deleteSet(d,'row-bench',1,5); delete lostUnknown.draft.sets['row-bench'][2].privateFuture;
  await refused(f,() => f.push(lostUnknown,1));
  const twoGone = deleteSet(deleteSet(d,'row-bench',1,5),'row-bench',1,6); twoGone.draft.deletedSetCount = { 'row-bench': 1 };
  await refused(f,() => f.push(twoGone,1));
  const unknownRemoved = deleteSet(d,'row-bench',3,5);
  await refused(f,() => f.push(unknownRemoved,1));
  // Reordered rows are not a deletion.
  const swapped = deleteSet(d,'row-bench',1,5); const rows = swapped.draft.sets['row-bench']; swapped.draft.sets['row-bench'] = { 1: { ...rows[2], setNumber: 1 }, 2: { ...rows[1], setNumber: 2 } };
  await refused(f,() => f.push(swapped,1));
}
// 4. Offline: two deletions declared together; delete + add a set in one push; undo of a completion on a renumbered set.
{
  const f = await fixture(); const d = strip(base()); assert.equal((await f.push(d,0)).status,200);
  const two = deleteSet(deleteSet(d,'row-bench',1,5),'row-bench',1,6); assert.equal((await f.push(two,1)).status,200);
  const g = await fixture(); assert.equal((await g.push(d,0)).status,200);
  const plusOne = deleteSet(d,'row-bench',2,5); plusOne.draft.sets['row-bench'][3] = { exerciseId: 'bench', setNumber: 3, weight: '75', reps: '8', rir: '', rpe: '', rest: '', tempo: '', note: '', completed: false };
  assert.equal((await g.push(plusOne,1)).status,200,'deleted then added');
  const h = await fixture(); assert.equal((await h.push(d,0)).status,200);
  const undo = deleteSet(d,'row-bench',1,5); const moved = undo.draft.sets['row-bench'][1]; delete moved.completedAt; moved.completed = false;
  assert.equal((await h.push(undo,1)).status,200,'true→false completion undo keeps working on the new key');
}
// 4b. Ten or more sets: keys are ordered numerically (10 after 9), so the renumbering of 3..11 down to 2..10 is explained.
{
  const f = await fixture(); const d = strip(base()); d.draft.sets['row-bench'] = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, set(i + 1, { weight: String(100 + i), startedAt: `2026-10-29T08:${String(10 + i).padStart(2, '0')}:00.000Z`, completedAt: `2026-10-29T08:${String(10 + i).padStart(2, '0')}:30.000Z` })]));
  d.draft.sets['row-bench'][11].privateFuture = { keep: true }; // only the numeric order pairs it with new key 10
  assert.equal((await f.push(d,0)).status,200);
  const deleted = deleteSet(d,'row-bench',2,5); assert.equal((await f.push(deleted,1)).status,200);
  assert.deepEqual((await f.pull()).data,deleted);
}
// 5. Older client: drops the bookkeeping (unknown to it) but keeps the layout → accepted; it still cannot delete sets.
{
  const f = await fixture(); const d = strip(base()); assert.equal((await f.push(d,0)).status,200);
  const deleted = deleteSet(d,'row-bench',2,5); assert.equal((await f.push(deleted,1)).status,200);
  const old = clone(deleted); delete old.draft.setLayoutFence; delete old.draft.deletedSetCount;
  assert.equal((await f.push(old,2,'1')).status,200,'older client drops the omittable bookkeeping');
  const oldDelete = clone(old); delete oldDelete.draft.sets['row-bench'][2];
  await refused(f,() => f.push(oldDelete,3));
  // Level 0 shape knows the bookkeeping too.
  const z = await fixture(); assert.equal((await z.push(d,0,null)).status,200); assert.equal((await z.push(deleteSet(d,'row-bench',2,5),1,null)).status,200);
}
// 6. A different draft (new workout) is not a relayout of the previous one.
{
  const f = await fixture(); const d = strip(base()); assert.equal((await f.push(d,0)).status,200);
  const other = deleteSet(d,'row-bench',2,5); other.draft.id = 'draft-2';
  await refused(f,() => f.push(other,1));
}
// 7. Pure rule (also used by the staged record transport for the draft metadata row) and capability.
{
  const d = strip(base()); const next = deleteSet(d,'row-bench',2,5);
  assert.deepEqual(compatible(d,next,1).draft.sets['row-bench'],next.draft.sets['row-bench']);
  assert.throws(() => compatible(d,{ ...next, draft: { ...next.draft, deletedSetCount: undefined } },1),{ code: 'SYNC_SCHEMA_LOSS_RISK' });
  const f = await fixture(); assert.equal((await (await f.call('capabilities')).json()).draftSetDeletion,1);
  const missing = await fixture({ migrationsUpTo: '0007_password_reset_tokens.sql' }); assert.equal((await (await missing.call('capabilities')).json()).draftSetDeletion,undefined,'not writable → no capability');
}
console.log('Draft set deletion PASS: declared deletions only, renumbered sets keep every field, unknown never discarded, offline multi-delete / delete+add / undo, older clients unchanged, finish clears bookkeeping, capability.');
