import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { finalizeImport } from '../import-service.js';
import { tokenDigest } from '../worker/account-api.js';
import { LIMITS, splitData, recordChunks } from '../worker/record-sync-storage.js';
import { createD1 } from './lib/d1-sqlite.mjs';
const ORIGIN = 'https://fixtures.example';
const clone = value => structuredClone(value);
let sequence = 0;
async function fixture(options = {}) {
  const db = createD1(options); const id = `u-${++sequence}`; const token = `local-token-${sequence}`;
  db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'h','s','2026-10-08')").run(id,`${id}@example.test`);
  db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'2026-10-08','2099-01-01')").run(`auth-${id}`,id,await tokenDigest(token));
  const call = (route, init = {}, auth = token) => worker.fetch(new Request(`${ORIGIN}/api/sync/${route}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...init.headers } }), { DB: db }, { waitUntil() {} });
  const push = (data, syncVersion = 0) => call('push',{method:'POST',body:JSON.stringify({data,syncVersion})});
  const pull = async () => { const r = await call('pull'); assert.equal(r.status,200); return r.json(); };
  const seedLegacy = (data,version=0) => db.raw.prepare('INSERT INTO user_data (user_id,payload_json,sync_version,updated_at) VALUES (?,?,?,?)').run(id,JSON.stringify(data),version,'legacy-time');
  const dump = () => JSON.stringify({ users:db.rows('SELECT * FROM users'), state: db.rows('SELECT * FROM sync_account_state'), records: db.rows('SELECT * FROM sync_records ORDER BY user_id,kind,record_key'), legacy: db.rows('SELECT * FROM user_data'), projections: ['programs','workout_sessions','workout_sets','user_settings','sync_metadata'].map(table=>db.rows(`SELECT * FROM ${table}`)) });
  return { db,id,token,call,push,pull,seedLegacy,dump };
}
const data = () => ({ schemaVersion:8, programs:[{id:'program-1', name:'raw',days:[]}], sessions:[{id:'session:α',title:'raw', sets:{'a:b':{'k:1':{exerciseId:'payload-different',setNumber:99,completed:false},'k2':{id:'optional-id',weight:'80',unknown:{opaque:true}}},empty:{},'a':{'b:k:1':{reps:'5'}}}, weightUnit:'kg'}], measurements:[{id:'m1',recordedAt:'2026-10-08',weightKg:null,waistCm:null,bodyFatPercent:null}], settings:{rest:90,unknown:{nullValue:null,primitive:7}}, arbitrary:['raw',null,true], constructor:'opaque' });
const code = async response => [response.status,(await response.json()).code];
const noWrite = async (f,action,expected) => { const before=f.dump(); f.db.resetMetrics(); assert.deepEqual(await code(await action()),expected); assert.equal(f.dump(),before); assert.equal(f.db.metrics.writes,0,'validation rejection issues zero SQL writes'); };

// Legacy read has no authority side effects; bootstrap preserves the byte-level legacy/projection footprint.
{
  const f=await fixture();const d=data();f.seedLegacy(d,7); f.db.raw.prepare("INSERT INTO programs (id,user_id,payload_json,created_at,updated_at) VALUES ('legacy-program',?,'{\"keep\":true}','old','old')").run(f.id);
  f.db.resetMetrics(); assert.deepEqual((await f.pull()).data,d);assert.equal(f.db.metrics.writes,0);assert.equal(f.db.rows('SELECT * FROM sync_account_state').length,0);
  const legacy=f.db.rows('SELECT * FROM user_data');const projection=f.db.rows('SELECT * FROM programs');
  assert.equal((await f.push(d,7)).status,200);assert.deepEqual((await f.pull()).data,d);assert.deepEqual(f.db.rows('SELECT * FROM user_data'),legacy);assert.deepEqual(f.db.rows('SELECT * FROM programs'),projection);
  const keys=f.db.rows("SELECT record_key,payload_json FROM sync_records WHERE kind='set'");
  assert.ok(keys.some(row=>row.record_key===JSON.stringify(['session:α','a:b','k:1'])));assert.ok(keys.some(row=>row.record_key===JSON.stringify(['session:α','a','b:k:1'])));assert.ok(keys.some(row=>JSON.parse(row.payload_json).id==='optional-id'));
  const before=f.db.rows('SELECT kind,record_key,created_revision,modified_revision FROM sync_records');assert.equal((await f.push(d,8)).status,200);assert.deepEqual(f.db.rows('SELECT kind,record_key,created_revision,modified_revision FROM sync_records'),before);
  const partial=clone(d);delete partial.measurements;delete partial.arbitrary;assert.equal((await f.push(partial,9)).status,200);assert.deepEqual((await f.pull()).data,d);
  const changed=clone(d);delete changed.sessions[0].sets['a:b'].k2.unknown;await noWrite(f,()=>f.push(changed,10),[409,'SYNC_SCHEMA_LOSS_RISK']);
  const pwa={schemaVersion:5,sessions:[],programs:[]};await noWrite(f,()=>f.push(pwa,10),[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const conversion=clone(d);conversion.sessions[0].sets=[];await noWrite(f,()=>f.push(conversion,10),[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);
  const absentSets=clone(d);delete absentSets.sessions[0].sets;await noWrite(f,()=>f.push(absentSets,10),[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);
}
// Whole account >2MB and <4MB: no snapshot write, each row/bind stays bounded, chunk SQL is independent of count.
{
  const f=await fixture();const d={schemaVersion:8,sessions:[],programs:Array.from({length:30},(_,i)=>({id:`p${i}`,notes:'ü'.repeat(40_000),days:[]})),measurements:[]};
  const bytes=Buffer.byteLength(JSON.stringify(d));assert.ok(bytes>2_000_000&&bytes<4_000_000);
  f.db.resetMetrics();assert.equal((await f.push(d)).status,200);assert.ok(f.db.metrics.queries<=50);assert.ok(f.db.metrics.maxParams<=100);assert.ok(f.db.metrics.maxSqlBytes<=100_000);assert.ok(f.db.metrics.maxBoundBytes<=1_800_000);assert.equal(f.db.rows('SELECT * FROM user_data').length,0);assert.deepEqual((await f.pull()).data,d);
}
// PWA array identity is stable raw ID, ordinal is address; opaque fields, ordering and primitives remain exact.
{
  const f=await fixture();const d={schemaVersion:5,programs:[{id:'pwa',schemaVersion:'1.0'}],sessions:[{id:'pwa:s',sets:[{id:'a:α',exerciseId:'X',setNumber:4,notes:{opaque:'preserve'}},{id:'b',exerciseId:'X',setNumber:4}]}],draft:null};
  assert.equal((await f.push(d)).status,200);assert.deepEqual((await f.pull()).data,d);
  const reordered=clone(d);reordered.sessions[0].sets.reverse();assert.equal((await f.push(reordered,1)).status,200);assert.deepEqual((await f.pull()).data,reordered);
  const edit=clone(reordered);edit.sessions[0].sets[0].exerciseId='Y';assert.equal((await f.push(edit,2)).status,200);
  const removed=clone(edit);removed.sessions=[];removed.programs=[];await noWrite(f,()=>f.push(removed,3),[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);
}
// Normal proven mobile deletion; tombstones remain durable even when a stale device adopts current revision.
{
  const f=await fixture();const d=data();delete d.sessions[0].sets['a:b'].k2.unknown;assert.equal((await f.push(d)).status,200);const removed=clone(d);removed.sessions=[];removed.programs=[];removed.measurements=[];assert.equal((await f.push(removed,1)).status,200);assert.deepEqual((await f.pull()).data,removed);await noWrite(f,()=>f.push(d,2),[409,'SYNC_RECORD_DELETED']);await noWrite(f,()=>f.push(d,1),[409,'SYNC_CONFLICT']);
  // Explicit authority marker with no live records never resurrects retained legacy data.
  f.db.raw.prepare('DELETE FROM sync_records WHERE user_id=?').run(f.id);f.seedLegacy(d,99);assert.deepEqual((await f.pull()).data,{});assert.equal((await f.pull()).syncVersion,2);
}
// Deterministic interleavings: every participant pre-reads the same version before the real SQL CAS is executed.
async function race(bootstrap) {
  const f=await fixture();const base=data();if(!bootstrap) assert.equal((await f.push(base)).status,200);
  const revision=bootstrap?0:1;const a=clone(base);a.settings.rest=100;const b=clone(base);b.settings.rest=110;
  let arrived=0;let release;const barrier=new Promise(resolve=>{release=resolve;});f.db.setBeforeBatch(async()=>{if(++arrived===2)release();await barrier;});
  const results=await Promise.all([f.push(a,revision),f.push(b,revision)]);f.db.setBeforeBatch(null);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const winner=results[0].status===200?a:b;assert.deepEqual((await f.pull()).data,winner);assert.equal((await f.pull()).syncVersion,revision+1);assert.equal(f.db.rows('SELECT * FROM sync_account_state').length,1);
  assert.ok(f.db.rows('SELECT DISTINCT modified_revision FROM sync_records').every(row=>row.modified_revision<=revision+1));
}
await race(true);await race(false);
// Rollback and account deletion/blocked race execute in real SQL, without fake CAS shortcuts.
{
  const f=await fixture();const d=data();f.db.setFailOn(/^INSERT INTO sync_records/);const before=f.dump();assert.deepEqual(await code(await f.push(d)),[503,'SYNC_STORAGE_UNAVAILABLE']);assert.equal(f.dump(),before);f.db.setFailOn(null);assert.equal((await f.push(d)).status,200);
  f.db.raw.prepare("UPDATE sync_account_state SET write_status='BLOCKED'").run();await noWrite(f,()=>f.push(d,1),[409,'SYNC_ACCOUNT_BLOCKED']);assert.equal((await (await f.call('capabilities')).json()).writable,false);
}
for (const hard of [false,true]) {
  const f=await fixture({foreignKeys:!hard});f.db.setBeforeBatch(async()=>{if(hard)f.db.raw.prepare('DELETE FROM users WHERE id=?').run(f.id);else f.db.raw.prepare("UPDATE users SET deleted_at='now' WHERE id=?").run(f.id);});
  assert.deepEqual(await code(await f.push(data())),[409,'SYNC_ACCOUNT_BLOCKED']);assert.equal(f.db.rows('SELECT * FROM sync_account_state').length,0);assert.equal(f.db.rows('SELECT * FROM sync_records').length,0);
}
// Cross-account scope comes only from auth; a forged body target never influences SQL ownership.
{
  const f=await fixture();const d=data();d.ownerId='different-user';assert.equal((await f.push(d)).status,200);assert.ok(f.db.rows('SELECT DISTINCT user_id FROM sync_records').every(row=>row.user_id===f.id));assert.equal((await f.call('pull',{},'invalid-token')).status,401);assert.equal((await f.call('capabilities',{},'invalid-token')).status,401);
}
// Missing additive migration is readable legacy-only; writes fail closed and capabilities is actionable.
{
  const f=await fixture({migrationsUpTo:'0007_password_reset_tokens.sql'});const d=data();f.seedLegacy(d,3);f.db.resetMetrics();assert.deepEqual((await f.pull()).data,d);assert.equal(f.db.metrics.writes,0);assert.deepEqual(await code(await f.push(d,3)),[503,'SYNC_STORAGE_MIGRATION_REQUIRED']);assert.equal(f.db.metrics.writes,0);assert.deepEqual(await (await f.call('capabilities')).json(),{storageSchemaVersion:1,writable:false,recordPaging:false,rootDeltaSync:false,personalRestoreProtocol:false,code:'SYNC_STORAGE_MIGRATION_REQUIRED'});
}
{
  const f=await fixture();f.db.raw.exec('DROP TABLE sync_records');f.db.resetMetrics();assert.deepEqual(await code(await f.push(data())),[503,'SYNC_STORAGE_SCHEMA_UNSUPPORTED']);assert.equal(f.db.metrics.writes,0);
}
// Validation boundaries: revisions, malformed links/identities, record/depth/byte guards, streamed body with lying CL.
{
  const f=await fixture();for(const rev of [-1,0.5,'0',null,true,Number.MAX_SAFE_INTEGER])await noWrite(f,()=>f.push(data(),rev),[400,'SYNC_VERSION_INVALID']);
  const duplicate=data();duplicate.programs.push(clone(duplicate.programs[0]));await noWrite(f,()=>f.push(duplicate),[400,'SYNC_RECORD_ID_DUPLICATE']);
  const pwa={schemaVersion:5,sessions:[{id:'s',sets:[{id:'same'},{id:'same'}]}],programs:[]};await noWrite(f,()=>f.push(pwa),[400,'SYNC_RECORD_ID_DUPLICATE']);delete pwa.sessions[0].sets[1].id;await noWrite(f,()=>f.push(pwa),[400,'SYNC_RECORD_ID_INVALID']);
  const invalid=data();invalid.sessions[0].sets={group:[]};await noWrite(f,()=>f.push(invalid),[409,'SYNC_SET_CONTAINER_UNSUPPORTED']);
  const depth={schemaVersion:8};let cursor=depth;for(let i=0;i<66;i++)cursor=cursor.child={};await noWrite(f,()=>f.push(depth),[413,'SYNC_STRUCTURE_LIMIT']);
  const giant={schemaVersion:8,opaque:'x'.repeat(1_800_000)};await noWrite(f,()=>f.push(giant),[413,'SYNC_RECORD_TOO_LARGE']);
  const tooMany={schemaVersion:8,programs:Array.from({length:25_001},(_,i)=>({id:`id${i}`}))};await noWrite(f,()=>f.push(tooMany),[413,'SYNC_RECORD_LIMIT']);
  const nodes={schemaVersion:8,opaque:Array.from({length:200_001},()=>null)};await noWrite(f,()=>f.push(nodes),[413,'SYNC_STRUCTURE_LIMIT']);
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"data":{"x":"'));controller.enqueue(new Uint8Array(LIMITS.envelopeBytes));controller.close();}});
  const before=f.dump();f.db.resetMetrics();const req=new Request(`${ORIGIN}/api/sync/push`,{method:'POST',duplex:'half',body:stream,headers:{'Content-Type':'application/json','Content-Length':'1',Authorization:`Bearer ${f.token}`}});assert.deepEqual(await code(await worker.fetch(req,{DB:f.db})),[413,'SYNC_PAYLOAD_INVALID']);assert.equal(f.dump(),before);assert.equal(f.db.metrics.writes,0);
  assert.throws(()=>recordChunks([{payload:'x'.repeat(1_800_000)}]),/SYNC_RECORD_TOO_LARGE/);
}
// Actual mobile/AI prescription shape has setNumber and prescription values, with no prescribed-set ID.
// Distinct program child kinds can share the same raw ID; only duplicate identity within one kind is invalid.
{
  const f=await fixture();const d={schemaVersion:8,sessions:[],measurements:[],programs:[{schemaVersion:'1.0',id:'program',name:'AI import',days:[{id:'shared',programId:'program',name:'Day',sections:[{id:'shared',workoutDayId:'shared',title:'Strength',items:[{id:'shared',itemType:'exercise',sectionId:'shared',exerciseId:'squat',individualSets:[{setNumber:1,setType:'working',weight:50,reps:5},{setNumber:2,setType:'working',weight:55,reps:5}]}]}]}]}]};
  assert.equal((await f.push(d)).status,200);assert.deepEqual((await f.pull()).data,d);assert.ok(!ownPrescriptionId((await f.pull()).data));
  const duplicate=clone(d);duplicate.programs[0].days.push(clone(duplicate.programs[0].days[0]));await noWrite(f,()=>f.push(duplicate,1),[400,'SYNC_RECORD_ID_DUPLICATE']);
}
function ownPrescriptionId(d) { return d.programs[0].days[0].sections[0].items[0].individualSets.some(set=>Object.hasOwn(set,'id')); }
// Removing a nested future object wholesale cannot bypass preservation; proven program children/gym/history
// deletion remains valid, while extra opaque fields inside a removed element make the plan fail closed.
{
  const f=await fixture();const d=data();d.opaqueArray=[{id:'future',privateFuture:{note:'keep'}}];assert.equal((await f.push(d)).status,200);const loss=clone(d);loss.opaqueArray=[];await noWrite(f,()=>f.push(loss,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
  const future=clone(d);future.programs[0].days=[{id:'day',programId:'program-1',name:'Day',sections:[],privateFuture:{note:'keep'}}];assert.equal((await f.push(future,1)).status,200);const lostDay=clone(future);lostDay.programs[0].days=[];await noWrite(f,()=>f.push(lostDay,2),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
{
  const f=await fixture();const d=data();d.settings.gyms=[{id:'gym',name:'Home',note:null}];d.importHistory=[{importId:'import',finalizedAt:'now',source:{fileName:'own'}}];d.programs[0].days=[{id:'day',programId:'program-1',name:'Day',sections:[]}];assert.equal((await f.push(d)).status,200);d.settings.gyms=[];d.importHistory=[];d.programs[0].days=[];assert.equal((await f.push(d,1)).status,200);assert.deepEqual((await f.pull()).data,d);
}
// Full snapshots do not prove intentional removal of unknown future root/set payloads. Known deletes work.
for(const field of ['programs','sessions','measurements']) {
  const f=await fixture();const d=data();d[field][0].privateFuture={note:'keep'};assert.equal((await f.push(d)).status,200);const loss=clone(d);loss[field]=[];await noWrite(f,()=>f.push(loss,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
{
  const f=await fixture();const d=data();assert.equal((await f.push(d)).status,200);const loss=clone(d);delete loss.sessions[0].sets['a:b'].k2;await noWrite(f,()=>f.push(loss,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
  const p=await fixture();const known={schemaVersion:5,programs:[{id:'p',schemaVersion:'1.0',days:[]}],sessions:[{id:'s',workoutDayId:'d',sets:[{id:'set',sessionId:'s',exerciseId:'e',setNumber:1,weight:'20'}]}]};assert.equal((await p.push(known)).status,200);const removed=clone(known);removed.programs=[];removed.sessions=[];assert.equal((await p.push(removed,1)).status,200);assert.deepEqual((await p.pull()).data,removed);assert.equal(p.db.rows('SELECT COUNT(*) n FROM sync_records WHERE tombstone=1')[0].n,3);await noWrite(p,()=>p.push(known,2),[409,'SYNC_RECORD_DELETED']);
}
// Raw prototype-named address keys are own storage keys; inherited Object fields cannot prove retained sets.
{
  const f=await fixture();const d={schemaVersion:8,programs:[],measurements:[],sessions:[{id:'s',sets:JSON.parse('{"constructor":{"name":"opaque primitive"},"__proto__":{}}')}]};assert.equal((await f.push(d)).status,200);assert.deepEqual((await f.pull()).data,d);const loss=clone(d);loss.sessions[0].sets={};await noWrite(f,()=>f.push(loss,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
// Optional structural links never target another parent's record; exerciseId/setNumber remain opaque payload.
{
  const f=await fixture();const d=data();d.sessions[0].sets['a:b']['k:1'].sessionId='other';await noWrite(f,()=>f.push(d),[400,'SYNC_RECORD_LINK_INVALID']);
  const p=data();p.programs[0].days=[{id:'day',programId:'other',sections:[]}];await noWrite(f,()=>f.push(p),[400,'SYNC_RECORD_LINK_INVALID']);
  const giant={schemaVersion:8,programs:Array.from({length:8},(_,i)=>({id:`p${i}`,notes:'x'.repeat(500_000)}))};await noWrite(f,()=>f.push(giant),[413,'SYNC_PAYLOAD_INVALID']);
  f.db.raw.prepare("INSERT INTO sync_account_state VALUES (?,2,1,'x','ACTIVE','now')").run(f.id);f.db.resetMetrics();assert.deepEqual(await code(await f.push(data(),1)),[503,'SYNC_STORAGE_SCHEMA_UNSUPPORTED']);assert.deepEqual(await code(await f.call('pull')),[503,'SYNC_STORAGE_SCHEMA_UNSUPPORTED']);assert.equal(f.db.metrics.writes,0);assert.equal((await (await f.call('capabilities')).json()).writable,false);
}
// Mobile finish/cancel and PWA program save explicitly clear known operational draft state. Unknown future
// personal fields, including inside sets or a builder's nested exercises, do not gain deletion authority.
{
  const f=await fixture();const d=data();d.draft={id:'draft',programId:null,dayId:null,dayName:'Workout',startedAt:'now',exercises:[],sets:{g:{k:{exerciseId:'e',setNumber:1,completed:true}}},restTimer:{exerciseId:'e',endsAt:'later'}};
  assert.equal((await f.push(d)).status,200);
  const resting=clone(d);resting.draft.restTimer=null;assert.equal((await f.push(resting,1)).status,200);
  const finish=clone(resting);finish.draft=null;finish.sessions.unshift({id:'finished',title:'Workout',startedAt:'now',completedAt:'later',sets:clone(resting.draft.sets)});assert.equal((await f.push(finish,2)).status,200);assert.deepEqual((await f.pull()).data,finish);
  const cancel=clone(finish);cancel.draft={id:'cancel',programId:null,dayId:null,dayName:'Cancel',startedAt:'now',exercises:[],sets:{}};assert.equal((await f.push(cancel,3)).status,200);cancel.draft=null;assert.equal((await f.push(cancel,4)).status,200);assert.deepEqual((await f.pull()).data,cancel);
  const unknown=clone(cancel);unknown.draft={id:'unknown',sets:{},privateFuture:{note:'must retain'}};assert.equal((await f.push(unknown,5)).status,200);const cleared=clone(unknown);cleared.draft=null;await noWrite(f,()=>f.push(cleared,6),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
{
  const f=await fixture();const builder={schemaVersion:'1.0',id:'builder',name:'Unsaved',days:[{id:'day',programId:'builder',name:'Day',sections:[]}]};const d={schemaVersion:5,sessions:[],programs:[],programBuilderDraft:builder,draft:null};assert.equal((await f.push(d)).status,200);const saved=clone(d);saved.programBuilderDraft=null;saved.programs=[builder];assert.equal((await f.push(saved,1)).status,200);assert.deepEqual((await f.pull()).data,saved);
  const unknown=clone(saved);unknown.programBuilderDraft=clone(builder);unknown.programBuilderDraft.days[0].privateFuture={note:'keep'};assert.equal((await f.push(unknown,2)).status,200);const cleared=clone(unknown);cleared.programBuilderDraft=null;await noWrite(f,()=>f.push(cleared,3),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
// Phone withoutCompletion and Watch undoLastSet both remove completedAt only on explicit true→false.
for (const producer of ['phone','watch']) {
  const f=await fixture();const d=data();d.draft={id:'draft',programId:null,dayId:null,dayName:'Workout',startedAt:'now',exercises:[],sets:{g:{k:{exerciseId:'e',setNumber:1,completed:true,completedAt:'2026-10-09T00:00:00Z',note:'retain',privateFuture:{opaque:true}}}},restTimer:{exerciseId:'g',setKey:'k',endsAt:'later',source:'watch'}};assert.equal((await f.push(d)).status,200);
  const undo=clone(d);const {completedAt:_completion,...rest}=undo.draft.sets.g.k;undo.draft.sets.g.k={...rest,completed:false};undo.draft.restTimer=null;assert.equal((await f.push(undo,1)).status,200,producer);assert.deepEqual((await f.pull()).data,undo);assert.equal((await f.pull()).data.sessions.length,d.sessions.length);
  const loss=clone(undo);delete loss.draft.sets.g.k.privateFuture;await noWrite(f,()=>f.push(loss,2),[409,'SYNC_SCHEMA_LOSS_RISK']);
  const invalid=clone(d);invalid.draft.sets.g.k.completed=false;assert.equal((await f.push(invalid,2)).status,200);const notUndo=clone(invalid);delete notUndo.draft.sets.g.k.completedAt;await noWrite(f,()=>f.push(notUndo,3),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
function readyPreview(importId) {
  const ref={page:1,sheet:null,cellRange:null,text:'Squat 3x5'};
  const prescription={sets:3,setsText:null,repsMin:5,repsMax:5,repsText:'5',weight:50,weightUnit:'kg',weightText:null,rir:2,rirText:null,rpe:null,rpeText:null,restSeconds:90,restText:null,tempo:null,tempoText:null,durationSeconds:null,durationText:null,distance:null,distanceUnit:null,distanceText:null,individualSets:[{setNumber:1,setType:'working',reps:5,repsText:'5',weight:50,weightUnit:'kg',weightText:null,rir:2,rirText:null,rpe:null,rpeText:null,restSeconds:90,restText:null,notes:null}]};
  return {schemaVersion:'1.1',importId,importedAt:'2026-10-09T00:00:00Z',source:{fileName:'own.pdf',fileType:'pdf',language:null,documentTitle:null},parserProvider:'openai-background',program:{id:null,name:'Own program',description:null,sourceType:'pdf-import',notes:null,days:[{name:'Day',order:1,notes:null,sourceReference:ref,sections:[{title:'Strength',sectionType:'strength',order:1,notes:null,sourceReference:ref,items:[{itemType:'exercise',order:1,sourceExerciseName:'My squat',normalizedExerciseName:'My squat',exerciseMatch:{status:'probable',exerciseId:'squat',matchedName:'Squat',score:.7,candidates:[{exerciseId:'squat',name:'Squat',score:.7}]},prescription,notes:null,sourceReference:ref,resolutionStatus:'accepted-custom',userEditedExerciseName:'My squat'},{itemType:'instruction',order:2,text:'Own instruction',sourceReference:ref}]}]}]},warnings:[{code:'CHECK',severity:'info',message:'Own warning',dayOrder:1,sectionOrder:1,exerciseOrder:1,sourceReference:ref}],unparsedContent:[{text:'Own note',reason:'unparsed',sourceReference:ref,resolutionStatus:'assigned'}],normalizedDocument:{fileName:'own.pdf',fileType:'pdf',extractedAt:'now',language:null,blocks:[{type:'paragraph',text:'My squat',sourceReference:ref},{type:'table',rows:[['exercise','sets'],['My squat','3']],sourceReference:ref},{type:'sheet',name:'Plan',rows:[['My squat',3]],usedRange:'A1:B1',sourceReference:{page:null,sheet:'Plan',cellRange:'A1:B1',text:'My squat'}}]}};
}
// Actual mobile pending/job replacement and PWA failed/retry/done removal of operational scalar fields.
for (const schemaVersion of [5,8]) {
  const f=await fixture();const pending={importId:'imp',importedAt:'now',parserStatus:'pending',source:{fileName:'own.pdf',fileType:'pdf'},program:{name:'own',days:[]}};const d={schemaVersion,sessions:[],programs:[],importPreviews:{imp:pending}};assert.equal((await f.push(d)).status,200);
  const failed=clone(d);failed.importPreviews.imp={...pending,parserStatus:'failed',errorCode:'OPENAI_REQUEST_FAILED',failedAt:'now'};assert.equal((await f.push(failed,1)).status,200);
  const retry=clone(failed);retry.importPreviews.imp.parserStatus='pending';if(schemaVersion===5)retry.importPreviews.imp.errorCode=null;else delete retry.importPreviews.imp.errorCode;assert.equal((await f.push(retry,2)).status,200);
  const ready=clone(retry);ready.importPreviews.imp=readyPreview('imp');assert.equal((await f.push(ready,3)).status,200);assert.deepEqual((await f.pull()).data,ready);
  const final=clone(ready);delete final.importPreviews.imp;final.programs=[finalizeImport(ready.importPreviews.imp,new Set(),'2026-10-09T00:00:00Z')];final.importHistory=[{importId:'imp',finalProgramId:final.programs[0].id,finalizedAt:'now',source:{fileName:'own.pdf'}}];assert.equal((await f.push(final,4)).status,200);assert.deepEqual((await f.pull()).data,final);
  const discard=await fixture();const source={schemaVersion,sessions:[],programs:[],importPreviews:{imp:readyPreview('imp'),other:readyPreview('other')}};assert.equal((await discard.push(source)).status,200);delete source.importPreviews.imp;assert.equal((await discard.push(source,1)).status,200);assert.deepEqual((await discard.pull()).data,source);
}
// app.js retry writes errorCode:null, then fresh ready drops that field. The exact matching pending→ready
// transition succeeds at revisions 1→2→3 and leaves unrelated account data untouched.
{
  const f=await fixture();const failed=readyPreview('imp');failed.parserStatus='failed';failed.errorCode='OPENAI_REQUEST_FAILED';failed.failedAt='now';const d={schemaVersion:5,sessions:[{id:'s',sets:[{id:'set',sessionId:'s',exerciseId:'e',setNumber:1}]}],programs:[{id:'p',schemaVersion:'1.0',days:[]}],settings:{rest:90},privateAccountField:{nested:'keep'},importPreviews:{imp:failed}};
  const first=await f.push(d);assert.equal(first.status,200);assert.equal((await first.json()).syncVersion,1);const retry=clone(d);retry.importPreviews.imp.parserStatus='pending';retry.importPreviews.imp.errorCode=null;const second=await f.push(retry,1);assert.equal(second.status,200);assert.equal((await second.json()).syncVersion,2);const ready=clone(retry);ready.importPreviews.imp=readyPreview('imp');const third=await f.push(ready,2);assert.equal(third.status,200);assert.equal((await third.json()).syncVersion,3);const pulled=await f.pull();assert.equal(pulled.syncVersion,3);assert.deepEqual(pulled.data,ready);const {importPreviews:_beforePreview,...beforeOther}=d;const {importPreviews:_afterPreview,...afterOther}=pulled.data;assert.deepEqual(afterOther,beforeOther);
}
for(const errorCode of [{privateFuture:'keep'},['keep']]) {
  const f=await fixture();const preview=readyPreview('imp');preview.parserStatus='pending';preview.errorCode=errorCode;const d={schemaVersion:5,sessions:[],programs:[],importPreviews:{imp:preview}};assert.equal((await f.push(d)).status,200);const ready=clone(d);ready.importPreviews.imp=readyPreview('imp');await noWrite(f,()=>f.push(ready,1),[409,'SYNC_SCHEMA_LOSS_RISK']);assert.equal((await f.pull()).syncVersion,1);
}
for(const target of ['preview','document','prescription']) {
  const f=await fixture();const preview=readyPreview('imp');preview.parserStatus='pending';preview.errorCode=null;const branch=target==='preview'?preview:target==='document'?preview.normalizedDocument.blocks[0]:preview.program.days[0].sections[0].items[0].prescription.individualSets[0];branch.privateFuture={note:'keep'};const d={schemaVersion:5,sessions:[],programs:[],importPreviews:{imp:preview}};assert.equal((await f.push(d)).status,200);const ready=clone(d);ready.importPreviews.imp=readyPreview('imp');await noWrite(f,()=>f.push(ready,1),[409,'SYNC_SCHEMA_LOSS_RISK']);assert.equal((await f.pull()).syncVersion,1);
}
for(const state of ['failed','pending-wrong-id']) {
  const f=await fixture();const preview=readyPreview('imp');preview.parserStatus=state==='failed'?'failed':'pending';preview.errorCode=null;const d={schemaVersion:5,sessions:[],programs:[],importPreviews:{imp:preview}};assert.equal((await f.push(d)).status,200);const ready=clone(d);ready.importPreviews.imp=readyPreview(state==='failed'?'imp':'different');await noWrite(f,()=>f.push(ready,1),[409,'SYNC_SCHEMA_LOSS_RISK']);assert.equal((await f.pull()).syncVersion,1);
}
// Null permissions are specific to errorCode; failedAt remains string-only and identity guards still apply.
{
  const f=await fixture();const preview=readyPreview('imp');preview.parserStatus='pending';preview.errorCode=null;preview.failedAt=null;const d={schemaVersion:5,sessions:[],programs:[],importPreviews:{imp:preview}};assert.equal((await f.push(d)).status,200);const ready=clone(d);ready.importPreviews.imp=readyPreview('imp');await noWrite(f,()=>f.push(ready,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
for (const target of ['preview','document','prescription']) {
  const f=await fixture();const d={schemaVersion:8,sessions:[],programs:[],importPreviews:{imp:readyPreview('imp')}};
  const branch=target==='preview'?d.importPreviews.imp:target==='document'?d.importPreviews.imp.normalizedDocument.blocks[0]:d.importPreviews.imp.program.days[0].sections[0].items[0].prescription.individualSets[0];branch.privateFuture={note:'keep'};assert.equal((await f.push(d)).status,200);
  const discard=clone(d);delete discard.importPreviews.imp;await noWrite(f,()=>f.push(discard,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
  const partial=clone(d);const changed=target==='preview'?partial.importPreviews.imp:target==='document'?partial.importPreviews.imp.normalizedDocument.blocks[0]:partial.importPreviews.imp.program.days[0].sections[0].items[0].prescription.individualSets[0];delete changed.privateFuture;await noWrite(f,()=>f.push(partial,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
// Wrong parser transitions and object-valued operational fields do not authorize omission.
{
  const f=await fixture();const preview=readyPreview('imp');preview.parserStatus='failed';preview.errorCode={privateFuture:'keep'};const d={schemaVersion:8,sessions:[],programs:[],importPreviews:{imp:preview}};assert.equal((await f.push(d)).status,200);const loss=clone(d);loss.importPreviews.imp.parserStatus='pending';delete loss.importPreviews.imp.errorCode;await noWrite(f,()=>f.push(loss,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
// PWA deleteSet deletes a known set and then its empty group; toggleActivity removes one scalar map entry.
{
  const f=await fixture();const d={schemaVersion:5,sessions:[],programs:[],draft:{id:'draft',programId:'p',workoutDayId:'d',startedAt:'now',status:'active',completedActivities:{e:'now'},sets:{e:{'1':{exerciseId:'e',setNumber:1,weight:'50',reps:'5',completedAt:'now'}}},timer:null}};assert.equal((await f.push(d)).status,200);const changed=clone(d);delete changed.draft.sets.e['1'];delete changed.draft.sets.e;delete changed.draft.completedActivities.e;assert.equal((await f.push(changed,1)).status,200);assert.deepEqual((await f.pull()).data,changed);
  const unknown=clone(d);unknown.draft.sets.e['1'].privateFuture={note:'keep'};unknown.draft.completedActivities.e={privateFuture:'keep'};assert.equal((await f.push(unknown,2)).status,200);const loss=clone(unknown);delete loss.draft.sets.e;await noWrite(f,()=>f.push(loss,3),[409,'SYNC_SCHEMA_LOSS_RISK']);const activityLoss=clone(unknown);delete activityLoss.draft.completedActivities.e;await noWrite(f,()=>f.push(activityLoss,3),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
// Local-only hero is stripped by withoutHeroPreference; unknown/object variants remain personal data.
for (const hero of ['female','male',{privateFuture:'keep'},'future-choice']) {
  const f=await fixture();const d=data();d.settings.heroPreference=hero;assert.equal((await f.push(d)).status,200);const stripped=clone(d);delete stripped.settings.heroPreference;if(typeof hero==='string'&&['female','male'].includes(hero)){assert.equal((await f.push(stripped,1)).status,200);assert.deepEqual((await f.pull()).data,stripped);}else await noWrite(f,()=>f.push(stripped,1),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
// Real Watch ledger/cursor and scalar closed-workout/Health bookkeeping retention, without permission to clear.
{
  const f=await fixture();const ack=i=>({eventId:`event${i}`,workoutId:'workout',status:'accepted',reason:null,resultingRevision:i,installId:'watch',deviceSequence:i,at:'2026-10-09T00:00:00Z'});const d=data();d.watchSync={cursors:{watch:511},ledger:Array.from({length:512},(_,i)=>ack(i)),closedWorkoutIds:Array.from({length:20},(_,i)=>`w${i}`)};d.settings.health={workoutExportsEnabled:true,exportedSessionIds:Array.from({length:1000},(_,i)=>`s${i}`),requestedAt:null};assert.equal((await f.push(d)).status,200);
  const retention=clone(d);retention.watchSync.ledger=[...retention.watchSync.ledger,ack(512)].slice(-512);retention.watchSync.cursors.watch=512;retention.watchSync.closedWorkoutIds=[...retention.watchSync.closedWorkoutIds,'w20'].slice(-20);retention.settings.health.exportedSessionIds=['s1000',...retention.settings.health.exportedSessionIds].slice(0,1000);assert.equal((await f.push(retention,1)).status,200);assert.deepEqual((await f.pull()).data,retention);
  const clear=clone(retention);clear.watchSync.ledger=[];await noWrite(f,()=>f.push(clear,2),[409,'SYNC_SCHEMA_LOSS_RISK']);
}
// Stale legacy revision changes after pre-read: SQL bootstrap CAS must reject without an authority marker.
{
  const f=await fixture();const d=data();f.seedLegacy(d,3);
  f.db.setBeforeBatch(async()=>f.db.raw.prepare('UPDATE user_data SET sync_version=4 WHERE user_id=?').run(f.id));
  assert.deepEqual(await code(await f.push(d,3)),[409,'SYNC_CONFLICT']);assert.equal(f.db.rows('SELECT * FROM sync_account_state').length,0);assert.equal(f.db.rows('SELECT * FROM sync_records').length,0);
}
// Existing record revision failure also rolls back state and every record, including earlier chunk statements.
{
  const f=await fixture();const d=data();assert.equal((await f.push(d)).status,200);const before=f.dump();f.db.setFailOn(/^INSERT INTO sync_records/);d.settings.rest=100;assert.deepEqual(await code(await f.push(d,1)),[503,'SYNC_STORAGE_UNAVAILABLE']);assert.equal(f.dump(),before);
}
// Idempotent migration, schema constraints, and instrumentation do not depend on a SQL-text mock.
{
  const f=await fixture();f.db.exec(readFileSync(new URL('../migrations/0008_record_sync_storage.sql',import.meta.url),'utf8'));
  assert.throws(()=>f.db.raw.prepare("INSERT INTO sync_account_state VALUES (?,1,-1,'x','ACTIVE','now')").run(f.id));
  assert.throws(()=>splitData({sessions:[{id:'s',sets:{x:null}}]}),/SYNC_SET_CONTAINER_UNSUPPORTED/);
  await assert.rejects(f.db.prepare('SELECT ?').bind('x'.repeat(2_000_001)).first(),/D1_LIMIT_EXCEEDED/);
}
// B personal staging uses the same raw serializer and additive schema gates without changing record authority.
{
  const {storageJSON,personalRestoreSchemaStatus,storageTables}=await import('../worker/record-sync-storage.js');
  const f=await fixture();assert.equal(personalRestoreSchemaStatus(await storageTables(f.db)),'ready');
  assert.equal(storageJSON({b:-0,a:[null,-0]}),'\x7b"b":-0,"a":[null,-0]}');
  f.db.exec('DROP INDEX personal_restore_record_target');
  await assert.rejects(()=>storageTables(f.db),e=>e.code==='SYNC_STORAGE_SCHEMA_UNSUPPORTED');
}
// A legacy schema8 snapshot may not stamp a restored portable-provenance9 account down to8.
{
 const f=await fixture(),d={...data(),schemaVersion:9};f.seedLegacy(d,0);
 await noWrite(f,()=>f.push({...d,schemaVersion:8},0),[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);
}
// Critical semantic mutants execute against the same real SQL adapter. A mutant is killed only when its altered
// behavior violates an observable invariant; a source-string presence check is not the result.
const moduleSource=readFileSync(new URL('../worker/record-sync-storage.js',import.meta.url),'utf8');
async function mutant(from,to) { assert.ok(moduleSource.includes(from));return import(`data:text/javascript;base64,${Buffer.from(moduleSource.replace(from,to).replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,new URL('../worker/record-sync-storage.js',import.meta.url))}'`)).toString('base64')}`); }
const direct=(module,f,d,rev=0)=>module.recordPush(new Request(`${ORIGIN}/api/sync/push`,{method:'POST',body:JSON.stringify({data:d,syncVersion:rev})}),{DB:f.db},f.id);
let killed=0;
{
  const m=await mutant('AND revision = ? AND storage_schema_version', 'AND ? >= 0 AND storage_schema_version');const f=await fixture();const d=data();await f.push(d);f.db.setBeforeBatch(async()=>f.db.raw.prepare("UPDATE sync_account_state SET revision=2,write_token='other' WHERE user_id=?").run(f.id));
  const result=await direct(m,f,d,1);assert.equal(result.status,200,'mutated CAS wrongly succeeds after racing revision advancement');killed++;
}
{
  const m=await mutant('AND s.write_token = ?', 'AND ? IS NOT NULL');const f=await fixture();const a=data();const b=data();a.settings.rest=101;b.settings.rest=202;let count=0;let release;const barrier=new Promise(resolve=>release=resolve);f.db.setBeforeBatch(async()=>{if(++count===2)release();await barrier;});const results=await Promise.all([direct(m,f,a),direct(m,f,b)]);f.db.setBeforeBatch(null);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const winner=results[0].status===200?a:b;assert.notDeepEqual((await f.pull()).data,winner,'mutated ownership guard lets CAS loser overwrite winner');killed++;
}
{
  const m=await mutant('JSON.stringify([id, groupKey, storageKey])','JSON.stringify([id, entries[storageKey]?.exerciseId, entries[storageKey]?.setNumber])');const records=m.splitData({sessions:[{id:'s',sets:{group:{stored:{exerciseId:'payload',setNumber:99}}}}]});assert.notEqual(records.find(r=>r.kind==='set').record_key,JSON.stringify(['s','group','stored']));killed++;
}
{
  const m=await mutant("if (!own(next,key)) { if (allowedOmission(previous,next,key,clearCoverage,context)) continue; fail('SYNC_SCHEMA_LOSS_RISK'); }",'if (!own(next,key)) continue;');const f=await fixture();const d=data();await f.push(d);delete d.sessions[0].sets['a:b'].k2.unknown;assert.equal((await direct(m,f,d,1)).status,200,'mutated field-loss guard accepts opaque deletion');killed++;
}
{
  const m=await mutant('if (before?.tombstone)', 'if (false)');const f=await fixture();const d=data();delete d.sessions[0].sets['a:b'].k2.unknown;await f.push(d);const deleted=clone(d);deleted.sessions=[];await f.push(deleted,1);assert.equal((await direct(m,f,d,2)).status,200,'mutated tombstone guard falsely accepts current-revision resurrection');killed++;
}
assert.equal(killed,5);
console.log('Record sync storage PASS: real SQLite CAS/bootstrap races, rollback, >2MB roundtrip, opaque identity/container/order, tombstones, schema-loss guards, auth/deletion races, additive migration fallback, request/row/depth/node/count/bind budgets; 5 critical semantic mutants killed.');
