// B52-002 S3 backend: backup V3 (= V2 content + portable `personalExercise` roots) through the existing staged restore protocol.
// Cards publish into the account's `personalExercises` metadata root by id (importHistory template): NEW / SAME / CONFLICT, a tombstone
// is never revived, undo removes only cards still exactly as written. V1/V2 behaviour and count shapes stay unchanged.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createD1} from './lib/d1-sqlite.mjs';
import worker from '../worker/index.js';
import {parsePortable,validatePortableRoot} from '../worker/personal-backup-contract.js';
import {validatePortableRootV2} from '../worker/personal-backup-v2-contract.js';
import {validatePortableRootV3,personalExercisesOpaque} from '../worker/personal-backup-v3-contract.js';
import {storageJSON,assembleRecordData} from '../worker/record-sync-storage.js';

const golden=parsePortable(readFileSync(new URL('../tests/fixtures/personal-backup-v1-golden.json',import.meta.url),'utf8'));
const fixtureV2=JSON.parse(readFileSync(new URL('../tests/fixtures/personal-backup-v2-golden.json',import.meta.url),'utf8'));
let checks=0;
const test=async(name,fn)=>{if(process.env.B52_TEST_FILTER&&!name.includes(process.env.B52_TEST_FILTER))return;await fn();checks++;console.log(`PASS ${name}`);};
const error=(fn,code)=>assert.throws(fn,e=>e.code===`RESTORE_${code}`,code);
const T='2026-10-31T10:00:00.000Z';
const card=(id,over={})=>({id:`custom:card:${id}`,v:1,name:`Kart ${id}`,primaryMuscle:'lats',assistingMuscles:['biceps'],equipment:'cable',description:null,legacyCustomIds:[],catalogMatch:null,createdAt:T,updatedAt:T,rev:1,deletedAt:null,displaced:[],...over});
const displaced=(over={})=>({name:'Eski',primaryMuscle:null,assistingMuscles:[],equipment:null,description:'d',legacyCustomIds:['custom:old'],catalogMatch:{catalogId:'ex_000001',matchedAt:T},rev:0,updatedAt:T,deletedAt:null,reason:'edit-conflict',displacedAt:T,...over});
const rich=id=>card(id,{legacyCustomIds:['custom:bench-x','custom:legacy:1'],catalogMatch:{catalogId:'ex_000123',matchedAt:T},description:'açıklama 😀',displaced:[displaced(),displaced({reason:'delete-superseded',deletedAt:T,catalogMatch:null})],rev:7});
const root=c=>({kind:'personalExercise',record:c});
const CARDS='["personalExercises"]';

let serial=0;
function environment(options={}){
 const DB=createD1(),id=`v3-${++serial}`,token=`v3-token-${serial}`;
 DB.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at)VALUES(?,?,'h','s','now')").run(id,id+'@example.test');
 DB.raw.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at)VALUES(?,?,?,'now','2099-01-01')").run(`auth-${id}`,id,createHash('sha256').update(token).digest('base64url'));
 const env={DB,...(options.env||{})};
 const request=(path,p,level)=>new Request(`https://example.test/api/${path}`,{method:p===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(level===null?{}:{'X-Reptrio-Data-Level':String(level)})},...(p===undefined?{}:{body:storageJSON(p)})});
 const call=async(action,p,op,level=options.level===undefined?2:options.level)=>{DB.resetMetrics();const response=await worker.fetch(request(`backup/restore/operations${op?`/${op}/${action}`:''}`,p,level),env,{waitUntil(){}});const body=await response.json();assert.ok(DB.metrics.queries<=50,`queries ${DB.metrics.queries}`);return {response,body};};
 const capabilities=async()=>(await worker.fetch(request('sync/capabilities',undefined,2),env,{waitUntil(){}})).json();
 return {DB,id,env,call,capabilities,token};
}
const ok=async promise=>{const {response,body}=await promise;assert.equal(response.status,200,storageJSON(body));return body;};
const expectedFor=(roots,v3=true)=>{const c={sessions:0,sets:0,programs:0,days:0,sections:0,exercises:0,measurements:0,gyms:0,importHistory:0,...(v3?{personalExercises:0}:{})};for(const r of roots){if(r.kind==='session'){c.sessions++;c.sets+=Object.values(r.record.sets).reduce((n,g)=>n+Object.keys(g).length,0);}if(r.kind==='measurement')c.measurements++;if(r.kind==='program'){c.programs++;for(const d of r.record.days||[]){c.days++;for(const s of d.sections||[]){c.sections++;c.exercises+=(s.items||[]).length;}}}if(r.kind==='settings')c.gyms+=(r.record.gyms||[]).length;if(r.kind==='importHistory')c.importHistory++;if(r.kind==='personalExercise'&&v3)c.personalExercises++;}return c;};
const startBody=(roots,version,baseRevision,namespace='source')=>({sourceNamespace:namespace,archiveRetryHash:'a'.repeat(64),localBinding:'local-7',dataSchemaVersion:9,expectedChunks:Math.max(1,Math.ceil(roots.length/16)),expectedCounts:expectedFor(roots,version===3),baseRevision,...(version===1?{}:{backupSchemaVersion:version})});
const revision=f=>f.DB.rows('SELECT revision FROM sync_account_state WHERE user_id=?',f.id)[0]?.revision??0;
async function prepare(f,roots,{version=3,selection,namespace}={}){
 const baseRevision=revision(f),operation=await ok(f.call('start',startBody(roots,version,baseRevision,namespace)));assert.equal(operation.protocol,version);
 const chunks=Math.max(1,Math.ceil(roots.length/16));for(let i=0;i<chunks;i++)await ok(f.call('chunks',{localBinding:'local-7',index:i,roots:roots.slice(i*16,(i+1)*16)},operation.operationId));
 let finalized;for(let i=0;i<100;i++){finalized=await ok(f.call('finalize',{localBinding:'local-7',generationId:finalized?.generationId},operation.operationId));if(finalized.status==='READY')break;}
 let preview;for(let i=0;i<100;i++){preview=await ok(f.call('preview',{localBinding:'local-7',generationId:preview?.generationId,...(selection===undefined?{}:{selection})},operation.operationId));if(preview.status==='READY')break;}assert.equal(preview.status,'READY');
 return {operation,finalized,preview,input:{localBinding:'local-7',confirm:true,previewDigest:preview.previewDigest,semanticDigest:preview.semanticDigest,selectionDigest:preview.selectionDigest,baseRevision}};
}
const restore=async(f,roots,options)=>{const ready=await prepare(f,roots,options);return {...ready,outcome:await ok(f.call('commit',ready.input,ready.operation.operationId))};};
async function readyUndo(f,id){let result;for(let i=0;i<100;i++){const response=await f.call('undo-preview',{localBinding:'local-7',generationId:result?.generationId},id);if(response.response.status!==200)return response;result=response.body;if(result.status==='READY')return response;}assert.fail('undo continuation did not terminate');}
async function undoAll(f,id){const r=await readyUndo(f,id);assert.equal(r.response.status,200,storageJSON(r.body));return ok(f.call('undo',{localBinding:'local-7',confirm:true,undoDigest:r.body.undoDigest,baseRevision:r.body.baseRevision},id));}
const data=f=>assembleRecordData(f.DB.rows('SELECT * FROM sync_records WHERE user_id=?',f.id));
const rowsExcept=(f,keys)=>storageJSON(f.DB.rows(`SELECT kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision,tombstone FROM sync_records WHERE user_id=? AND NOT(kind='metadata' AND record_key IN(${keys.map(()=>'?').join(',')})) ORDER BY kind,record_key`,f.id,...keys));
const accountDump=f=>storageJSON(['sync_account_state','sync_records','personal_restore_identity_journal','sync_account_data_features'].map(t=>f.DB.rows(`SELECT * FROM ${t} ORDER BY rowid`)));
const level=f=>f.DB.rows('SELECT level FROM sync_account_data_features WHERE user_id=?',f.id)[0]?.level??0;
// A later device write of the card root (what a sync push would store), at a new revision.
function writeCards(f,cards){
 const next=revision(f)+1,existing=f.DB.rows("SELECT 1 FROM sync_records WHERE user_id=? AND kind='metadata' AND record_key=?",f.id,CARDS).length;
 if(existing)f.DB.raw.prepare("UPDATE sync_records SET payload_json=?,modified_revision=?,tombstone=0,deleted_revision=NULL WHERE user_id=? AND kind='metadata' AND record_key=?").run(storageJSON(cards),next,f.id,CARDS);
 else f.DB.raw.prepare("INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision)VALUES(?,'metadata',?,NULL,50,?,?,?,?)").run(f.id,CARDS,storageJSON({field:'personalExercises',collection:false}),storageJSON(cards),next,next);
 f.DB.raw.prepare('UPDATE sync_account_state SET revision=?,write_token=? WHERE user_id=?').run(next,`later-${next}`,f.id);
}
const classes=f=>Object.fromEntries(f.DB.rows("SELECT address_json,classification,selected FROM personal_restore_records WHERE record_key=? AND root_id>=0",CARDS).map(r=>[JSON.parse(r.address_json)[0].slice(12),`${r.classification}/${r.selected}`]));

await test('V3 codec: closed card schema, storage limits, tombstones, delegation to the unchanged V2 validator',async()=>{
 for(const c of [card('a'),rich('b'),card('t',{deletedAt:T}),card('n',{name:'x'.repeat(500),description:'y'.repeat(5000),assistingMuscles:Array(20).fill('m'.repeat(64)),legacyCustomIds:Array.from({length:50},(_,i)=>`custom:${i}`),displaced:Array(5).fill(displaced())}),card('z',{id:'custom:card:'+'q'.repeat(116)})])assert.deepEqual(validatePortableRootV3(structuredClone(root(c))),root(c));
 const bad=[
  [{unknown:1},'UNSUPPORTED_PERSONAL_FIELD'],[{accessToken:'x'},'SECRET_FIELD'],[{catalogMatch:{catalogId:'ex_1',matchedAt:T,extra:1}},'UNSUPPORTED_PERSONAL_FIELD'],[{displaced:[{...displaced(),extra:1}]},'UNSUPPORTED_PERSONAL_FIELD'],
  [{id:'custom:x'},'TYPE_MISMATCH'],[{id:'custom:other:abcdefgh'},'TYPE_MISMATCH'],[{id:'ex_000001-personal-card'},'TYPE_MISMATCH'],[{id:'custom:card:'},'TYPE_MISMATCH'],[{id:'custom:card:'+'q'.repeat(117)},'TYPE_MISMATCH'],[{id:7},'TYPE_MISMATCH'],[{v:2},'TYPE_MISMATCH'],
  [{name:'x'.repeat(501)},'TYPE_MISMATCH'],[{name:null},'TYPE_MISMATCH'],[{description:'y'.repeat(5001)},'TYPE_MISMATCH'],[{primaryMuscle:'m'.repeat(65)},'TYPE_MISMATCH'],[{equipment:'e'.repeat(65)},'TYPE_MISMATCH'],
  [{assistingMuscles:Array(21).fill('m')},'TYPE_MISMATCH'],[{assistingMuscles:[1]},'TYPE_MISMATCH'],[{assistingMuscles:['m'.repeat(65)]},'TYPE_MISMATCH'],
  [{legacyCustomIds:['custom:card:x']},'TYPE_MISMATCH'],[{legacyCustomIds:['ex_000001']},'TYPE_MISMATCH'],[{legacyCustomIds:Array.from({length:51},(_,i)=>`custom:${i}`)},'TYPE_MISMATCH'],[{legacyCustomIds:['custom:'+'l'.repeat(250)]},'TYPE_MISMATCH'],
  [{catalogMatch:{catalogId:'c'.repeat(129),matchedAt:T}},'TYPE_MISMATCH'],[{catalogMatch:{catalogId:'ex_1',matchedAt:'never'}},'INVALID_TIME'],[{catalogMatch:{catalogId:'ex_1'}},'MISSING_FIELD'],[{catalogMatch:'ex_1'},'TYPE_MISMATCH'],
  [{rev:-1},'TYPE_MISMATCH'],[{rev:1.5},'TYPE_MISMATCH'],[{createdAt:'x'},'INVALID_TIME'],[{updatedAt:''},'INVALID_TIME'],[{deletedAt:''},'INVALID_TIME'],
  [{displaced:Array(6).fill(displaced())},'TYPE_MISMATCH'],[{displaced:{}},'TYPE_MISMATCH'],[{displaced:[{...displaced(),reason:'other'}]},'TYPE_MISMATCH'],[{displaced:[displaced({displacedAt:'x'})]},'INVALID_TIME'],[{displaced:[displaced({rev:-2})]},'TYPE_MISMATCH'],[{displaced:[displaced({legacyCustomIds:['custom:card:y']})]},'TYPE_MISMATCH'],
 ];
 for(const [patch,code] of bad)error(()=>validatePortableRootV3(root(card('a',patch))),code);
 for(const field of Object.keys(card('a'))){const c=card('a');delete c[field];error(()=>validatePortableRootV3(root(c)),'MISSING_FIELD');}
 {const d=displaced();delete d.reason;error(()=>validatePortableRootV3(root(card('a',{displaced:[d]}))),'MISSING_FIELD');}
 error(()=>validatePortableRootV3({...root(card('a')),setOrder:{groups:[]}}),'ENVELOPE_INVALID');
 const getter=root(card('a'));Object.defineProperty(getter.record,'name',{enumerable:true,get(){assert.fail('getter executed');}});assert.throws(()=>validatePortableRootV3(getter));
 // Older readers refuse the new root kind; V3 delegates every other root to V2 (and so to V1) unchanged.
 error(()=>validatePortableRootV2(root(card('a'))),'UNSUPPORTED_PERSONAL_CONTRACT');error(()=>validatePortableRoot(root(card('a'))),'UNSUPPORTED_PERSONAL_CONTRACT');
 for(const r of [...structuredClone(golden.roots),...structuredClone(fixtureV2.roots)])assert.deepEqual(validatePortableRootV3(structuredClone(r)),validatePortableRootV2(structuredClone(r)));
 error(()=>validatePortableRootV3({kind:'personalExercises',record:card('a')}),'UNSUPPORTED_PERSONAL_CONTRACT');
 // Undo proof scope: only uninterpretable content of the stored list.
 assert.deepEqual(personalExercisesOpaque([card('a'),rich('b')]),{});
 assert.deepEqual(personalExercisesOpaque([card('a'),card('b',{future:1,catalogMatch:{catalogId:'x',matchedAt:T,note:2},displaced:[displaced(),{...displaced(),z:3}]}),7]),{entries:[{index:1,id:'custom:card:b',opaque:{future:1,catalogMatch:{note:2},displaced:[{index:1,opaque:{z:3}}]}},{index:2,id:null,opaque:{malformed:7}}]});
 assert.deepEqual(personalExercisesOpaque({}),{malformed:{}});
});

await test('V3 negotiation: capability list, flag-off refusal, level-2 client, count shape, duplicate ids, V2 unchanged',async()=>{
 const f=environment(),roots=[root(card('a'))];
 assert.deepEqual((await f.capabilities()).personalBackupVersions,[1,2,3]);
 const off=environment({env:{PERSONAL_EXERCISES_ENABLED:'false'}});assert.deepEqual((await off.capabilities()).personalBackupVersions,[1,2]);
 const refused=await off.call('start',startBody(roots,3,0));assert.equal(refused.response.status,409);assert.equal(refused.body.code,'RESTORE_UNSUPPORTED_BACKUP_VERSION');
 assert.equal((await ok(off.call('start',startBody([],2,0)))).protocol,2,'V2 still starts with the flag off');
 assert.equal(off.DB.rows('SELECT COUNT(*) AS n FROM personal_restore_operations')[0].n,1,'the refused V3 start left no operation');
 assert.deepEqual((await environment({env:{PERSONAL_RESTORE_ENABLED:'false'}}).capabilities()).personalBackupVersions,[]);
 for(const lvl of [null,1]){const r=await environment({level:lvl}).call('start',startBody(roots,3,0));assert.deepEqual([r.response.status,r.body.code],[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);}
 assert.equal((await f.call('start',{...startBody(roots,3,0),expectedCounts:expectedFor(roots,false)})).body.code,'RESTORE_COUNT_INVALID','V3 counts carry personalExercises');
 assert.equal((await f.call('start',{...startBody(roots,2,0),expectedCounts:expectedFor(roots,true)})).body.code,'RESTORE_ENVELOPE_INVALID','V1/V2 counts keep the 9-key shape');
 assert.equal((await f.call('start',{...startBody(roots,3,0),expectedCounts:{...expectedFor(roots),personalExercises:1001}})).body.code,'RESTORE_COUNT_INVALID');
 assert.equal((await f.call('start',{...startBody(roots,3,0),expectedCounts:{...expectedFor(roots),personalExercises:1000}})).response.status,200);
 const v2=await ok(f.call('start',startBody(roots,2,0)));assert.equal((await f.call('chunks',{localBinding:'local-7',index:0,roots},v2.operationId)).body.code,'RESTORE_UNSUPPORTED_PERSONAL_CONTRACT','a V2 operation never accepts cards');
 const v1=await ok(f.call('start',startBody(roots,1,0)));assert.equal((await f.call('chunks',{localBinding:'local-7',index:0,roots},v1.operationId)).body.code,'RESTORE_UNSUPPORTED_PERSONAL_CONTRACT');
 const dup=[root(card('d')),root(card('d',{name:'other'}))],op=await ok(f.call('start',startBody(dup,3,0)));{const r=await f.call('chunks',{localBinding:'local-7',index:0,roots:dup},op.operationId);assert.notEqual(r.response.status,200);assert.ok(['RESTORE_DUPLICATE_SOURCE_ID','RESTORE_UNAVAILABLE'].includes(r.body.code),r.body.code);assert.equal(f.DB.rows('SELECT COUNT(*) AS n FROM personal_restore_roots WHERE operation_id=?',op.operationId)[0].n,0,'duplicate card id stages nothing');}
 const bad=await ok(f.call('start',startBody(roots,3,0)));assert.equal((await f.call('chunks',{localBinding:'local-7',index:0,roots:[root(card('a',{x:1}))]},bad.operationId)).body.code,'RESTORE_UNSUPPORTED_PERSONAL_FIELD');
 const counted=await ok(f.call('start',startBody(roots,3,0)));const chunk=await ok(f.call('chunks',{localBinding:'local-7',index:0,roots},counted.operationId));assert.deepEqual(chunk.counts,expectedFor(roots));
 const fin=await ok(f.call('finalize',{localBinding:'local-7'},counted.operationId));assert.deepEqual(fin.counts,expectedFor(roots));
 const wrong=await ok(f.call('start',{...startBody(roots,3,0),expectedCounts:{...expectedFor(roots),personalExercises:2}}));await ok(f.call('chunks',{localBinding:'local-7',index:0,roots},wrong.operationId));assert.equal((await f.call('finalize',{localBinding:'local-7'},wrong.operationId)).body.code,'RESTORE_COUNT_MISMATCH');
 const v2counted=await ok(f.call('start',startBody(fixtureV2.roots,2,0)));const v2chunk=await ok(f.call('chunks',{localBinding:'local-7',index:0,roots:structuredClone(fixtureV2.roots)},v2counted.operationId));assert.deepEqual(Object.keys(v2chunk.counts).sort(),Object.keys(fixtureV2.expectedCounts).sort(),'V2 count shape unchanged');
});

await test('V3 full archive on an empty account: V2 content restores exactly as V2, cards appended, level 2, ALL undo',async()=>{
 const v2=environment();await restore(v2,structuredClone(fixtureV2.roots),{version:2});const viaV2=data(v2);
 const f=environment(),cards=[card('a'),rich('b'),card('t',{deletedAt:T})],result=await restore(f,[...structuredClone(fixtureV2.roots),...cards.map(root)]);
 const viaV3=data(f);assert.deepEqual(viaV3.personalExercises,cards,'cards field-for-field, tombstone included');delete viaV3.personalExercises;assert.deepEqual(viaV3,viaV2,'V2 content identical');
 assert.equal(level(f),2,'restoring cards raises the account to data level 2');assert.ok(level(v2)<2,'a V2 restore never reaches level 2');
 assert.ok(result.outcome.counts.some(c=>c.kind==='metadataPath'&&c.classification==='NEW'));
 await undoAll(f,result.operation.operationId);const after=data(f);assert.deepEqual(after.personalExercises,[],'the card list restore created is emptied again (the root itself is never tombstoned)');
 assert.equal(f.DB.rows("SELECT tombstone FROM sync_records WHERE record_key=?",CARDS)[0].tombstone,0,'a tombstoned card root would refuse every later card');
});

await test('after a restore and its undo the account keeps working: a push with a card is accepted and a second restore writes',async()=>{
 const f=environment(),push=(body,sv)=>worker.fetch(new Request('https://example.test/api/sync/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${f.token}`,'X-Reptrio-Data-Level':'2'},body:JSON.stringify({data:body,syncVersion:sv})}),f.env,{waitUntil(){}});
 const base={schemaVersion:8,programs:[],sessions:[],measurements:[{id:'m1',recordedAt:T,weightKg:80,waistCm:null,bodyFatPercent:null}],settings:{weightUnit:'kg'}};
 assert.equal((await push(base,0)).status,200);
 const first=await restore(f,[root(card('a'))],{namespace:'one'});await undoAll(f,first.operation.operationId);
 const sent=await push({...base,personalExercises:[card('mine')]},revision(f));
 assert.equal(sent.status,200,'a card push after the undo is accepted: '+JSON.stringify(await sent.clone().json()));
 assert.deepEqual(data(f).personalExercises.map(c=>c.id),['custom:card:mine']);
 await restore(f,[root(card('b'))],{namespace:'two'});
 assert.deepEqual(data(f).personalExercises.map(c=>c.id).sort(),['custom:card:b','custom:card:mine'],'a second restore from another source adds its card');
});


await test('V3 classification by id: NEW / SAME / CONFLICT, tombstone never revived, existing data untouched',async()=>{
 const f=environment();await restore(f,structuredClone(golden.roots),{version:1});const keep=[CARDS,'["schemaVersion"]'];
 const A=card('same'),B=card('edited'),C=card('dead',{deletedAt:T}),D=card('alive'),E=rich('new'),F=card('newdead',{deletedAt:T});
 writeCards(f,[A,B,C,D]);const before=data(f),otherRows=rowsExcept(f,keep),cardRow=f.DB.rows('SELECT payload_json FROM sync_records WHERE record_key=?',CARDS)[0].payload_json;
 const backup=[...structuredClone(golden.roots),root(A),root({...B,name:'changed',rev:2}),root({...C,deletedAt:null}),root({...D,deletedAt:T}),root(E),root(F)];
 const ready=await prepare(f,backup);
 assert.deepEqual(classes(f),{same:'SAME/1',edited:'CONFLICT/0',dead:'CONFLICT/0',alive:'CONFLICT/0',new:'NEW/1',newdead:'NEW/1'});
 assert.ok(f.DB.rows("SELECT classification FROM personal_restore_records WHERE root_id>=0 AND record_key<>?",CARDS).every(r=>r.classification==='SAME'),'golden content already present is SAME');
 // An explicit choice of the conflicting card still never overwrites it.
 await prepare(f,backup,{selection:{mode:'explicit',roots:[{kind:'personalExercise',sourceTuple:storageJSON([B.id])},{kind:'personalExercise',sourceTuple:storageJSON([E.id])}]}});
 assert.deepEqual(classes(f),{same:'SAME/0',edited:'CONFLICT/0',dead:'CONFLICT/0',alive:'CONFLICT/0',new:'NEW/1',newdead:'NEW/0'});
 const again=await prepare(f,backup);const outcome=await ok(f.call('commit',again.input,again.operation.operationId));assert.equal(outcome.status,'COMMITTED');
 const after=data(f);assert.deepEqual(after.personalExercises,[A,B,C,D,E,F],'conflicts kept as stored, new cards appended by id');assert.equal(after.personalExercises[2].deletedAt,T,'tombstone not revived');
 delete after.personalExercises;delete before.personalExercises;assert.deepEqual(after,before,'sessions/programs/measurements/settings/importHistory unchanged');
 assert.equal(rowsExcept(f,keep),otherRows,'every other stored row byte-identical (payload, address, ordinal, revisions)');
 assert.ok(f.DB.rows('SELECT payload_json FROM sync_records WHERE record_key=?',CARDS)[0].payload_json.startsWith(cardRow.slice(0,-1)),'existing card bytes kept as the prefix');
 assert.equal(level(f),2);
 // Undo removes only the two cards this restore added; SAME/CONFLICT cards and golden data stay.
 await undoAll(f,again.operation.operationId);const undone=data(f);assert.deepEqual(undone.personalExercises,[A,B,C,D]);delete undone.personalExercises;assert.deepEqual(undone,before);assert.equal(rowsExcept(f,keep),otherRows);
 // Same source after undo is ledger evidence, never re-added silently.
 const ledger=await prepare(f,backup);assert.equal(classes(f).new,'LEDGER/0');assert.ok(ledger.preview.classifications.some(c=>c.classification==='LEDGER'));
 // Invalid stored list: every card is a CONFLICT, nothing is merged into it.
 const g=environment();await restore(g,[root(card('seed'))]);writeCards(g,{not:'a list'});await prepare(g,[root(card('x'))]);assert.deepEqual(classes(g),{x:'CONFLICT/0'});
});

await test('V3 legacy (pre-records) account: cards inside user_data classify through the bootstrap baseline',async()=>{
 const f=environment(),A=card('legacy');f.DB.raw.prepare('INSERT INTO user_data VALUES(?,?,0,?)').run(f.id,storageJSON({schemaVersion:9,settings:{weightUnit:'kg'},personalExercises:[A]}),'before');
 const ready=await prepare(f,[root(A),root(card('more'))]);assert.deepEqual(classes(f),{legacy:'SAME/1',more:'NEW/1'});const result={...ready,outcome:await ok(f.call('commit',ready.input,ready.operation.operationId))};assert.deepEqual(data(f).personalExercises,[A,card('more')]);assert.deepEqual(data(f).settings,{weightUnit:'kg'});
 await undoAll(f,result.operation.operationId);assert.deepEqual(data(f),{schemaVersion:9,settings:{weightUnit:'kg'},personalExercises:[A]});
});

await test('V3 undo ownership: changed / moved / duplicated restored card blocks with zero effects; other card edits do not',async()=>{
 const base=[card('own'),card('own2')];
 const variants={
  renamed:list=>list.map(c=>c.id==='custom:card:own'?{...c,name:'renamed',rev:2}:c),
  tombstoned:list=>list.map(c=>c.id==='custom:card:own'?{...c,deletedAt:T}:c),
  moved:list=>[list[2],list[0],list[1],list[3]],
  removed:list=>list.filter(c=>c.id!=='custom:card:own'),
  duplicated:list=>[...list,list[2]],
  rootGone:()=>null,
 };
 for(const [mode,change] of Object.entries(variants)){
  const f=environment();writeCardsInit(f,[card('pre1'),card('pre2')]);const result=await restore(f,base.map(root));
  const stored=data(f).personalExercises;assert.equal(stored.length,4);
  if(mode==='rootGone'){const next=revision(f)+1;f.DB.raw.prepare("UPDATE sync_records SET tombstone=1,deleted_revision=?,modified_revision=? WHERE record_key=?").run(next,next,CARDS);f.DB.raw.prepare('UPDATE sync_account_state SET revision=?,write_token=?').run(next,'later');}
  else writeCards(f,change(stored));
  const before=accountDump(f),r=await readyUndo(f,result.operation.operationId);assert.notEqual(r.response.status,200,mode);assert.equal(r.body.code,'RESTORE_UNDO_CHANGED',`${mode}: ${storageJSON(r.body)}`);assert.equal(accountDump(f),before,mode);
 }
 // A known-field edit of a card that existed before the restore keeps undo possible and survives it.
 {const f=environment();writeCardsInit(f,[card('pre1'),card('pre2')]);const result=await restore(f,base.map(root));const stored=data(f).personalExercises;
  const edited={...stored[0],name:'edited later',rev:5,displaced:[displaced()]},added=card('later');writeCards(f,[edited,stored[1],stored[2],stored[3],added]);
  await undoAll(f,result.operation.operationId);assert.deepEqual(data(f).personalExercises,[edited,card('pre2'),added],'only the restored cards leave');}
 // A change to content the server cannot interpret (unknown future field of another card) blocks undo with zero effects.
 {const f=environment();writeCardsInit(f,[card('pre1',{future:1}),card('pre2')]);const result=await restore(f,base.map(root));const stored=data(f).personalExercises;
  writeCards(f,[{...stored[0],future:2},...stored.slice(1)]);const before=accountDump(f),r=await readyUndo(f,result.operation.operationId);assert.equal(r.body.code,'RESTORE_UNDO_DEPENDENCY',storageJSON(r.body));assert.equal(accountDump(f),before);}
 // Unchanged opaque content: undo proceeds and keeps it byte-exact.
 {const f=environment();writeCardsInit(f,[card('pre1',{future:{deep:[1,-0]}})]);const row=()=>f.DB.rows('SELECT payload_json FROM sync_records WHERE record_key=?',CARDS)[0].payload_json,original=row();const result=await restore(f,base.map(root));
  await undoAll(f,result.operation.operationId);assert.equal(row(),original);}
});
function writeCardsInit(f,cards){
 // First device write on a fresh account (records authority), as a level-2 sync push would leave it.
 f.DB.raw.prepare("INSERT INTO sync_account_state(user_id,storage_schema_version,revision,write_token,write_status,updated_at)VALUES(?,1,0,'seed','ACTIVE','now')").run(f.id);writeCards(f,cards);
 f.DB.raw.prepare("INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision)VALUES(?,'metadata','[\"schemaVersion\"]',NULL,0,?,'9',1,1)").run(f.id,storageJSON({field:'schemaVersion',collection:false}));
}

await test('V3 re-preview with a narrower selection drops the staged card merge; nothing outside the selection publishes',async()=>{
 const f=environment(),roots=[root(card('a')),root(card('b')),{kind:'measurement',record:structuredClone(fixtureV2.roots.find(r=>r.kind==='measurement').record)}];
 const first=await prepare(f,roots),id=first.operation.operationId;assert.equal(f.DB.rows('SELECT COUNT(*) AS n FROM personal_restore_records WHERE root_id=-5')[0].n,1);
 const selection={mode:'explicit',roots:[{kind:'measurement',sourceTuple:storageJSON([roots[2].record.id])}]};let preview;
 for(let i=0;i<100;i++){preview=await ok(f.call('preview',{localBinding:'local-7',generationId:preview?.generationId,selection},id));if(preview.status==='READY')break;}
 assert.equal(f.DB.rows('SELECT COUNT(*) AS n FROM personal_restore_records WHERE root_id=-5')[0].n,0,'stale synthetic card merge cleared');
 assert.equal((await f.call('commit',first.input,id)).body.code,'RESTORE_CONFIRMATION_INVALID','the earlier preview digest no longer commits');
 await ok(f.call('commit',{...first.input,previewDigest:preview.previewDigest,selectionDigest:preview.selectionDigest},id));const after=data(f);assert.equal(after.personalExercises,undefined);assert.equal(after.measurements.length,1);assert.equal(level(f)<2,true);
});

await test('V3 merge respects the storage limit and the commit gate for older clients',async()=>{
 const f=environment();writeCardsInit(f,Array.from({length:999},(_,i)=>card(`k${i}`)));
 await prepare(f,[root(card('fits'))]);
 const r=await f.call('start',startBody([root(card('x')),root(card('y'))],3,revision(f)));const op=r.body.operationId;await ok(f.call('chunks',{localBinding:'local-7',index:0,roots:[root(card('x')),root(card('y'))]},op));await ok(f.call('finalize',{localBinding:'local-7'},op));
 let preview,last;for(let i=0;i<20;i++){last=await f.call('preview',{localBinding:'local-7',generationId:preview?.generationId},op);if(last.response.status!==200)break;preview=last.body;if(preview.status==='READY')break;}
 assert.deepEqual([last.response.status,last.body.code],[400,'SYNC_PAYLOAD_INVALID'],'1001 cards after the merge are refused');
 const g=environment(),ready=await prepare(g,[root(card('a'))]),before=accountDump(g);
 for(const lvl of [null,1]){const call=await worker.fetch(new Request(`https://example.test/api/backup/restore/operations/${ready.operation.operationId}/commit`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer v3-token-${serial}`,...(lvl===null?{}:{'X-Reptrio-Data-Level':String(lvl)})},body:storageJSON(ready.input)}),g.env,{waitUntil(){}});assert.deepEqual([call.status,(await call.json()).code],[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);}
 assert.equal(accountDump(g),before);await ok(g.call('commit',ready.input,ready.operation.operationId));assert.equal(level(g),2);
});

await test('V3 keeps every V2 rule: onboarding measurement dependency and V2 profile fields in the undo proof',async()=>{
 // Excluding the initial measurement makes the onboarding leaf a DEPENDENCY, exactly as in V2.
 const f=environment(),roots=[...structuredClone(fixtureV2.roots),root(card('a'))];
 await prepare(f,roots,{selection:{mode:'explicit',roots:[{kind:'settings',sourceTuple:'["settings"]'},{kind:'personalExercise',sourceTuple:storageJSON([card('a').id])}]}});
 assert.equal(f.DB.rows(`SELECT classification FROM personal_restore_records WHERE address_json='["profile","onboarding"]'`)[0].classification,'DEPENDENCY');
 // A later edit of a known V2 profile answer the restore did not add is interpretable content: undo of the cards stays possible.
 const g=environment();writeCardsInit(g,[card('pre')]);
 const next=revision(g)+1;g.DB.raw.prepare("INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision)VALUES(?,'metadata','[\"settings\"]',NULL,2,?,?,?,?)").run(g.id,storageJSON({field:'settings',collection:false}),storageJSON({weightUnit:'kg',profile:{displayName:'',avatarDataUrl:'',goal:'strength'}}),next,next);g.DB.raw.prepare('UPDATE sync_account_state SET revision=?,write_token=?').run(next,'later');
 const result=await restore(g,[root(card('x'))]);
 const r=g.DB.rows("SELECT payload_json FROM sync_records WHERE record_key='[\"settings\"]'")[0],v=JSON.parse(r.payload_json);v.profile.goal='fat_loss';const n2=revision(g)+1;g.DB.raw.prepare("UPDATE sync_records SET payload_json=?,modified_revision=? WHERE record_key='[\"settings\"]'").run(storageJSON(v),n2);g.DB.raw.prepare('UPDATE sync_account_state SET revision=?,write_token=?').run(n2,'later2');
 await undoAll(g,result.operation.operationId);assert.deepEqual(data(g).personalExercises,[card('pre')]);assert.equal(data(g).settings.profile.goal,'fat_loss');
});

await test('V2 restore into an account holding cards: card root untouched, V2 undo unchanged',async()=>{
 const f=environment();writeCardsInit(f,[card('kept')]);const row=()=>storageJSON(f.DB.rows('SELECT * FROM sync_records WHERE record_key=?',CARDS)),original=row();
 const result=await restore(f,structuredClone(fixtureV2.roots),{version:2});assert.equal(row(),original);assert.equal(result.finalized.counts.personalExercises,undefined);
 await undoAll(f,result.operation.operationId);assert.equal(row(),original);assert.deepEqual(data(f).personalExercises,[card('kept')]);
});

console.log(`Personal restore V3 ${checks} checks PASS`);
