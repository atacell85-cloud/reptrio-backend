import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createD1} from './lib/d1-sqlite.mjs';
import worker from '../worker/index.js';
import {cleanupPersonalOperations} from '../worker/personal-restore-api.js';
import {parsePortable,canonicalPortable,portableHash,validatePortableRoot,portableBody,WIRE_RULES} from '../worker/personal-backup-contract.js';
import {storageJSON,splitData,assembleRecordData} from '../worker/record-sync-storage.js';
const fixture=parsePortable(readFileSync(new URL('../tests/fixtures/personal-backup-v1-golden.json',import.meta.url),'utf8'));
let assertions=0;
const test=async(name,fn)=>{if(process.env.B44_TEST_FILTER&&!name.includes(process.env.B44_TEST_FILTER))return;await fn();assertions++;console.log(`PASS ${name}`);};
const error=(fn,code)=>assert.throws(fn,e=>e.code===`RESTORE_${code}`);
const projection=roots=>({dataSchemaVersion:9,sessions:roots.filter(r=>r.kind==='session').map(r=>r.record),programs:roots.filter(r=>r.kind==='program').map(r=>r.record),measurements:roots.filter(r=>r.kind==='measurement').map(r=>r.record),metadata:{settings:roots.find(r=>r.kind==='settings').record,importHistory:roots.filter(r=>r.kind==='importHistory').map(r=>r.record)}});
await test('frozen codec cf6acfa bytes/hash/schema9/order/-0 and raw identities',async()=>{
 assert.equal(await portableHash(WIRE_RULES),'6d655e07cac5be9562464ed3678eae81445cd521d0bc2550480b959c3002ad88','immutable mobile cf6acfa V1 machine block');
 assert.equal(canonicalPortable(projection(fixture.roots)),fixture.canonicalProjected);
 assert.equal(await portableHash(projection(fixture.roots)),fixture.projectedHash);
 for(let i=0;i<fixture.roots.length;i++){const root=validatePortableRoot(structuredClone(fixture.roots[i]));assert.equal(await portableHash(root.kind==='session'?{record:root.record,setOrder:root.setOrder}:root.record),fixture.rootHashes[i]);}
 const roots=fixture.roots.filter(r=>['session','program','measurement'].includes(r.kind));
 const data={sessions:roots.filter(r=>r.kind==='session').map(r=>r.record),programs:roots.filter(r=>r.kind==='program').map(r=>r.record),measurements:roots.filter(r=>r.kind==='measurement').map(r=>r.record)};
 const assembled=assembleRecordData(splitData(data));assert.equal(canonicalPortable(assembled),canonicalPortable(data));
 assert.ok(Object.is(JSON.parse(storageJSON(assembled)).programs[0].days[0].order,-0));
 assert.equal(storageJSON({omit:undefined,a:[undefined,-0],b:0}),'\x7b"a":[null,-0],"b":0}');
 assert.equal(createHash('sha256').update(fixture.canonicalProjected).digest('hex'),fixture.projectedHash);
});
await test('decoded duplicate members, strict UTF8, secrets/unknown/links/setOrder reject',async()=>{
 for(const raw of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"__proto__":{}}','{"a":Infinity}','[1,]','{"a":01}'])assert.throws(()=>parsePortable(raw));
 error(()=>parsePortable('{"a":1,"\\u0061":2}'),'DUPLICATE_JSON_MEMBER');
 await assert.rejects(()=>portableBody(new Request('https://example.test',{method:'POST',body:new Uint8Array([0xff])})),e=>e.code==='RESTORE_UTF8_INVALID');
 const raw=structuredClone(fixture.roots[0]);raw.record.accessToken='PRIVATE_SENTINEL';error(()=>validatePortableRoot(raw),'SECRET_FIELD');delete raw.record.accessToken;raw.record.unknown=1;error(()=>validatePortableRoot(raw),'UNSUPPORTED_PERSONAL_FIELD');delete raw.record.unknown;
 raw.record.sets['a group'].raw.sessionId='wrong';error(()=>validatePortableRoot(raw),'CONTRADICTORY_REFERENCE');delete raw.record.sets['a group'].raw.sessionId;raw.setOrder.groups[0].storage.push('wrong');error(()=>validatePortableRoot(raw),'INVALID_SET_ORDER');
});
let serial=0,mutantAPI=null;
function environment(options={}){const DB=createD1(options),id=`restore-${++serial}`,token=`fixture-token-${serial}`;DB.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at)VALUES(?,?,'h','s','now')").run(id,id+'@example.test');DB.raw.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at)VALUES(?,?,?,'now','2099-01-01')").run(`auth-${id}`,id,createHash('sha256').update(token).digest('base64url'));const env={DB};const call=async(action,p,idOp,purpose='RESTORE',auth=token)=>{DB.resetMetrics();const path=purpose==='RESTORE'?'backup/restore':'sync/records';const request=new Request(`https://example.test/api/${path}/operations${idOp?`/${idOp}/${action}`:''}`,{method:action==='receipt'?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth}`},...(action==='receipt'?{}:{body:storageJSON(p)})});const response=mutantAPI?await mutantAPI(request,env,id,purpose,idOp,action):await worker.fetch(request,env,{waitUntil(){}});const body=await response.json();assert.ok(DB.metrics.queries<=50,`queries ${DB.metrics.queries}`);assert.ok(DB.metrics.maxParams<=100);assert.ok(DB.metrics.maxSqlBytes<=100000);assert.ok(DB.metrics.maxBoundBytes<=1800000);assert.ok(DB.metrics.maxReturnedBytes<=1800000,`projection ${DB.metrics.maxReturnedBytes}`);return {response,body};};return {DB,id,token,env,call};}
const ok=async promise=>{const {response,body}=await promise;assert.equal(response.status,200,storageJSON(body));return body;};
const start=async(f,counts,chunks=1)=>ok(f.call('start',{sourceNamespace:'source',archiveRetryHash:'a'.repeat(64),localBinding:'local-7',dataSchemaVersion:9,expectedChunks:chunks,expectedCounts:counts,baseRevision:0}));
await test('real SQLite staged golden chunk retry/freeze counts and negative-zero payload',async()=>{
 const f=environment(),op=await start(f,fixture.expectedCounts);
 const input={localBinding:'local-7',index:0,roots:fixture.roots};const one=await ok(f.call('chunks',input,op.operationId));const two=await ok(f.call('chunks',input,op.operationId));assert.deepEqual(one,two);
 assert.equal(f.DB.rows('SELECT COUNT(*) AS n FROM personal_restore_identity_journal')[0].n,0);
 assert.ok(f.DB.rows("SELECT payload_json FROM personal_restore_records WHERE kind='program'")[0].payload_json.includes('"order":-0'));
 const result=await ok(f.call('finalize',{localBinding:'local-7'},op.operationId));assert.equal(result.status,'READY');assert.equal(canonicalPortable(result.counts),canonicalPortable(fixture.expectedCounts));
 const changed=structuredClone(input);changed.roots[0].record.title='changed';const rejected=await f.call('chunks',changed,op.operationId);assert.equal(rejected.body.code,'RESTORE_CHUNK_CONFLICT');
 const cancel=await ok(f.call('cancel',{},op.operationId));assert.equal(cancel.status,'CANCELLED');for(const table of ['personal_restore_roots','personal_restore_records','personal_restore_chunks'])assert.equal(f.DB.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);
});
await test('atomic additive golden publication and durable receipt erase stage payload',async()=>{
 const f=environment(),op=await start(f,fixture.expectedCounts);
 await ok(f.call('chunks',{localBinding:'local-7',index:0,roots:fixture.roots},op.operationId));await ok(f.call('finalize',{localBinding:'local-7'},op.operationId));
 let preview;for(let i=0;i<20;i++){preview=await ok(f.call('preview',{localBinding:'local-7',generationId:preview?.generationId},op.operationId));if(preview.status==='READY')break;}assert.equal(preview.status,'READY');
 const input={localBinding:'local-7',confirm:true,previewDigest:preview.previewDigest,semanticDigest:preview.semanticDigest,selectionDigest:preview.selectionDigest,baseRevision:0};
 const outcome=await ok(f.call('commit',input,op.operationId));assert.equal(outcome.status,'COMMITTED');assert.equal(outcome.committedRevision,1);assert.equal(f.DB.metrics.batches,1);
 const retry=await ok(f.call('commit',input,op.operationId));assert.deepEqual(retry,outcome);assert.equal(f.DB.metrics.batches,0);
 const data=assembleRecordData(f.DB.rows('SELECT * FROM sync_records WHERE user_id=?',f.id));assert.equal(data.schemaVersion,9);assert.ok(Object.is(data.settings.rest,-0));assert.ok(Object.is(data.measurements[0].waistCm,-0));assert.equal(data.sessions.length,3);assert.equal(data.settings.heroPreference,undefined);
 for(const table of ['personal_restore_roots','personal_restore_records','personal_restore_chunks'])assert.equal(f.DB.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);
 assert.ok(f.DB.rows('SELECT COUNT(*) AS n FROM personal_restore_identity_journal')[0].n>0);
 let undoPreview;for(let i=0;i<20;i++){undoPreview=await ok(f.call('undo-preview',{localBinding:'local-7',generationId:undoPreview?.generationId},op.operationId));if(undoPreview.status==='READY')break;}assert.equal(undoPreview.status,'READY');
 const undoInput={localBinding:'local-7',confirm:true,undoDigest:undoPreview.undoDigest,baseRevision:undoPreview.baseRevision};const undone=await ok(f.call('undo',undoInput,op.operationId));assert.equal(undone.status,'UNDONE');assert.equal(f.DB.metrics.batches,1);assert.deepEqual(assembleRecordData(f.DB.rows('SELECT * FROM sync_records WHERE user_id=?',f.id)),{});
 assert.deepEqual(await ok(f.call('undo',undoInput,op.operationId)),undone);assert.equal(f.DB.metrics.batches,0);
 assert.equal(f.DB.rows("SELECT COUNT(*) AS n FROM personal_restore_identity_journal WHERE disposition='ADDED' AND state='LIVE'")[0].n,0);

});

const expectedFor=roots=>{const c={sessions:0,sets:0,programs:0,days:0,sections:0,exercises:0,measurements:0,gyms:0,importHistory:0};for(const r of roots){if(r.kind==='session'){c.sessions++;c.sets+=Array.isArray(r.record.sets)?r.record.sets.length:Object.values(r.record.sets).reduce((n,g)=>n+Object.keys(g).length,0);}if(r.kind==='measurement')c.measurements++;if(r.kind==='program'){c.programs++;for(const d of r.record.days||[]){c.days++;for(const s of d.sections||[]){c.sections++;c.exercises+=(s.items||[]).length;}}}if(r.kind==='settings')c.gyms+=(r.record.gyms||[]).length;if(r.kind==='importHistory')c.importHistory++;}return c;};
async function upload(f,roots,purpose='RESTORE',schema=9,baseRevision=0){const chunks=Math.ceil(roots.length/16),operation=await ok(f.call('start',{sourceNamespace:'source',archiveRetryHash:'a'.repeat(64),localBinding:'local-7',dataSchemaVersion:schema,expectedChunks:chunks,expectedCounts:expectedFor(roots),baseRevision},undefined,purpose));for(let i=0;i<chunks;i++)await ok(f.call('chunks',{localBinding:'local-7',index:i,roots:roots.slice(i*16,(i+1)*16)},operation.operationId,purpose));let finalized;for(let i=0;i<1000;i++){finalized=await ok(f.call('finalize',{localBinding:'local-7',generationId:finalized?.generationId},operation.operationId,purpose));if(finalized.status==='READY')break;}assert.equal(finalized.status,'READY');return {operation,finalized};}
async function restore(f,roots,schema=9,baseRevision=0){const uploaded=await upload(f,roots,'RESTORE',schema,baseRevision);let preview;for(let i=0;i<1000;i++){preview=await ok(f.call('preview',{localBinding:'local-7',generationId:preview?.generationId},uploaded.operation.operationId));if(preview.status==='READY')break;}assert.equal(preview.status,'READY');const confirmed={localBinding:'local-7',confirm:true,previewDigest:preview.previewDigest,semanticDigest:preview.semanticDigest,selectionDigest:preview.selectionDigest,baseRevision};const outcome=await ok(f.call('commit',confirmed,uploaded.operation.operationId));return {...uploaded,preview,confirmed,outcome};}
async function prepared(f,roots,baseRevision=0){const uploaded=await upload(f,roots,'RESTORE',9,baseRevision);let preview;for(let i=0;i<100;i++){preview=await ok(f.call('preview',{localBinding:'local-7',generationId:preview?.generationId},uploaded.operation.operationId));if(preview.status==='READY')break;}assert.equal(preview.status,'READY');return {...uploaded,preview,input:{localBinding:'local-7',confirm:true,previewDigest:preview.previewDigest,semanticDigest:preview.semanticDigest,selectionDigest:preview.selectionDigest,baseRevision}};}
const smallRoots=()=>[{kind:'session',record:{id:'imported',programId:'p',title:'imported',startedAt:'2026-10-09T00:00:00Z',completedAt:'2026-10-09T00:01:00Z',weightUnit:'kg',sets:{}},setOrder:{groups:[]}},{kind:'program',record:structuredClone(fixture.roots.find(r=>r.kind==='program').record)}];
const accountDump=f=>storageJSON(['sync_account_state','sync_records','personal_restore_identity_journal'].map(t=>f.DB.rows(`SELECT * FROM ${t} ORDER BY user_id`)));
async function readyUndo(f,id){let result;for(let i=0;i<100;i++){const response=await f.call('undo-preview',{localBinding:'local-7',generationId:result?.generationId},id);if(response.response.status!==200)return response;result=response.body;if(result.status==='READY')return response;}assert.fail('undo continuation did not terminate');}
await test('unchanged opaque legacy baseline and dangling external references survive ALL undo',async()=>{
 const f=environment(),legacy={schemaVersion:8,settings:{opaque:{unknown:['😀',-0,null]},weightUnit:'kg'},sessions:[{id:'old',title:'old',sets:{},programId:'p'}],programs:[],measurements:[],draft:{id:'unrelated',opaque:'unchanged'}};
 f.DB.raw.prepare('INSERT INTO user_data VALUES(?,?,0,?)').run(f.id,storageJSON(legacy),'before');const imported=await restore(f,smallRoots());let undoPreview=await readyUndo(f,imported.operation.operationId);assert.equal(undoPreview.response.status,200,storageJSON(undoPreview.body));
 await ok(f.call('undo',{localBinding:'local-7',confirm:true,undoDigest:undoPreview.body.undoDigest,baseRevision:undoPreview.body.baseRevision},imported.operation.operationId));assert.equal(canonicalPortable(assembleRecordData(f.DB.rows('SELECT * FROM sync_records WHERE user_id=?',f.id))),canonicalPortable(legacy));
});
await test('edited/reordered/new external references/opaque change block ALL undo with zero account effects',async()=>{
 for(const mode of ['edited','reordered','external','opaque','marker']){const f=environment(),imported=await restore(f,smallRoots()),before=f.DB.rows("SELECT * FROM sync_records WHERE kind='session'")[0];
  if(mode==='edited')f.DB.raw.prepare("UPDATE sync_records SET payload_json=?,modified_revision=2 WHERE kind='session'").run(storageJSON({...JSON.parse(before.payload_json),title:'edited'}));
  if(mode==='reordered')f.DB.raw.prepare("UPDATE sync_records SET ordinal=9,modified_revision=2 WHERE kind='session'").run();
  if(mode==='external'||mode==='marker'){const raw={id:'later',title:'later',sets:{},...(mode==='external'?{programId:'p'}:{})};for(const r of splitData({sessions:[raw]}).filter(r=>r.kind!=='metadata'))f.DB.raw.prepare('INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision)VALUES(?,?,?,?,?,?,?,2,2)').run(f.id,r.kind,r.record_key,r.parent_key,20,r.address_json,r.payload_json);}
  if(mode==='opaque')f.DB.raw.prepare("INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision)VALUES(?,'metadata','[\"draft\"]',NULL,20,?,?,2,2)").run(f.id,storageJSON({field:'draft',collection:false}),storageJSON({newOpaque:'changed'}));
  f.DB.raw.prepare("UPDATE sync_account_state SET revision=2,write_token='later'").run();const snapshot=accountDump(f),result=await readyUndo(f,imported.operation.operationId);assert.notEqual(result.response.status,200,mode);assert.ok(['RESTORE_UNDO_CHANGED','RESTORE_UNDO_DEPENDENCY'].includes(result.body.code),storageJSON(result.body));assert.equal(accountDump(f),snapshot);
 }
});
await test('SQL failure at publication/journal/receipt/payload erase rolls back entire commit',async()=>{
 for(const pattern of [/INSERT INTO sync_records/,/INSERT INTO personal_restore_identity_journal/,/SET outcome_json=/,/DELETE FROM personal_restore_records/]){const f=environment(),ready=await prepared(f,smallRoots()),snapshot=accountDump(f);f.DB.setFailOn(pattern);const result=await f.call('commit',ready.input,ready.operation.operationId);assert.equal(result.response.status,503);assert.equal(accountDump(f),snapshot);assert.equal(f.DB.rows('SELECT state,outcome_json FROM personal_restore_operations')[0].state,'READY');f.DB.setFailOn(null);await ok(f.call('commit',ready.input,ready.operation.operationId));}
});
await test('same-operation concurrent confirmation stores one durable outcome; stale local/digest zero effects',async()=>{
 const f=environment(),ready=await prepared(f,smallRoots());let winner;
 f.DB.setBeforeBatch(async()=>{f.DB.setBeforeBatch(null);winner=await ok(f.call('commit',ready.input,ready.operation.operationId));});const loser=await ok(f.call('commit',ready.input,ready.operation.operationId));assert.deepEqual(loser,winner);assert.equal(f.DB.rows('SELECT revision FROM sync_account_state')[0].revision,1);
 const snapshot=accountDump(f);const stale=await f.call('commit',{...ready.input,localBinding:'other'},ready.operation.operationId);assert.equal(stale.body.code,'RESTORE_LOCAL_BINDING_CHANGED');assert.equal(accountDump(f),snapshot);
});

const seedLegacy=(f,data)=>f.DB.raw.prepare('INSERT INTO user_data VALUES(?,?,0,?)').run(f.id,storageJSON(data),'before');
const currentData=f=>assembleRecordData(f.DB.rows('SELECT * FROM sync_records WHERE user_id=?',f.id));
const mutateRow=(f,kind,id,change)=>{const recordKey=storageJSON([id]),row=f.DB.rows('SELECT * FROM sync_records WHERE kind=? AND record_key=?',kind,recordKey)[0];assert.ok(row);f.DB.raw.prepare('UPDATE sync_records SET payload_json=?,modified_revision=2 WHERE user_id=? AND kind=? AND record_key=?').run(storageJSON(change(JSON.parse(row.payload_json))),f.id,kind,recordKey);};
const bump=f=>f.DB.raw.prepare("UPDATE sync_account_state SET revision=2,write_token='later'").run();
async function blockedUndo(f,imported,label){const before=accountDump(f),result=await readyUndo(f,imported.operation.operationId);assert.notEqual(result.response.status,200,label);assert.ok(['RESTORE_UNDO_CHANGED','RESTORE_UNDO_DEPENDENCY'].includes(result.body.code),`${label}: ${storageJSON(result.body)}`);assert.equal(accountDump(f),before,label);}
async function undoAll(f,imported){const result=await readyUndo(f,imported.operation.operationId);assert.equal(result.response.status,200,storageJSON(result.body));return ok(f.call('undo',{localBinding:'local-7',confirm:true,undoDigest:result.body.undoDigest,baseRevision:result.body.baseRevision},imported.operation.operationId));}
const simpleSession=id=>({kind:'session',record:{id,title:id,startedAt:'2026-10-09T00:00:00Z',completedAt:'2026-10-09T00:01:00Z',weightUnit:'kg',sets:{}},setOrder:{groups:[]}});
await test('proof target-qualified same-count target move and owner/path/alias/duplicate/order changes ALL zero',async()=>{
 const p=smallRoots()[1],q=structuredClone(p);q.record.id='q';for(const day of q.record.days){day.programId='q';}
 for(const mode of ['target','owner','path','alias','duplicate','order','child-context','child-missing-context']){
  const f=environment(),legacy={schemaVersion:8,sessions:[{id:'old-a',title:'a',sets:{},programId:'p'},{id:'old-b',title:'b',sets:{},programId:'q'}],programs:[],measurements:[],settings:{weightUnit:'kg'},health:{exportedSessionIds:['import-a','import-b','import-a']}};
  if(mode.startsWith('child'))legacy.draft={programId:'p',dayId:p.record.days[0].id};
  seedLegacy(f,legacy);const imported=await restore(f,[p,q,simpleSession('import-a'),simpleSession('import-b')]);
  if(mode==='target')mutateRow(f,'session','old-a',v=>({...v,programId:'q'}));
  if(mode==='owner'){mutateRow(f,'session','old-a',v=>({...v,programId:'q'}));mutateRow(f,'session','old-b',v=>({...v,programId:'p'}));}
  if(mode==='path')mutateRow(f,'session','old-a',v=>{delete v.programId;v.summary={programId:'p'};return v;});
  if(mode==='alias')mutateRow(f,'metadata','health',v=>({closedWorkoutIds:v.exportedSessionIds}));
  if(mode==='duplicate')mutateRow(f,'metadata','health',v=>({...v,exportedSessionIds:['import-a','import-b']}));
  if(mode==='order')mutateRow(f,'metadata','health',v=>({...v,exportedSessionIds:['import-b','import-a','import-a']}));
  if(mode==='child-context')mutateRow(f,'metadata','draft',v=>({...v,programId:'q'}));
  if(mode==='child-missing-context')mutateRow(f,'metadata','draft',v=>{delete v.programId;return v;});
  bump(f);await blockedUndo(f,imported,mode);
 }
});
await test('proof RAW opaque key/group order malformed known scalar/null and mixed owned metadata siblings',async()=>{
 for(const mode of ['key-order','known-relative-order','malformed-object','malformed-array','malformed-null','group-order','proof-field-collision']){
  const f=environment(),settings={weightUnit:'kg',opaqueA:{one:-0,two:null},opaqueB:['x']},old={id:'old',title:'old',sets:{g:{k:{exerciseId:'x',setNumber:1}},h:{k:{exerciseId:'y',setNumber:2}}}};
  if(mode==='malformed-object')settings.activeProgramId={raw:'legacy'};
  if(mode==='malformed-array')settings.defaultGymId=['legacy'];
  if(mode==='malformed-null')settings.profile=null;
  if(mode==='proof-field-collision'){settings.rawKeyOrder={opaque:'before'};old.storageOrder={opaque:'before'};}
  seedLegacy(f,{schemaVersion:8,settings,sessions:[old],programs:[],measurements:[]});const imported=await restore(f,[simpleSession('import-a')]);
  if(mode==='key-order')mutateRow(f,'metadata','settings',v=>({weightUnit:v.weightUnit,opaqueB:v.opaqueB,opaqueA:v.opaqueA}));
  if(mode==='known-relative-order')mutateRow(f,'metadata','settings',v=>({opaqueA:v.opaqueA,weightUnit:v.weightUnit,opaqueB:v.opaqueB}));
  if(mode==='malformed-object')mutateRow(f,'metadata','settings',v=>({...v,activeProgramId:{raw:'changed'}}));
  if(mode==='malformed-array')mutateRow(f,'metadata','settings',v=>({...v,defaultGymId:['changed']}));
  if(mode==='malformed-null')mutateRow(f,'metadata','settings',v=>({...v,profile:{}}));
  if(mode==='proof-field-collision')mutateRow(f,'metadata','settings',v=>({...v,rawKeyOrder:{opaque:'after'}}));
  if(mode==='group-order'){const row=f.DB.rows("SELECT * FROM sync_records WHERE kind='session' AND record_key='[\"old\"]'")[0],address=JSON.parse(row.address_json);address.groups.reverse();f.DB.raw.prepare('UPDATE sync_records SET address_json=? WHERE kind=? AND record_key=?').run(storageJSON(address),'session',row.record_key);}
  bump(f);await blockedUndo(f,imported,mode);
 }
 const f=environment(),legacy={schemaVersion:8,settings:{opaqueA:{one:-0,two:null},weightUnit:'kg',profile:{displayName:'kept',opaqueProfile:[null,-0]},gyms:[{id:'kept',name:'kept',opaque:null}],opaqueB:[]},programs:[],sessions:[],measurements:[]};seedLegacy(f,legacy);
 const imported=await restore(f,[simpleSession('import-a'),{kind:'settings',record:{weightUnit:'kg',rest:60,profile:{displayName:'kept',avatarDataUrl:'data:image/png;base64,AA=='},gyms:[{id:'added',name:'new'}]}}]);await undoAll(f,imported);assert.equal(storageJSON(currentData(f)),storageJSON(legacy));
});

await test('owned metadata RAW content property/item order proof preserves surviving sibling updates',async()=>{
 for(const mode of ['raw-object-order','gym-order','history-order','owned-key-order','witness-missing']){
  const f=environment(),legacy={schemaVersion:8,settings:{weightUnit:'kg',gyms:[{id:'kept',name:'kept'}]},importHistory:[{importId:'kept',finalizedAt:'2026-10-09T00:00:00Z'}],programs:[],sessions:[],measurements:[]};seedLegacy(f,legacy);
  const imported=await restore(f,[{kind:'settings',record:{weightUnit:'kg',rest:60,gyms:[{id:'added',name:'new'}]}},{kind:'importHistory',record:{importId:'added',finalizedAt:'2026-10-09T00:00:00Z'}}]);
  if(mode==='raw-object-order')mutateRow(f,'metadata','settings',v=>({...v,gyms:v.gyms.map(g=>g.id==='added'?{name:g.name,id:g.id}:g)}));
  if(mode==='gym-order')mutateRow(f,'metadata','settings',v=>({...v,gyms:[...v.gyms].reverse()}));
  if(mode==='history-order')mutateRow(f,'metadata','importHistory',v=>[...v].reverse());
  if(mode==='owned-key-order')mutateRow(f,'metadata','settings',v=>({rest:v.rest,weightUnit:v.weightUnit,gyms:v.gyms}));
  if(mode==='witness-missing')f.DB.raw.prepare("UPDATE personal_restore_identity_journal SET container_json='{}' WHERE kind='metadataPath'").run();
  bump(f);await blockedUndo(f,imported,mode);
 }
 const f=environment();seedLegacy(f,{schemaVersion:8,settings:{weightUnit:'kg',theme:'dark'},programs:[],sessions:[],measurements:[]});const imported=await restore(f,[{kind:'settings',record:{weightUnit:'kg',rest:60}}]);mutateRow(f,'metadata','settings',v=>({...v,theme:'light'}));bump(f);await undoAll(f,imported);assert.deepEqual(currentData(f).settings,{weightUnit:'kg',theme:'light'});
});
await test('proof missing or unknown version fail closed; unchanged nullable summary and opaque remain eligible',async()=>{
 for(const mode of ['missing','unknown']){const f=environment(),imported=await restore(f,[simpleSession('import-a')]),row=f.DB.rows('SELECT outcome_json FROM personal_restore_operations')[0],receipt=JSON.parse(row.outcome_json);if(mode==='missing')delete receipt.undoEvidence;else receipt.undoEvidence.version=123;f.DB.raw.prepare('UPDATE personal_restore_operations SET outcome_json=?').run(storageJSON(receipt));await blockedUndo(f,imported,mode);}
 const f=environment(),legacy={schemaVersion:8,settings:{weightUnit:'kg',profile:null,activeProgramId:{raw:'legacy'},defaultGymId:['legacy']},sessions:[{id:'old',title:'old',summary:null,sets:{}}],programs:[],measurements:[]};seedLegacy(f,legacy);const imported=await restore(f,[simpleSession('import-a')]);await undoAll(f,imported);assert.equal(storageJSON(currentData(f)),storageJSON(legacy));
});
async function selectedPreview(f,uploaded,selection,initial){let preview=initial;for(let i=0;i<100;i++){preview=await ok(f.call('preview',{localBinding:'local-7',selection,generationId:preview?.generationId},uploaded.operation.operationId));if(preview.status==='READY')return preview;}assert.fail('preview did not terminate');}
await test('source dependency closure conflict tombstone child ledger excluded selection and historical missing',async()=>{
 for(const mode of ['program-conflict','child-conflict','tombstone','ledger','unselected','gym-conflict','history-conflict']){
  const f=environment(),roots=smallRoots(),legacy={schemaVersion:8,programs:[],sessions:[],measurements:[],settings:{weightUnit:'kg'}};
  if(mode==='program-conflict'||mode==='child-conflict'){const existing=structuredClone(roots[1].record);if(mode==='program-conflict')existing.name='different';else existing.days[0].name='different child';legacy.programs=[existing];}
  if(mode==='gym-conflict'){legacy.settings.gyms=[{id:'g',name:'old'}];roots[0].record.gymId='g';roots.push({kind:'settings',record:{weightUnit:'kg',gyms:[{id:'g',name:'new'}]}});}
  if(mode==='history-conflict'){legacy.programs=[{...structuredClone(roots[1].record),name:'different'}];roots.push({kind:'importHistory',record:{importId:'history',finalProgramId:'p',finalizedAt:'2026-10-09T00:00:00Z'}});}
  if(mode==='tombstone'||mode==='ledger'){const original=await restore(f,[roots[1]]);await undoAll(f,original);}
  else seedLegacy(f,legacy);
  const revision=mode==='tombstone'||mode==='ledger'?2:0;
  if(mode==='tombstone')f.DB.raw.prepare('DELETE FROM personal_restore_identity_journal').run();
  const uploaded=await upload(f,roots,'RESTORE',9,revision),selection=mode==='unselected'?{mode:'explicit',roots:[{kind:'session',sourceTuple:'["imported"]'}]}:{mode:'all-eligible'},preview=await selectedPreview(f,uploaded,selection);
  const session=f.DB.rows("SELECT selected,classification FROM personal_restore_records WHERE operation_id=? AND kind='session'",uploaded.operation.operationId)[0];assert.equal(session.selected,0,mode);assert.equal(session.classification,'DEPENDENCY',mode);
  if(mode==='history-conflict')assert.equal(f.DB.rows("SELECT selected FROM personal_restore_records WHERE operation_id=? AND record_key='[\"importHistory\"]'",uploaded.operation.operationId)[0].selected,0);
  const snapshot=accountDump(f),result=await f.call('commit',{localBinding:'local-7',confirm:true,previewDigest:preview.previewDigest,semanticDigest:preview.semanticDigest,selectionDigest:preview.selectionDigest,baseRevision:revision},uploaded.operation.operationId);if(result.response.status!==200){assert.equal(result.body.code,'RESTORE_EMPTY_SELECTION');assert.equal(accountDump(f),snapshot);assert.equal(f.DB.metrics.writes,0);}assert.ok(!currentData(f).sessions?.some(v=>v.id==='imported'),mode);
 }
 const f=environment(),root=simpleSession('historic');root.record.programId='never-supplied';const imported=await restore(f,[root]);assert.equal(currentData(f).sessions[0].programId,'never-supplied');assert.equal(imported.preview.warnings.historicalReferences,1);assert.equal(imported.outcome.warnings.historicalReferences,1);await undoAll(f,imported);
});
await test('auth ACTIVE bootstrap byte-first stage TTL receipt cleanup and partial schema gates',async()=>{
 const f=environment();const noAuth=await f.call('start',{},undefined,'RESTORE','invalid');assert.equal(noAuth.response.status,401);assert.equal(f.DB.metrics.payloadRows,0);assert.equal(f.DB.metrics.writes,0);
 const op=await start(f,expectedFor([simpleSession('a')]));const other=environment();const foreign=await other.call('receipt',{},op.operationId);assert.equal(foreign.response.status,404);
 await ok(f.call('chunks',{localBinding:'local-7',index:0,roots:[simpleSession('a')]},op.operationId));f.DB.raw.prepare("UPDATE personal_restore_operations SET expires_at='2000-01-01'").run();const expired=await f.call('finalize',{localBinding:'local-7'},op.operationId);assert.equal(expired.body.code,'RESTORE_EXPIRED');await cleanupPersonalOperations(f.env);assert.equal(f.DB.rows('SELECT COUNT(*) AS n FROM personal_restore_records')[0].n,0);
 for(const mode of ['blocked','deleted','partial','legacy-oversized']){const g=environment();if(mode==='partial')g.DB.exec('DROP INDEX personal_restore_record_target');if(mode==='blocked')g.DB.raw.prepare("INSERT INTO sync_account_state VALUES(?,1,0,'blocked','BLOCKED','now')").run(g.id);if(mode==='deleted')g.DB.raw.prepare("UPDATE users SET deleted_at='now'").run();if(mode==='legacy-oversized')seedLegacy(g,{opaque:'\\'.repeat(900000)});
  if(mode==='legacy-oversized'){const uploaded=await upload(g,[simpleSession('a')]);const result=await g.call('preview',{localBinding:'local-7'},uploaded.operation.operationId);assert.equal(result.body.code,'RESTORE_LEGACY_UNSUPPORTED');assert.equal(g.DB.metrics.payloadRows,0);assert.equal(g.DB.trace.filter(t=>t.sql.includes("CASE WHEN length(CAST(json_object('data_json'")).at(-1).returnedBytes,20);}
  else{const result=await g.call('start',{sourceNamespace:'source',archiveRetryHash:'a'.repeat(64),localBinding:'local-7',dataSchemaVersion:9,expectedChunks:1,expectedCounts:expectedFor([simpleSession('a')]),baseRevision:0});assert.notEqual(result.response.status,200);assert.equal(g.DB.metrics.writes,0);assert.equal(g.DB.metrics.payloadRows,0);}
 }
});
await test('continuation selection revision generation drift invalidates old confirmation; undo SQL rollback',async()=>{
 const f=environment(),uploaded=await upload(f,smallRoots());const first=await ok(f.call('preview',{localBinding:'local-7'},uploaded.operation.operationId));assert.equal(first.status,'PENDING');const before=accountDump(f);const wrong=await f.call('preview',{localBinding:'local-7',generationId:'wrong'},uploaded.operation.operationId);assert.equal(wrong.body.code,'RESTORE_GENERATION_CHANGED');assert.equal(accountDump(f),before);
 const all=await selectedPreview(f,uploaded,{mode:'all-eligible'},first),changed=await selectedPreview(f,uploaded,{mode:'explicit',roots:[{kind:'program',sourceTuple:'["p"]'}]});assert.notEqual(all.previewDigest,changed.previewDigest);const stale=await f.call('commit',{localBinding:'local-7',confirm:true,previewDigest:all.previewDigest,semanticDigest:all.semanticDigest,selectionDigest:all.selectionDigest,baseRevision:0},uploaded.operation.operationId);assert.equal(stale.body.code,'RESTORE_CONFIRMATION_INVALID');assert.equal(accountDump(f),before);
 const ready=await selectedPreview(f,uploaded,{mode:'all-eligible'});f.DB.raw.prepare('UPDATE user_data SET sync_version=1').run();f.DB.raw.prepare('INSERT OR IGNORE INTO user_data VALUES(?,?,1,?)').run(f.id,'{}','later');const drift=await f.call('commit',{localBinding:'local-7',confirm:true,previewDigest:ready.previewDigest,semanticDigest:ready.semanticDigest,selectionDigest:ready.selectionDigest,baseRevision:0},uploaded.operation.operationId);assert.equal(drift.body.code,'RESTORE_CONFIRMATION_INVALID');
 for(const pattern of [/UPDATE sync_records AS r SET tombstone/,/UPDATE personal_restore_identity_journal SET state='UNDONE'/,/SET outcome_json=/,/DELETE FROM personal_restore_records/]){const g=environment(),imported=await restore(g,smallRoots()),preview=await readyUndo(g,imported.operation.operationId),snapshot=accountDump(g);g.DB.setFailOn(pattern);const result=await g.call('undo',{localBinding:'local-7',confirm:true,undoDigest:preview.body.undoDigest,baseRevision:preview.body.baseRevision},imported.operation.operationId);assert.equal(result.response.status,503);assert.equal(accountDump(g),snapshot);g.DB.setFailOn(null);await undoAll(g,imported);}
});


await test('one-batch restore CAS writer BLOCKED deletion races and durable replay identity never resurrect',async()=>{
 for(const mode of ['writer','blocked','deleted']){
  const f=environment(),initial=await restore(f,[simpleSession('original')]),ready=await prepared(f,[simpleSession('later')],1);let raced;
  f.DB.setBeforeBatch(()=>{f.DB.setBeforeBatch(null);if(mode==='writer')f.DB.raw.prepare("UPDATE sync_account_state SET revision=2,write_token='race'").run();if(mode==='blocked')f.DB.raw.prepare("UPDATE sync_account_state SET write_status='BLOCKED'").run();if(mode==='deleted')f.DB.raw.prepare("UPDATE users SET deleted_at='now'").run();raced=accountDump(f);});
  const result=await f.call('commit',ready.input,ready.operation.operationId);assert.notEqual(result.response.status,200,mode);assert.equal(accountDump(f),raced,mode);assert.ok(!currentData(f).sessions.some(v=>v.id==='later'));assert.equal(f.DB.rows('SELECT state FROM personal_restore_operations WHERE operation_id=?',ready.operation.operationId)[0].state,'READY');assert.equal(initial.outcome.status,'COMMITTED');
 }
 const f=environment(),first=await restore(f,[simpleSession('original')]),duplicate=await restore(f,[simpleSession('original')],9,1);assert.equal(currentData(f).sessions.length,1);assert.ok(duplicate.outcome.counts.every(c=>c.classification==='SAME'));await undoAll(f,duplicate);assert.equal(currentData(f).sessions.length,1);await undoAll(f,first);assert.equal((currentData(f).sessions||[]).length,0);
 const replay=await prepared(f,[simpleSession('original')],4);assert.equal(f.DB.rows("SELECT classification FROM personal_restore_records WHERE operation_id=? AND kind='session'",replay.operation.operationId)[0].classification,'LEDGER');const beforeReplay=accountDump(f),rejected=await f.call('commit',replay.input,replay.operation.operationId);assert.equal(rejected.body.code,'RESTORE_EMPTY_SELECTION');assert.equal(accountDump(f),beforeReplay);assert.equal(f.DB.metrics.writes,0);assert.equal((currentData(f).sessions||[]).length,0);
 const revoked=environment(),op=await start(revoked,expectedFor([simpleSession('a')]));revoked.DB.raw.prepare('DELETE FROM auth_sessions').run();const response=await revoked.call('chunks',{localBinding:'local-7',index:0,roots:[simpleSession('a')]},op.operationId);assert.equal(response.response.status,401);assert.equal(revoked.DB.metrics.writes,0);
});

await test('restored schema9 exact RAW staged SYNC roundtrip preserves source provenance without rewrite',async()=>{
 const f=environment();await restore(f,fixture.roots);const raw=currentData(f);assert.equal(raw.schemaVersion,9);
 const roots=[];for(const [field,value]of Object.entries(raw)){const kind={sessions:'session',programs:'program',measurements:'measurement'}[field];if(kind){for(const record of value)roots.push({kind,record});if(!value.length)roots.push({kind:'metadata',field,record:[]});}else roots.push({kind:'metadata',field,record:value});}
 const uploaded=await upload(f,roots,'SYNC',raw.schemaVersion,1);const outcome=await ok(f.call('commit',{localBinding:'local-7',confirm:true,confirmationDigest:uploaded.finalized.confirmationDigest,semanticDigest:uploaded.finalized.semanticDigest,baseRevision:1},uploaded.operation.operationId,'SYNC'));assert.equal(outcome.status,'COMMITTED');assert.equal(storageJSON(currentData(f)),storageJSON(raw));
});

const rawRoots=data=>Object.entries(data).flatMap(([field,value])=>{const kind={sessions:'session',programs:'program',measurements:'measurement'}[field];return kind?value.length?value.map(record=>({kind,record})):[{kind:'metadata',field,record:[]}]:[{kind:'metadata',field,record:value}];});
async function publishRaw(f,data,schema,revision){const uploaded=await upload(f,rawRoots(data),'SYNC',schema,revision),input={localBinding:'local-7',confirm:true,confirmationDigest:uploaded.finalized.confirmationDigest,semanticDigest:uploaded.finalized.semanticDigest,baseRevision:revision},outcome=await ok(f.call('commit',input,uploaded.operation.operationId,'SYNC'));assert.deepEqual(await ok(f.call('commit',input,uploaded.operation.operationId,'SYNC')),outcome);assert.equal(f.DB.metrics.batches,0);return {uploaded,outcome};}
await test('staged RAW9 opaque null absent -0 order preservation strict loss and unsupported schema zero publication',async()=>{
 const f=environment();await restore(f,fixture.roots);const raw=currentData(f);raw.opaque={z:null,a:-0,list:['a','b']};raw.settings.opaque={z:-0,a:null};raw.sessions[0].rawExtension={second:[null,-0],first:'😀'};delete raw.sessions[0].updatedAt;
 // Removing known updatedAt is intentionally a loss-risk, even though optional portable fields may be absent.
 const bad=await upload(f,rawRoots(raw),'SYNC',9,1).catch(e=>e);assert.ok(bad instanceof Error);assert.equal(f.DB.rows('SELECT revision FROM sync_account_state')[0].revision,1);
 raw.sessions[0].updatedAt=fixture.roots[0].record.updatedAt;delete raw.sessions[1].gymId;await publishRaw(f,raw,9,1);assert.equal(storageJSON(currentData(f)),storageJSON(raw));
 const current=currentData(f);current.opaque.list=[];const before=accountDump(f);await assert.rejects(()=>upload(f,rawRoots(current),'SYNC',9,2),/SYNC_SCHEMA_LOSS_RISK/);assert.equal(accountDump(f),before);
 for(const declared of [0,6,10,5,8]){const g=environment();await restore(g,fixture.roots);const snapshot=accountDump(g),result=await g.call('start',{sourceNamespace:'source',archiveRetryHash:'a'.repeat(64),localBinding:'local-7',dataSchemaVersion:declared,expectedChunks:1,expectedCounts:expectedFor([simpleSession('new')]),baseRevision:1},undefined,'SYNC');assert.notEqual(result.response.status,200);assert.equal(accountDump(g),snapshot);assert.equal(g.DB.metrics.writes,0);}
 const mismatch=environment(),op=await ok(mismatch.call('start',{sourceNamespace:'source',archiveRetryHash:'a'.repeat(64),localBinding:'local-7',dataSchemaVersion:9,expectedChunks:1,expectedCounts:expectedFor([simpleSession('a')]),baseRevision:0},undefined,'SYNC'));await ok(mismatch.call('chunks',{localBinding:'local-7',index:0,roots:[simpleSession('a')].map(({kind,record})=>({kind,record})).concat({kind:'metadata',field:'schemaVersion',record:8})},op.operationId,'SYNC'));let result;for(let i=0;i<20;i++){result=await mismatch.call('finalize',{localBinding:'local-7',generationId:result?.body.generationId},op.operationId,'SYNC');if(result.response.status!==200||result.body.status==='READY')break;}assert.equal(result.body.code,'RESTORE_SYNC_SCHEMA_INVALID');assert.equal(mismatch.DB.rows('SELECT COUNT(*)AS n FROM sync_account_state')[0].n,0);
 const tomb=environment();const raw9={schemaVersion:9,sessions:[simpleSession('a').record],programs:[],measurements:[],settings:{weightUnit:'kg'}};await publishRaw(tomb,raw9,9,0);await publishRaw(tomb,{...raw9,sessions:[]},9,1);const snapshot=accountDump(tomb);await assert.rejects(()=>upload(tomb,rawRoots(raw9),'SYNC',9,2));assert.equal(accountDump(tomb),snapshot);
 for(const schema of [5,8]){const g=environment(),rawData={schemaVersion:schema,sessions:schema===5?[{id:'a',title:'a',sets:[]}]:[simpleSession('a').record],programs:[],measurements:[],settings:{weightUnit:'kg',opaque:{keep:-0}}};await publishRaw(g,rawData,schema,0);const changed=structuredClone(rawData);changed.settings.rest=30;await publishRaw(g,changed,schema,1);assert.equal(currentData(g).settings.rest,30);delete changed.settings.opaque;const snapshot=accountDump(g);await assert.rejects(()=>upload(g,rawRoots(changed),'SYNC',schema,2),/SYNC_SCHEMA_LOSS_RISK/);assert.equal(accountDump(g),snapshot);}
});
await test('legacy push and A delta5/8 cannot downgrade restored provenance9 or borrow operational privileges',async()=>{
 for(const client of [5,8]){const f=environment();await restore(f,fixture.roots);const snapshot=accountDump(f),raw=currentData(f);raw.schemaVersion=client;f.DB.resetMetrics();const response=await worker.fetch(new Request('https://example.test/api/sync/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${f.token}`},body:storageJSON({data:raw,syncVersion:1})}),f.env,{waitUntil(){}});assert.equal((await response.json()).code,'SYNC_CLIENT_UPGRADE_REQUIRED');assert.equal(accountDump(f),snapshot);assert.equal(f.DB.metrics.writes,0);
  f.DB.resetMetrics();const delta=await worker.fetch(new Request('https://example.test/api/sync/records/mutations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${f.token}`},body:storageJSON({mutationId:'downgrade',baseRevision:1,clientSchemaVersion:client,upserts:{sessions:[{...currentData(f).sessions[1],title:'edit'}]}})}),f.env,{waitUntil(){}});assert.equal((await delta.json()).code,'SYNC_CLIENT_UPGRADE_REQUIRED');assert.equal(accountDump(f),snapshot);assert.equal(f.DB.metrics.writes,0);assert.equal(f.DB.rows('SELECT COUNT(*)AS n FROM sync_mutation_receipts')[0].n,0);
 }
 const f=environment(),raw={schemaVersion:9,sessions:[],programs:[],measurements:[],settings:{weightUnit:'kg',health:{exportedSessionIds:['a']}},draft:{id:'draft',sets:{g:{k:{completed:true,completedAt:'before'}}}}};await publishRaw(f,raw,9,0);const clear=structuredClone(raw);clear.draft=null;const snapshot=accountDump(f);await assert.rejects(()=>upload(f,rawRoots(clear),'SYNC',9,1),/SYNC_SCHEMA_LOSS_RISK/);assert.equal(accountDump(f),snapshot);
});

await test('every unitless session requires captured compatible context including empty/explicit-set shapes; no empty selection publication',async()=>{
 const stamp='2026-10-09T00:00:00Z';
 for(const context of ['missing','incompatible','valid','new','excluded','conflicted'])for(const shape of ['empty','explicit-set','unitless-set','own-unit']){
  const f=environment(),legacy={schemaVersion:8,settings:{weightUnit:'kg'},programs:[],sessions:[],measurements:[]};if(['incompatible','valid','conflicted'].includes(context)){legacy.settings.legacyWeightUnit=context==='incompatible'?'kg':'lb';legacy.settings.legacyWeightUnitCapturedAt=context==='conflicted'?'2026-10-08T00:00:00Z':stamp;}seedLegacy(f,legacy);
  const root=simpleSession(`unit-${context}-${shape}`);if(shape!=='own-unit')delete root.record.weightUnit;if(shape==='explicit-set'||shape==='unitless-set'){root.record.sets={g:{k:{exerciseId:'x',setNumber:1,...(shape==='explicit-set'?{weightUnit:'lb'}:{})}}};root.setOrder={groups:[{key:'g',storage:['k']}]};}
  const roots=[root];if(context!=='missing')roots.push({kind:'settings',record:{weightUnit:'kg',legacyWeightUnit:'lb',legacyWeightUnitCapturedAt:stamp}});
  const uploaded=await upload(f,roots),selection=context==='excluded'?{mode:'explicit',roots:[{kind:'session',sourceTuple:storageJSON([root.record.id])}]}:{mode:'all-eligible'},preview=await selectedPreview(f,uploaded,selection),allowed=shape==='own-unit'||['valid','new'].includes(context),session=f.DB.rows("SELECT selected,classification FROM personal_restore_records WHERE operation_id=? AND kind='session'",uploaded.operation.operationId)[0];assert.equal(Boolean(session.selected),allowed,`${context}/${shape}`);
  const snapshot=accountDump(f),input={localBinding:'local-7',confirm:true,previewDigest:preview.previewDigest,semanticDigest:preview.semanticDigest,selectionDigest:preview.selectionDigest,baseRevision:0},result=await f.call('commit',input,uploaded.operation.operationId);
  if(allowed){assert.equal(result.response.status,200,storageJSON(result.body));assert.equal(storageJSON(currentData(f).sessions[0]),storageJSON(root.record));await undoAll(f,{...uploaded,outcome:result.body});assert.equal(storageJSON(currentData(f)),storageJSON(legacy));}
  else{if(result.response.status!==200){assert.equal(result.response.status,409);assert.equal(result.body.code,'RESTORE_EMPTY_SELECTION');assert.equal(accountDump(f),snapshot);assert.equal(f.DB.metrics.writes,0);assert.equal(f.DB.rows('SELECT state,outcome_json FROM personal_restore_operations WHERE operation_id=?',uploaded.operation.operationId)[0].state,'READY');}assert.ok(!currentData(f).sessions?.length);assert.equal(f.DB.rows("SELECT COUNT(*)AS n FROM personal_restore_identity_journal WHERE operation_id=? AND kind IN('session','set')",uploaded.operation.operationId)[0].n,0);}
 }
 for(const shape of ['empty-array','absent-sets','null-unit']){const f=environment(),root=simpleSession('invalid');if(shape==='empty-array')root.record.sets=[];if(shape==='absent-sets')delete root.record.sets;if(shape==='null-unit')root.record.weightUnit=null;const op=await start(f,expectedFor([simpleSession('invalid')])),snapshot=accountDump(f),result=await f.call('chunks',{localBinding:'local-7',index:0,roots:[root]},op.operationId);assert.equal(result.response.status,400);assert.equal(accountDump(f),snapshot);assert.equal(f.DB.metrics.writes,0);assert.equal(f.DB.rows('SELECT COUNT(*)AS n FROM personal_restore_records')[0].n,0);}
});
await test('critical proof mutants expose target qualifier RAW order malformed scalar and child coverage defects',async()=>{
 const source=readFileSync(new URL('../worker/personal-restore-api.js',import.meta.url),'utf8');
 const mutants=[
  ['target',"await portableHash(ref)","await portableHash({ownerKind:ref.ownerKind,ownerKey:ref.ownerKey,path:ref.path})"],
  ['raw',"byteHash(new TextEncoder().encode(storageJSON(value)))","portableHash(value)"],
  ['malformed',"{out[field]={malformed:v};continue;}","{continue;}"],
  ['coverage',"if(childContexts.length)opaque.referenceCoverage=childContexts;","if(false)opaque.referenceCoverage=childContexts;"]
 ];let killed=0;
 for(const [mode,from,to]of mutants){assert.ok(source.includes(from),mode);const changed=source.replace(from,to).replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,new URL('../worker/personal-restore-api.js',import.meta.url))}'`);const module=await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);mutantAPI=module.personalRestoreRequest;
  try{
   const f=environment(),p=smallRoots()[1],q=structuredClone(p);q.record.id='q';for(const day of q.record.days)day.programId='q';const legacy={schemaVersion:8,settings:{weightUnit:'kg'},sessions:[{id:'old',title:'old',sets:{},programId:mode==='coverage'?'wrong':'p',...(mode==='coverage'?{dayId:'before'}:{})}],programs:[],measurements:[]};
   if(mode==='raw'){legacy.settings.opaqueA={a:1,b:-0};legacy.settings.opaqueB=null;}
   if(mode==='malformed')legacy.settings.activeProgramId={raw:'before'};
   seedLegacy(f,legacy);const imported=await restore(f,[p,q]);
   if(mode==='target')mutateRow(f,'session','old',v=>({...v,programId:'q'}));
   if(mode==='raw')mutateRow(f,'metadata','settings',v=>({...v,opaqueA:{b:-0,a:1}}));
   if(mode==='malformed')mutateRow(f,'metadata','settings',v=>({...v,activeProgramId:{raw:'after'}}));
   if(mode==='coverage')mutateRow(f,'session','old',v=>({...v,dayId:p.record.days[0].id}));
   bump(f);const result=await readyUndo(f,imported.operation.operationId);assert.equal(result.response.status,200,`${mode} mutant should reveal unsafe acceptance: ${storageJSON(result.body)}`);assert.equal(result.body.status,'READY');killed++;
  }finally{mutantAPI=null;}
 }
 assert.equal(killed,4);console.log('PERSONAL_RESTORE_PROOF_MUTANTS_KILLED',killed);
});

await test('unit-context and empty-selection semantic guard mutants reveal unsafe authorization',async()=>{
 const source=readFileSync(new URL('../worker/personal-restore-api.js',import.meta.url),'utf8');let killed=0;
 const mutants=[['unit',"AND json_extract(r.payload_json,'$.weightUnit')IS NULL AND NOT EXISTS", "AND json_extract(r.payload_json,'$.weightUnit')IS NULL AND EXISTS(SELECT 1 FROM personal_restore_records child WHERE child.user_id=r.user_id AND child.operation_id=r.operation_id AND child.root_id=r.root_id AND child.kind='set' AND json_extract(child.payload_json,'$.weightUnit')IS NULL) AND NOT EXISTS"],['empty',"if(!counts.length)fail('EMPTY_SELECTION',409);","if(false)fail('EMPTY_SELECTION',409);"]];
 for(const [mode,from,to]of mutants){assert.ok(source.includes(from));const changed=source.replace(from,to).replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,new URL('../worker/personal-restore-api.js',import.meta.url))}'`),module=await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);mutantAPI=module.personalRestoreRequest;
  try{const f=environment(),root=simpleSession('unverified');delete root.record.weightUnit;const ready=await prepared(f,[root]);const result=await ok(f.call('commit',ready.input,ready.operation.operationId));assert.equal(result.status,'COMMITTED');assert.equal(f.DB.rows('SELECT revision FROM sync_account_state')[0].revision,1);if(mode==='unit')assert.equal(currentData(f).sessions[0].weightUnit,undefined);else assert.equal(result.counts.length,0);killed++;}finally{mutantAPI=null;}
 }
 assert.equal(killed,2);console.log('PERSONAL_RESTORE_UNIT_EMPTY_MUTANTS_KILLED',killed);
});
const scaleSize=Number(process.env.B44_SCALE_SIZE||5101);
assert.ok(Number.isSafeInteger(scaleSize)&&scaleSize>0);
await test(`${scaleSize} sessions / ${scaleSize*13} sets staged normal initial publisher ONE batch and bounded later edit`,async()=>{
 const size=Number(process.env.B44_SCALE_SIZE||5101),f=environment(),roots=Array.from({length:size},(_,i)=>({kind:'session',record:{id:`large-${i}`,title:'Unicode İ 😀',weightUnit:'kg',sets:{g:Object.fromEntries(Array.from({length:13},(_,k)=>[`storage-${k}`,{id:'same-optional-id',exerciseId:'raw/x',setNumber:k,weight:'80',reps:'8'}]))}}}));roots.push({kind:'metadata',field:'schemaVersion',record:8});
 const {operation,finalized}=await upload(f,roots,'SYNC',8),input={localBinding:'local-7',confirm:true,confirmationDigest:finalized.confirmationDigest,semanticDigest:finalized.semanticDigest,baseRevision:0};const began=performance.now();const outcome=await ok(f.call('commit',input,operation.operationId,'SYNC'));console.log('LARGE_SYNC_PUBLICATION_MS',Math.round(performance.now()-began));assert.ok(performance.now()-began<30000);assert.equal(outcome.status,'COMMITTED');assert.equal(f.DB.metrics.batches,1);assert.equal(f.DB.rows("SELECT COUNT(*)AS n FROM sync_records WHERE kind='session' AND tombstone=0")[0].n,size);assert.equal(f.DB.rows("SELECT COUNT(*)AS n FROM sync_records WHERE kind='set' AND tombstone=0")[0].n,size*13);
 assert.deepEqual(await ok(f.call('commit',input,operation.operationId,'SYNC')),outcome);assert.equal(f.DB.metrics.batches,0);
 const {recordMutation}=await import('../worker/record-sync-transport.js');f.DB.resetMetrics();const response=await recordMutation(new Request('https://example.test',{method:'POST',body:storageJSON({mutationId:'edit-large',baseRevision:1,clientSchemaVersion:8,upserts:{sessions:[{...roots[Math.floor(size/2)].record,title:'edited'}]}})}),f.env,f.id);assert.equal(response.status,200,await response.text());assert.ok(f.DB.metrics.queries<=30);assert.ok(f.DB.metrics.payloadRows<30);
});
await test(`${scaleSize} sessions / ${scaleSize*13} sets RESTORE publication and complete bounded ALL undo`,async()=>{
 const size=Number(process.env.B44_SCALE_SIZE||5101),f=environment(),roots=Array.from({length:size},(_,i)=>{const sets={g:Object.fromEntries(Array.from({length:13},(_,k)=>[`storage-${k}`,{exerciseId:'raw/x',setNumber:k,weight:'80',reps:'8'}]))};return {kind:'session',record:{id:`restore-large-${i}`,title:'Unicode İ 😀',startedAt:'2026-10-09T00:00:00Z',completedAt:'2026-10-09T00:01:00Z',weightUnit:'kg',sets},setOrder:{groups:[{key:'g',storage:Object.keys(sets.g)}]}};});
 const ready=await prepared(f,roots),began=performance.now(),outcome=await ok(f.call('commit',ready.input,ready.operation.operationId));console.log('LARGE_RESTORE_PUBLICATION_MS',Math.round(performance.now()-began));assert.ok(performance.now()-began<30000);assert.equal(outcome.status,'COMMITTED');assert.equal(f.DB.metrics.batches,1);assert.equal(f.DB.rows("SELECT COUNT(*)AS n FROM sync_records WHERE kind='set' AND tombstone=0")[0].n,size*13);
 const undoPreview=await readyUndo(f,ready.operation.operationId);assert.equal(undoPreview.response.status,200,storageJSON(undoPreview.body));assert.equal(undoPreview.body.status,'READY');
 const undoBegan=performance.now();const undone=await ok(f.call('undo',{localBinding:'local-7',confirm:true,undoDigest:undoPreview.body.undoDigest,baseRevision:undoPreview.body.baseRevision},ready.operation.operationId));console.log('LARGE_UNDO_PUBLICATION_MS',Math.round(performance.now()-undoBegan));assert.ok(performance.now()-undoBegan<30000);assert.equal(undone.status,'UNDONE');assert.equal(f.DB.metrics.batches,1);assert.deepEqual(assembleRecordData(f.DB.rows('SELECT * FROM sync_records WHERE user_id=?',f.id)),{});
 assert.ok(Buffer.byteLength(f.DB.rows('SELECT outcome_json FROM personal_restore_operations')[0].outcome_json)<10000);assert.equal(f.DB.rows("SELECT COUNT(*)AS n FROM personal_restore_records")[0].n,0);
});
console.log(`Personal restore ${assertions} checks PASS`);
