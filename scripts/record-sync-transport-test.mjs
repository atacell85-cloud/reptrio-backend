import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { splitData,assembleRecordData,LIMITS } from '../worker/record-sync-storage.js';
import { TRANSPORT_LIMITS,cleanupMutationReceipts } from '../worker/record-sync-transport.js';
import { createD1 } from './lib/d1-sqlite.mjs';
const ORIGIN='https://fixtures.example';
let serial=0;
const session=(id,sets={})=>({id,title:id,sets});
const base=()=>({schemaVersion:8,programs:[{id:'p',days:[],name:'original'}],sessions:[session('s',{g:{k:{id:'optional',exerciseId:'x',setNumber:3,completed:false}}})],measurements:[{id:'m',weightKg:70}],settings:{rest:90,opaque:{a:null}},draft:null});
async function fixture(options={}) {
  const db=createD1(options),id=`transport-${++serial}`,token=`token-${serial}`;
  db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,'h','s','now')").run(id,`${id}@example.test`);
  db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,'now','2099-01-01')").run(`auth-${id}`,id,await tokenDigest(token));
  const env={DB:db},call=(route,init={},auth=token)=>worker.fetch(new Request(`${ORIGIN}/api/sync/${route}`,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth}`,...init.headers}}),env,{waitUntil(){}});
  const push=(data,rev=0)=>call('push',{method:'POST',body:JSON.stringify({data,syncVersion:rev})});
  const mutation=(change={},rev=1,mutationId=`mu-${++serial}`)=>call('records/mutations',{method:'POST',body:JSON.stringify({mutationId,baseRevision:rev,clientSchemaVersion:8,...change})});
  const pull=async()=>{const r=await call('pull');assert.equal(r.status,200);return r.json();};
  const dump=()=>JSON.stringify(['sync_account_state','sync_records','sync_mutation_receipts'].filter(table=>db.rows("SELECT name FROM sqlite_master WHERE name=?",table).length).map(table=>db.rows(`SELECT * FROM ${table} ORDER BY user_id`)));
  return {id,token,db,env,call,push,mutation,pull,dump};
}
const error=async response=>[response.status,(await response.json()).code];
const ok=async response=>{const text=await response.text();assert.equal(response.status,200,text);return JSON.parse(text);};
async function zero(f,action,expected) {const before=f.dump();f.db.resetMetrics();assert.deepEqual(await error(await action()),expected);assert.equal(f.dump(),before);assert.equal(f.db.metrics.writes,0);}
const compare=(a,b)=>Buffer.compare(Buffer.from(a.kind),Buffer.from(b.kind)) || Buffer.compare(Buffer.from(a.record_key),Buffer.from(b.record_key));
class Collector {
  constructor(){this.rows=[];this.header=null;this.done=false;}
  add(page){
    assert.equal(this.done,false);assert.equal(page.start,this.rows.length,'page omission/replay cannot advance prefix');assert.equal(page.cumulative,page.start+page.records.length);
    if(this.header)for(const key of ['syncVersion','updatedAt','total','mode','protocol','storageSchemaVersion'])assert.equal(page[key],this.header[key]);else this.header=page;
    for(const row of page.records){if(this.rows.length)assert.ok(compare(this.rows.at(-1),row)<0,'strict unique keyset prefix');this.rows.push(row);}
    assert.equal(page.terminal,page.cumulative===page.total);assert.equal(page.continuation===null,page.terminal);if(page.terminal){assert.equal(this.rows.length,page.total);this.done=true;}
  }
}
async function collect(f){const c=new Collector();let cursor=null,maxQueries=0,maxBytes=0;do{f.db.resetMetrics();const r=await f.call(`records${cursor ? `?cursor=${encodeURIComponent(cursor)}`:''}`),text=await r.text();assert.equal(r.status,200,text);const page=JSON.parse(text);maxQueries=Math.max(maxQueries,f.db.metrics.queries);maxBytes=Math.max(maxBytes,Buffer.byteLength(text));assert.ok(f.db.metrics.queries<=5);assert.ok(Buffer.byteLength(text)<=TRANSPORT_LIMITS.pageBytes);assert.ok(page.records.length<=TRANSPORT_LIMITS.pageRows);assert.ok(!text.includes('write_token'));c.add(page);cursor=page.continuation;}while(cursor);return {rows:c.rows,maxQueries,maxBytes};}
function seed(f,data){
  f.db.raw.prepare("INSERT INTO sync_account_state VALUES (?,1,1,'seed-token','ACTIVE','2026-10-09')").run(f.id);
  const insert=f.db.raw.prepare('INSERT INTO sync_records (user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision) VALUES (?,?,?,?,?,?,?,1,1)');
  const add=(rows,ordinal)=>{for(const row of rows)insert.run(f.id,row.kind,row.record_key,row.parent_key,row.kind==='session'?ordinal:row.ordinal,row.address_json,row.payload_json);};
  const header={...data,sessions:[]};f.db.raw.exec('BEGIN');add(splitData(header));data.sessions.forEach((s,i)=>add(splitData({sessions:[s]}).filter(row=>row.kind!=='metadata'),i));f.db.raw.exec('COMMIT');
}
async function signTuple(f,tuple){const state=f.db.rows('SELECT write_token FROM sync_account_state WHERE user_id=?',f.id)[0],canonical=JSON.stringify(tuple);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(`reptrio-record-page-v1\0${state.write_token}`),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['reptrio-record-page-v1',f.id,canonical])));return `${Buffer.from(canonical).toString('base64url')}.${Buffer.from(sig).toString('base64url')}`;}
const decode=value=>JSON.parse(Buffer.from(value.split('.')[0],'base64url').toString());
function limits(f,max=30){assert.ok(f.db.metrics.queries<=max,JSON.stringify(f.db.metrics));assert.ok(f.db.metrics.maxParams<=100);assert.ok(f.db.metrics.maxSqlBytes<=100_000);assert.ok(f.db.metrics.maxBoundBytes<=LIMITS.chunkBytes);}
// Missing/partial/version/blocked/legacy, auth and disabled routes remain read/write closed.
for(const mode of ['missing','receipt-missing','bad-receipt','bad-state','version','blocked','deleted','legacy','disabled']){
  const f=await fixture(mode==='missing'?{migrationsUpTo:'0007_password_reset_tokens.sql'}:{});
  if(!['missing','legacy'].includes(mode))assert.equal((await f.push(base())).status,200);
  if(mode==='receipt-missing')f.db.raw.exec('DROP TABLE sync_mutation_receipts');
  if(mode==='bad-receipt')f.db.raw.exec('DROP TABLE sync_mutation_receipts; CREATE TABLE sync_mutation_receipts (user_id TEXT)');
  if(mode==='bad-state')f.db.raw.exec('DROP TABLE sync_account_state');
  if(mode==='version')f.db.raw.prepare('UPDATE sync_account_state SET storage_schema_version=99 WHERE user_id=?').run(f.id);
  if(mode==='blocked')f.db.raw.prepare("UPDATE sync_account_state SET write_status='BLOCKED' WHERE user_id=?").run(f.id);
  if(mode==='deleted')f.db.raw.prepare("UPDATE users SET deleted_at='now' WHERE id=?").run(f.id);
  if(mode==='disabled')f.env.RECORD_TRANSPORT_ENABLED='false';
  const code=mode==='missing'?'SYNC_STORAGE_MIGRATION_REQUIRED':mode==='receipt-missing'?'SYNC_TRANSPORT_MIGRATION_REQUIRED':['bad-receipt','bad-state','version'].includes(mode)?'SYNC_STORAGE_SCHEMA_UNSUPPORTED':mode==='blocked'?'SYNC_ACCOUNT_BLOCKED':mode==='deleted'?'AUTH_REQUIRED':mode==='disabled'?'SYNC_TRANSPORT_DISABLED':'SYNC_RECORD_AUTHORITY_REQUIRED';
  const status=['missing','receipt-missing','bad-receipt','bad-state','version','disabled'].includes(mode)?503:mode==='deleted'?401:409;
  await zero(f,()=>f.call('records'),[status,code]);await zero(f,()=>f.mutation({}),[status,code]);
  if(mode==='deleted')continue;
  f.db.resetMetrics();const caps=await ok(await f.call('capabilities'));assert.equal(caps.recordPaging,false);assert.equal(caps.rootDeltaSync,false);assert.equal(caps.personalRestoreProtocol,false);assert.ok(f.db.metrics.queries<=3);assert.equal(f.db.metrics.payloadRows,0);
}
{
  const f=await fixture();await f.push(base());f.db.raw.exec('DELETE FROM auth_sessions');await zero(f,()=>f.call('records'),[401,'AUTH_REQUIRED']);await zero(f,()=>f.mutation({}),[401,'AUTH_REQUIRED']);
}
// >60k records/~10MB account: no whole-account read or request limits applied to account size.
const big=await fixture();const large={schemaVersion:8,programs:[{id:'large-p',days:[]}],sessions:Array.from({length:5000},(_,i)=>session(`s${String(i).padStart(5,'0')}`,{group:Object.fromEntries(Array.from({length:13},(_,j)=>[`key${j}`,{id:`raw-${j}`,exerciseId:'unchanged',setNumber:j,weight:'80',reps:'8',note:'α'.repeat(20),completed:false}]))})),measurements:[],settings:{opaque:{keep:true}}};
assert.ok(Buffer.byteLength(JSON.stringify(large))>10_000_000);seed(big,large);
const all=await collect(big);assert.ok(all.rows.length>60_000);assert.deepEqual(assembleRecordData(all.rows),large);
big.db.resetMetrics();const caps=await ok(await big.call('capabilities'));assert.equal(caps.recordPaging,true);assert.equal(caps.rootDeltaSync,true);assert.equal(caps.personalRestoreProtocol,false);assert.equal(big.db.metrics.queries,3);assert.equal(big.db.metrics.payloadRows,0);
big.db.resetMetrics();const edited=structuredClone(large.sessions[2500]);edited.title='changed-middle';edited.sets.group.key6.weight='85';const receipt=await ok(await big.mutation({upserts:{sessions:[edited]}},1,'big-edit'));limits(big);assert.ok(big.db.metrics.payloadRows<=20);assert.ok(big.db.trace.every(entry=>!entry.sql.includes("'record' AS source")));assert.equal(receipt.ordinals[0].ordinal,2500);assert.equal(big.db.metrics.orderOnlyRows,0);console.log(`Single-root edit metrics: ${JSON.stringify(big.db.metrics)}`);
const expected=structuredClone(large);expected.sessions[2500]=edited;assert.deepEqual(assembleRecordData((await collect(big)).rows),expected);
console.log(`Large account: ${all.rows.length} records, ${Buffer.byteLength(JSON.stringify(large))} bytes; page max ${all.maxBytes} bytes/${all.maxQueries} queries; touched edit bounded <=20 payload rows.`);
// Guardian P2 regression: repeated long parent keys and escaped projection bytes are bounded
// in the SAME SQL snapshot before any personal payload is returned.
for(const id of ['x'.repeat(3005),'α"\\'.repeat(300)]){
  const f=await fixture();const root={id,title:'original',sets:{g:Object.fromEntries(Array.from({length:1000},(_,i)=>[`k${i}`,{reps:'5'}]))}};
  const d={schemaVersion:8,programs:[],sessions:[root],measurements:[]};assert.ok(Buffer.byteLength(JSON.stringify(d))<4_000_000);await ok(await f.push(d));
  const actual=Buffer.byteLength(JSON.stringify(f.db.rows('SELECT * FROM sync_records WHERE user_id=?',f.id)));assert.ok(actual>4_000_000);
  await zero(f,()=>f.mutation({upserts:{sessions:[{...root,title:'edited'}]}}),[413,'SYNC_ROOT_LIMIT']);assert.equal(f.db.metrics.payloadRows,0);assert.equal(f.db.metrics.batches,0);assert.ok(f.db.metrics.maxReturnedBytes<10_000);console.log(`P2 oversize projection ${actual} bytes:0 personal payload rows/0 batches.`);
}
{
  const f=await fixture();const id='α"\\'.repeat(170);const root={id,title:'original',sets:{g:Object.fromEntries(Array.from({length:1000},(_,i)=>[`k${i}`,{reps:'5'}]))}};const d={schemaVersion:8,programs:[],sessions:[root],measurements:[]};await ok(await f.push(d));f.db.resetMetrics();const change={upserts:{sessions:[{...root,title:'edited'}]}};const result=await ok(await f.mutation(change,1,'p2-near'));limits(f);assert.ok(f.db.metrics.maxReturnedBytes>3_500_000 && f.db.metrics.maxReturnedBytes<=4_000_000);const touched=f.db.trace.find(entry=>entry.sql.startsWith('WITH touched AS'));assert.ok(touched.returnedBytes<=touched.boundedBytes && touched.boundedBytes<=4_000_000);console.log(`P2 legal escaped near-boundary transfer ${touched.returnedBytes} bytes <= SQL bound ${touched.boundedBytes}.`);assert.deepEqual((await f.pull()).data,{...d,sessions:[{...root,title:'edited'}]});assert.deepEqual(await ok(await f.mutation(change,1,'p2-near')),result);
}
{
  const f=await fixture();const root={id:'x'.repeat(3005),title:'original',sets:{g:{k:{reps:'5'}}}};await ok(await f.push({schemaVersion:8,programs:[],sessions:[root],measurements:[]}));
  const before=f.db.rows('SELECT * FROM sync_records');f.db.setBeforeRead(sql=>{if(sql.startsWith('WITH touched AS')){f.db.setBeforeRead(null);f.db.raw.exec("UPDATE sync_account_state SET revision=2,write_token='growth-owner'");const row=f.db.rows("SELECT * FROM sync_records WHERE kind='set'")[0];const insert=f.db.raw.prepare('INSERT INTO sync_records VALUES (?,?,?,?,?,?,?,?,?,?,?)');for(let i=0;i<1000;i++)insert.run(f.id,'set',JSON.stringify([root.id,'g',`new${i}`]),row.parent_key,i,row.address_json,row.payload_json,2,2,0,null);}});
  f.db.resetMetrics();assert.deepEqual(await error(await f.mutation({upserts:{sessions:[{...root,title:'edited'}]}})),[409,'SYNC_CONFLICT']);assert.equal(f.db.metrics.payloadRows,0);assert.equal(f.db.metrics.batches,0);assert.equal(f.db.metrics.writes,0);assert.equal(f.db.rows('SELECT * FROM sync_mutation_receipts').length,0);assert.deepEqual(f.db.rows('SELECT * FROM sync_records WHERE created_revision=1'),before);
}
// Signed prefix completeness: replay/skip, account scope, tampering, expiry and pinned revision.
{
  const f=big;const first=await ok(await f.call('records')),second=await ok(await f.call(`records?cursor=${encodeURIComponent(first.continuation)}`));const c=new Collector();c.add(first);assert.throws(()=>c.add(first));const skip=new Collector();assert.throws(()=>skip.add(second));
  const tuple=decode(first.continuation),g=await fixture();await g.push(base());await zero(g,()=>g.call(`records?cursor=${encodeURIComponent(first.continuation)}`),[409,'SYNC_SNAPSHOT_CHANGED']);
  // Match revision to reach MAC check, still bound to the authenticated account.
  g.db.raw.exec('UPDATE sync_account_state SET revision=2');await zero(g,()=>g.call(`records?cursor=${encodeURIComponent(first.continuation)}`),[400,'SYNC_CURSOR_INVALID']);
  for(const [index,value] of [[4,'set'],[5,'9999999'],[6,'0'.repeat(64)],[7,999],[8,999999],[3,'live']]){const t=[...tuple];t[index]=value;const forged=`${Buffer.from(JSON.stringify(t)).toString('base64url')}.${first.continuation.split('.')[1]}`;const response=await f.call(`records?cursor=${encodeURIComponent(forged)}`);assert.ok(response.status!==200);}
  const expired=[...tuple];expired[9]=Date.now()-1;await zero(f,async()=>f.call(`records?cursor=${encodeURIComponent(await signTuple(f,expired))}`),[409,'SYNC_CURSOR_EXPIRED']);
  for(const locator of ['01','-0','1.5','9223372036854775808','-9223372036854775809','1e3']){const t=[...tuple];t[5]=locator;await zero(f,async()=>f.call(`records?cursor=${encodeURIComponent(await signTuple(f,t))}`),[400,'SYNC_CURSOR_INVALID']);}
  const t=[...tuple];t[5]='9007199254740993';await zero(f,async()=>f.call(`records?cursor=${encodeURIComponent(await signTuple(f,t))}`),[409,'SYNC_SNAPSHOT_CHANGED']);
  await f.mutation({metadata:{settings:{opaque:{keep:true},newField:'updated'}}},2);await zero(f,()=>f.call(`records?cursor=${encodeURIComponent(first.continuation)}`),[409,'SYNC_SNAPSHOT_CHANGED']);
}
// Huge legal raw ID, Unicode ordering and legal 1.8MB row envelope, bounded locator and exact reconstruction.
{
  const f=await fixture();const huge='a'.repeat(20_000)+'α';const data={schemaVersion:8,programs:[],sessions:Array.from({length:300},(_,i)=>session(i===0?huge:`z${i}`,{})),measurements:[{id:'huge-envelope',extra:'x'.repeat(1_750_000)}],settings:{}};seed(f,data);const result=await collect(f);assert.deepEqual(assembleRecordData(result.rows),data);const first=await ok(await f.call('records'));assert.ok(first.continuation.length<16_384);assert.ok(first.records.some(row=>row.kind==='measurement'));
  const pageWithHuge=await ok(await f.call(`records?cursor=${encodeURIComponent(first.continuation)}`));assert.ok([...first.records,...pageWithHuge.records].some(row=>row.record_key.includes(huge)));
  const locatorFixture=await fixture();const longKey='z'.repeat(20_000)+'α';const longData={schemaVersion:8,programs:[],sessions:[...Array.from({length:251},(_,i)=>session(`a${i}`,i===0?{g:{k:{reps:'5'}}}:{})),session(longKey)],measurements:[]};seed(locatorFixture,longData);const longFirst=await ok(await locatorFixture.call('records'));assert.equal(longFirst.records.at(-1).record_key,JSON.stringify([longKey]));assert.ok(longFirst.continuation.length<16_384);assert.deepEqual(assembleRecordData((await collect(locatorFixture)).rows),longData);
}
// Locator deletion/reassignment/relocation at unchanged revision, and resolution→page races reject/restart.
for(const mode of ['delete','relocate','reassign','race-revision','race-token','race-anchor']){
  const f=await fixture();seed(f,{schemaVersion:8,programs:[],sessions:Array.from({length:300},(_,i)=>session(`s${i}`,{})),measurements:[]});const first=await ok(await f.call('records')),tuple=decode(first.continuation);
  if(mode==='delete')f.db.raw.prepare('DELETE FROM sync_records WHERE rowid=CAST(? AS INTEGER)').run(tuple[5]);
  if(mode==='relocate')f.db.raw.prepare('UPDATE sync_records SET rowid=9007199254740993 WHERE rowid=CAST(? AS INTEGER)').run(tuple[5]);
  if(mode==='reassign')f.db.raw.prepare("UPDATE sync_records SET record_key='[\"different\"]' WHERE rowid=CAST(? AS INTEGER)").run(tuple[5]);
  if(mode.startsWith('race-'))f.db.setBeforeRead(sql=>{if(sql.startsWith('WITH candidates')){f.db.setBeforeRead(null);if(mode==='race-revision')f.db.raw.exec('UPDATE sync_account_state SET revision=2');else if(mode==='race-token')f.db.raw.exec("UPDATE sync_account_state SET write_token='other'");else f.db.raw.prepare('UPDATE sync_records SET rowid=9007199254740993 WHERE rowid=CAST(? AS INTEGER)').run(tuple[5]);}});
  assert.deepEqual(await error(await f.call(`records?cursor=${encodeURIComponent(first.continuation)}`)),[409,'SYNC_SNAPSHOT_CHANGED']);
}
// A locator outside JavaScript's safe integer range remains an exact decimal string and pages successfully.
{
  const f=await fixture();seed(f,{schemaVersion:8,programs:[],sessions:Array.from({length:300},(_,i)=>session(`s${i}`,{})),measurements:[]});const first=await ok(await f.call('records')),tuple=decode(first.continuation);f.db.raw.prepare('UPDATE sync_records SET rowid=9007199254740993 WHERE rowid=CAST(? AS INTEGER)').run(tuple[5]);const refreshed=await ok(await f.call('records'));assert.equal(decode(refreshed.continuation)[5],'9007199254740993');const next=await ok(await f.call(`records?cursor=${encodeURIComponent(refreshed.continuation)}`));const c=new Collector();c.add(refreshed);c.add(next);assert.equal(c.done,true);
}
// Initial coherent retry is bounded; persistent drift fails closed. Empty authority never reads retained legacy.
{
  const f=await fixture();await f.push(base());let times=0;f.db.setBeforeRead(sql=>{if(sql.startsWith('WITH candidates')&&times++===0)f.db.raw.exec("UPDATE sync_account_state SET revision=2,write_token='next'");});f.db.resetMetrics();assert.equal((await ok(await f.call('records'))).syncVersion,2);assert.ok(f.db.metrics.queries<=8);f.db.setBeforeRead(sql=>{if(sql.startsWith('WITH candidates'))f.db.raw.exec('UPDATE sync_account_state SET revision=revision+1');});assert.deepEqual(await error(await f.call('records')),[409,'SYNC_SNAPSHOT_CHANGED']);f.db.setBeforeRead(null);f.db.raw.exec('DELETE FROM sync_records');f.db.raw.prepare("INSERT INTO user_data VALUES (?, '{\"legacy\":true}',99,'old')").run(f.id);const empty=await ok(await f.call('records'));assert.equal(empty.total,0);assert.equal(empty.terminal,true);assert.deepEqual(empty.records,[]);
}
// Stable root ranks, distinct append ranks including tombstones; explicit create/prepend/move and child ordering.
{
  const f=await fixture();const d=base();d.sessions=[session('a'),session('b'),session('c')];await f.push(d);const old=f.db.rows("SELECT record_key,ordinal FROM sync_records WHERE kind='session'");let rev=1;
  await ok(await f.mutation({upserts:{sessions:[{...d.sessions[1],title:'edited'}]}},rev++));assert.deepEqual(f.db.rows("SELECT record_key,ordinal FROM sync_records WHERE kind='session'"),old);
  await ok(await f.mutation({deletes:{sessions:['c']}},rev++));const added=await ok(await f.mutation({upserts:{sessions:[session('d'),session('e')]}},rev++));assert.deepEqual(added.ordinals.map(r=>r.ordinal),[3,4]);
  f.db.resetMetrics();const placed=await ok(await f.mutation({upserts:{sessions:[session('new',{g:{second:{reps:'2'},first:{reps:'1'}}})]},order:[{kind:'session',key:'new',anchor:'a',placement:'before'},{kind:'session',key:'e',anchor:'b',placement:'after'}]},rev++));limits(f);assert.ok(f.db.metrics.orderOnlyRows>0);assert.equal(placed.ordinals.find(r=>r.key==='["new"]').ordinal,0);assert.deepEqual((await f.pull()).data.sessions.map(s=>s.id),['new','a','b','e','d']);assert.deepEqual(Object.keys((await f.pull()).data.sessions[0].sets.g),['second','first']);
  for(const order of [[{kind:'session',key:'a',anchor:'a',placement:'before'}],[{kind:'session',key:'a',anchor:'missing',placement:'before'}],[{kind:'session',key:'a',anchor:'c',placement:'before'}],[{kind:'program',key:'a',anchor:'p',placement:'before'}],[{kind:'session',key:'a',anchor:'b',placement:'before'},{kind:'session',key:'b',anchor:'a',placement:'before'}]])await zero(f,()=>f.mutation({order},rev),[400,'SYNC_ORDER_INVALID']);
  await zero(f,()=>f.mutation({order:Array.from({length:9},()=>({kind:'session',key:'a',anchor:'b',placement:'before'}))},rev),[413,'SYNC_ORDER_LIMIT']);
  f.db.raw.prepare("UPDATE sync_records SET ordinal=? WHERE kind='session' AND record_key='[\"c\"]'").run(Number.MAX_SAFE_INTEGER);await zero(f,()=>f.mutation({upserts:{sessions:[session('overflow')]}},rev),[413,'SYNC_ORDER_LIMIT']);
}
// Empty collection create needs no anchor; declared command sequence accepts valid multiple placements.
{
  const f=await fixture();await f.push({schemaVersion:8,programs:[],sessions:[],measurements:[]});await ok(await f.mutation({upserts:{sessions:[session('a'),session('b'),session('c')]},order:[{kind:'session',key:'c',anchor:'a',placement:'before'},{kind:'session',key:'b',anchor:'a',placement:'after'}]}));assert.deepEqual((await f.pull()).data.sessions.map(s=>s.id),['c','a','b']);
}
// Omitted roots/opaque fields, unknown-loss guards, explicit deletes/tombstones, program links/raw prescriptions.
{
  const f=await fixture();const d=base();d.sessions[0].sets.g.k.privateFuture={keep:true};d.programs[0].days=[{id:'day',programId:'p',sections:[{id:'section',workoutDayId:'day',items:[{id:'exercise',sectionId:'section',individualSets:[{repsText:'5'}]}]}]}];await f.push(d);
  await zero(f,()=>f.mutation({upserts:{sessions:[session('s',{g:{k:{exerciseId:'x',setNumber:3,completed:false,id:'optional'}}})]}}),[409,'SYNC_SCHEMA_LOSS_RISK']);await zero(f,()=>f.mutation({deletes:{sessions:['s']}}),[409,'SYNC_SCHEMA_LOSS_RISK']);await zero(f,()=>f.mutation({metadata:{settings:{rest:95}}}),[409,'SYNC_SCHEMA_LOSS_RISK']);
  const changed=structuredClone(d.programs[0]);changed.name='new';await ok(await f.mutation({upserts:{programs:[changed]}}));assert.deepEqual((await f.pull()).data,{...d,programs:[changed]});
  await ok(await f.mutation({deletes:{measurements:['m']}},2));await zero(f,()=>f.mutation({upserts:{measurements:[d.measurements[0]]}},3),[409,'SYNC_RECORD_DELETED']);
  await zero(f,()=>f.mutation({metadata:{schemaVersion:8}},3),[400,'SYNC_MUTATION_INVALID']);await zero(f,()=>f.mutation({upserts:{sets:[]}},3),[400,'SYNC_MUTATION_INVALID']);
  const link=structuredClone(changed);link.days[0].programId='wrong';await zero(f,()=>f.mutation({upserts:{programs:[link]}},3),[400,'SYNC_RECORD_LINK_INVALID']);
}
// Composite workout finish + covered draft clear + Watch metadata, all in one owned batch.
{
  const f=await fixture();const draft={id:'workout',dayName:'today',exercises:[],sets:{g:{k:{exerciseId:'e',completed:true,reps:'5'}}},restTimer:null};const d={schemaVersion:8,programs:[],sessions:[],measurements:[],draft,watchSync:{cursors:{watch:1},ledger:[],closedWorkoutIds:[]}};await f.push(d);const watch={cursors:{watch:2},ledger:[],closedWorkoutIds:['workout']};f.db.resetMetrics();await ok(await f.mutation({upserts:{sessions:[session('finished',draft.sets)]},metadata:{draft:null,watchSync:watch}}));assert.equal(f.db.metrics.batches,1);assert.deepEqual((await f.pull()).data,{...d,sessions:[session('finished',draft.sets)],draft:null,watchSync:watch});
}
// PWA accepted producer failed→pending errorCode:null→fresh ready preserves unrelated account exactly.
{
  const f=await fixture();const ready=()=>({schemaVersion:'1.1',importId:'imp',importedAt:'now',source:{fileName:'own.pdf',fileType:'pdf'},program:{name:'raw',days:[]}}),pending={...ready(),parserStatus:'pending',errorCode:null};const d={schemaVersion:5,programs:[{id:'p',schemaVersion:'1.0',days:[]}],sessions:[{id:'pwa',sets:[{id:'raw',sessionId:'pwa',exerciseId:'x',setNumber:1}]}],importPreviews:{imp:pending},other:{keep:true}};await f.push(d);await ok(await f.mutation({clientSchemaVersion:5,metadata:{importPreviews:{imp:ready()}}}));assert.deepEqual((await f.pull()).data,{...d,importPreviews:{imp:ready()}});
}
// Mutation receipts: loss/retry retains original outcome after later writer; changed content conflicts, TTL stale.
{
  const f=await fixture();await f.push(base());const change={metadata:{settings:{rest:100,opaque:{a:null}}}};const first=await ok(await f.mutation(change,1,'response-loss'));const before=f.dump();f.db.resetMetrics();assert.deepEqual(await ok(await f.mutation(change,1,'response-loss')),first);assert.equal(f.dump(),before);assert.equal(f.db.metrics.writes,0);limits(f);await zero(f,()=>f.mutation({metadata:{settings:{rest:101,opaque:{a:null}}}},1,'response-loss'),[409,'SYNC_MUTATION_ID_CONFLICT']);await ok(await f.mutation({metadata:{draft:null}},2));assert.deepEqual(await ok(await f.mutation(change,1,'response-loss')),first);
  f.db.raw.exec("UPDATE sync_mutation_receipts SET expires_at='2000-01-01'");await zero(f,()=>f.mutation(change,1,'response-loss'),[409,'SYNC_CONFLICT']);
  const stored=f.db.rows('SELECT * FROM sync_mutation_receipts WHERE mutation_id=?','response-loss')[0];assert.equal(stored.request_hash.length,64);assert.equal(stored.plan_hash.length,64);assert.ok(!stored.outcome_json.includes('opaque'));
}
// Delta/delta and delta/snapshot races: one revision owner; losers cannot alter records/ranks/receipts.
for(const snapshot of [false,true]){
  const f=await fixture();const d=base();await f.push(d);let count=0,release;const barrier=new Promise(r=>release=r);f.db.setBeforeBatch(async()=>{if(++count===2)release();await barrier;});const delta=f.mutation({upserts:{sessions:[session('new')]},metadata:{settings:{rest:101,opaque:{a:null}}},order:[{kind:'session',key:'new',anchor:'s',placement:'before'}]},1,'race');const other=snapshot?f.push({...d,settings:{rest:202,opaque:{a:null}}},1):f.mutation({metadata:{settings:{rest:202,opaque:{a:null}}}},1,'race-other');const results=await Promise.all([delta,other]);f.db.setBeforeBatch(null);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const current=(await f.pull()).data;assert.equal(current.settings.rest,results[0].status===200?101:202);assert.equal(current.sessions.length,results[0].status===200?2:1);assert.equal(f.db.rows("SELECT * FROM sync_mutation_receipts WHERE mutation_id='race'").length,results[0].status===200?1:0);assert.equal(f.db.rows('SELECT revision FROM sync_account_state')[0].revision,2);
}
// Concurrent retransmissions both get the original receipt; same ID/different body gets a content conflict.
for(const changed of [false,true]){
  const f=await fixture();await f.push(base());let count=0,release;const barrier=new Promise(r=>release=r);f.db.setBeforeBatch(async()=>{if(++count===2)release();await barrier;});f.db.resetMetrics();const change={metadata:{draft:null}};const replies=await Promise.all([f.mutation(change,1,'same-concurrent'),f.mutation(changed?{metadata:{settings:{rest:100,opaque:{a:null}}}}:change,1,'same-concurrent')]);f.db.setBeforeBatch(null);
  if(changed){assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal((await replies.find(r=>r.status===409).json()).code,'SYNC_MUTATION_ID_CONFLICT');}else{assert.deepEqual(replies.map(r=>r.status),[200,200]);assert.deepEqual(await replies[0].json(),await replies[1].json());}
  assert.equal(f.db.rows('SELECT revision FROM sync_account_state')[0].revision,2);assert.equal(f.db.rows('SELECT * FROM sync_mutation_receipts').length,1);assert.ok(f.db.metrics.queries<=60);
}
// Deletion/blocked/anchor race after preplan: SQL ownership gate produces zero side effects for loser.
for(const mode of ['blocked','deleted','changed-anchor']){
  const f=await fixture();await f.push(base());const records=f.db.rows('SELECT * FROM sync_records');f.db.setBeforeBatch(()=>{if(mode==='blocked')f.db.raw.exec("UPDATE sync_account_state SET write_status='BLOCKED'");if(mode==='deleted')f.db.raw.exec("UPDATE users SET deleted_at='now'");if(mode==='changed-anchor')f.db.raw.exec("UPDATE sync_account_state SET revision=2,write_token='other'");});assert.deepEqual(await error(await f.mutation({upserts:{sessions:[session('new')]},order:[{kind:'session',key:'new',anchor:'s',placement:'before'}]})),[409,'SYNC_CONFLICT']);assert.deepEqual(f.db.rows('SELECT * FROM sync_records'),records);assert.equal(f.db.rows('SELECT * FROM sync_mutation_receipts').length,0);
}
// SQL failure at chunks, order or receipt rolls all state/records/ranks/receipt back.
for(const pattern of [/^INSERT INTO sync_records/,/^WITH ordered AS/,/^INSERT INTO sync_mutation_receipts/]){
  const f=await fixture();await f.push(base());const before=f.dump();f.db.setFailOn(pattern);assert.deepEqual(await error(await f.mutation({upserts:{sessions:[session('new')]},order:[{kind:'session',key:'new',anchor:'s',placement:'before'}]})),[503,'SYNC_STORAGE_UNAVAILABLE']);assert.equal(f.dump(),before);
}
{
  const f=await fixture();await f.push({schemaVersion:8,programs:[],sessions:[],measurements:[]});f.db.raw.exec("CREATE TRIGGER fail_later BEFORE INSERT ON sync_records WHEN NEW.kind='program' AND NEW.record_key='[\"second\"]' BEGIN SELECT RAISE(ABORT,'injected'); END");const before=f.dump();assert.deepEqual(await error(await f.mutation({upserts:{programs:[{id:'first',notes:'x'.repeat(1_500_000),days:[]},{id:'second',notes:'y'.repeat(1_500_000),days:[]}]}})),[503,'SYNC_STORAGE_UNAVAILABLE']);assert.equal(f.dump(),before);assert.ok(f.db.metrics.maxBoundBytes<=LIMITS.chunkBytes);
}
// Bounds fail before writes. Requests, payload rows, order commands and per-invocation count are independent.
{
  const f=await fixture();await f.push(base());await zero(f,()=>f.mutation({upserts:{sessions:Array.from({length:129},(_,i)=>session(`s${i}`))}}),[413,'SYNC_STRUCTURE_LIMIT']);await zero(f,()=>f.mutation({upserts:{programs:[{id:'huge',notes:'x'.repeat(1_900_000)}]}}),[413,'SYNC_RECORD_TOO_LARGE']);await zero(f,()=>f.mutation({metadata:{huge:'x'.repeat(4_200_000)}}),[413,'SYNC_PAYLOAD_INVALID']);
}
// Derived bounds: repeated long IDs can expand selectors/receipts beyond the budget within a legal request.
{
  const f=await fixture();await f.push({schemaVersion:8,programs:[],sessions:[],measurements:[]});
  const slash='\\'.repeat(100_000);const upserts={programs:Array.from({length:3},(_,i)=>({id:`p${i}${slash}`,days:[]}))};assert.ok(Buffer.byteLength(JSON.stringify(upserts))<4_000_000);await zero(f,()=>f.mutation({upserts}),[413,'SYNC_ROOT_LIMIT']);assert.equal(f.db.metrics.batches,0);
  const near='α"\\'.repeat(33_000);const valid={upserts:{programs:[{id:`p0${near}`,days:[]},{id:`p1${near}`,days:[]},{id:`p2${near}`,days:[]}]}};f.db.resetMetrics();const first=await ok(await f.mutation(valid,1,'near-boundary'));limits(f);for(const ord of first.ordinals)assert.equal(ord.key,JSON.stringify([JSON.parse(ord.key)[0]]));assert.deepEqual(await ok(await f.mutation(valid,1,'near-boundary')),first);const stored=f.db.rows('SELECT * FROM sync_mutation_receipts WHERE mutation_id=?','near-boundary')[0];const rowBytes=Buffer.byteLength(JSON.stringify(stored))+256;assert.ok(rowBytes>1_750_000&&rowBytes<=LIMITS.rowBytes);console.log(`Near-boundary receipt row: ${rowBytes} UTF-8 bytes including256-byte overhead.`);
}
{
  const f=await fixture();const long='a'.repeat(350_000);const d={schemaVersion:8,programs:[],sessions:Array.from({length:6},(_,i)=>session(`${i}${long}`)),measurements:[]};seed(f,d);const order=Array.from({length:4},(_,i)=>({kind:'session',key:d.sessions[i].id,anchor:d.sessions[5].id,placement:'before'}));assert.ok(Buffer.byteLength(JSON.stringify({order}))<4_000_000);await zero(f,()=>f.mutation({order}),[413,'SYNC_ORDER_LIMIT']);assert.equal(f.db.metrics.batches,0);
}
// Receipt-row escaping expands after bounded root/order selectors; exact preflight rejects before CAS.
{
  const f=await fixture();const long='\\'.repeat(220_000);const d={schemaVersion:8,programs:[],sessions:[{...session(`a${long}`),title:'a'},{...session(`b${long}`),title:'b'},session('anchor')],measurements:[]};seed(f,d);const order=[{kind:'session',key:d.sessions[0].id,anchor:'anchor',placement:'before'},{kind:'session',key:d.sessions[1].id,anchor:'anchor',placement:'before'}];await zero(f,()=>f.mutation({order}),[413,'SYNC_ROOT_LIMIT']);assert.equal(f.db.metrics.batches,0);assert.ok(f.db.trace.some(entry=>entry.sql.startsWith('WITH o0 AS')),'receipt projection was bounded and validated before CAS');
}
// Schema5 account guard remains pure-PWA, including incompatible untouched roots; metadata is not a bypass.
for(const incompatible of ['object-session','program','schema8']){
  const f=await fixture();const d={schemaVersion:incompatible==='schema8'?8:5,programs:[{id:'p',schemaVersion:incompatible==='program'?'future':'1.0'}],sessions:[{id:'s',sets:incompatible==='object-session'?{}:[]}],settings:{rest:90}};await f.push(d);await zero(f,()=>f.mutation({clientSchemaVersion:5,metadata:{settings:{rest:100}}}),[409,'SYNC_CLIENT_UPGRADE_REQUIRED']);assert.equal(f.db.metrics.payloadRows,2,'only selected settings+schema payload rows');
}
// Strict optional envelope types: absence is distinct from explicit malformed values.
{
  const f=await fixture();await f.push(base());
  for(const value of [false,0,'',null,[],true,'value'])await zero(f,()=>f.mutation({metadata:value}),[400,'SYNC_MUTATION_INVALID']);
  for(const value of [false,0,'',null,{},true,'value'])await zero(f,()=>f.mutation({order:value}),[400,'SYNC_ORDER_INVALID']);
  await ok(await f.mutation({}));await ok(await f.mutation({metadata:{},order:[]},2));
}
// Paging carries durable tombstones as part of the revision-bound total.
{
  const f=await fixture();await f.push(base());await f.mutation({deletes:{measurements:['m']}});const page=await ok(await f.call('records'));assert.ok(page.records.some(r=>r.kind==='measurement'&&r.tombstone===1));assert.equal(page.total,f.db.rows('SELECT count(*) AS n FROM sync_records')[0].n);assert.equal(page.cumulative,page.total);
}
// Sequential moves may move an earlier anchor later; commands are not simultaneous final constraints.
{
  const f=await fixture();await f.push({schemaVersion:8,sessions:[session('c'),session('a'),session('b')],programs:[],measurements:[]});const r=await ok(await f.mutation({order:[{kind:'session',key:'a',anchor:'b',placement:'before'},{kind:'session',key:'b',anchor:'c',placement:'before'}]}));assert.deepEqual((await f.pull()).data.sessions.map(s=>s.id),['b','c','a']);for(const ord of r.ordinals)assert.equal(ord.ordinal,f.db.rows('SELECT ordinal FROM sync_records WHERE kind=? AND record_key=?',ord.kind,ord.key)[0].ordinal);
}
// Full eight-command plan stays within invocation/bind limits and receipt ordinals are exact.
{
  const f=await fixture();await f.push({schemaVersion:8,sessions:Array.from({length:10},(_,i)=>session(`s${i}`)),programs:[],measurements:[]});f.db.resetMetrics();const r=await ok(await f.mutation({order:Array.from({length:8},(_,i)=>({kind:'session',key:`s${i+1}`,anchor:'s0',placement:'before'}))}));limits(f);assert.equal(r.counts.orderCommands,8);for(const ord of r.ordinals)assert.equal(ord.ordinal,f.db.rows('SELECT ordinal FROM sync_records WHERE kind=? AND record_key=?',ord.kind,ord.key)[0].ordinal);
}
// Scheduled cleanup bounded to256, account-scoped receipts; migration missing/unsupported do nothing.
for(const foreignKeys of [true,false]){
  const f=await fixture({foreignKeys});await f.push(base());await f.mutation({metadata:{draft:null}},1,'keep');const insert=f.db.raw.prepare("INSERT INTO sync_mutation_receipts VALUES (?,?,'h','p',1,2,'{}','old','2000-01-01')");for(let i=0;i<300;i++)insert.run(f.id,`expired-${i}`);f.db.resetMetrics();await cleanupMutationReceipts(f.env);assert.equal(f.db.metrics.queries,2);assert.equal(f.db.rows('SELECT * FROM sync_mutation_receipts').length,45);assert.equal(f.db.rows("SELECT * FROM sync_mutation_receipts WHERE mutation_id='keep'").length,1);
  let scheduled;worker.scheduled({},f.env,{waitUntil(promise){scheduled=promise;}});await scheduled;assert.equal(f.db.rows('SELECT * FROM sync_mutation_receipts').length,1);
}
{
  const f=await fixture({migrationsUpTo:'0008_record_sync_storage.sql'});f.db.resetMetrics();await cleanupMutationReceipts(f.env);assert.equal(f.db.metrics.queries,1);assert.equal(f.db.metrics.writes,0);
}
// Five critical semantic mutants fail observable invariants using the same SQLite rather than source assertions.
let killed=0;const source=readFileSync(new URL('../worker/record-sync-transport.js',import.meta.url),'utf8').replace("'./record-sync-storage.js'",JSON.stringify(new URL('../worker/record-sync-storage.js',import.meta.url).href));
async function mutant(from,to){assert.ok(source.includes(from));return import(`data:text/javascript;base64,${Buffer.from(source.replace(from,to)).toString('base64')}`);}
const direct=(m,f,change={},rev=1)=>m.recordMutation(new Request(`${ORIGIN}/api/sync/records/mutations`,{method:'POST',body:JSON.stringify({mutationId:'mutant',baseRevision:rev,clientSchemaVersion:8,...change})}),f.env,f.id);
{
  const m=await mutant('AND revision=? AND write_token=? AND storage_schema_version', 'AND ? >= 0 AND ? IS NOT NULL AND storage_schema_version');const f=await fixture();await f.push(base());f.db.setBeforeBatch(()=>f.db.raw.exec("UPDATE sync_account_state SET revision=2,write_token='race'"));assert.equal((await direct(m,f,{metadata:{draft:null}})).status,200,'mutated stale CAS accepted');killed++;
}
{
  const m=await mutant("if (before?.tombstone) fail('SYNC_RECORD_DELETED');",'if (false) fail(\'SYNC_RECORD_DELETED\');');const f=await fixture();await f.push(base());await f.mutation({deletes:{measurements:['m']}});assert.equal((await direct(m,f,{upserts:{measurements:[{id:'m',weightKg:71}]}},2)).status,200,'mutant falsely confirms tombstone resurrection');killed++;
}
{
  const m=await mutant('if (before) item.ordinal=before.ordinal;', 'if (before) item.ordinal=0;');const f=await fixture();const d=base();d.sessions=[session('a'),session('b')];await f.push(d);await direct(m,f,{upserts:{sessions:[{...d.sessions[1],title:'changed'}]}});assert.equal(f.db.rows("SELECT ordinal FROM sync_records WHERE kind='session' AND record_key='[\"b\"]'")[0].ordinal,0,'mutant silently resets global root ordinal');killed++;
}
{
  const m=await mutant("if (receipt.request_hash !== requestHash) fail('SYNC_MUTATION_ID_CONFLICT');",'if (false) fail(\'SYNC_MUTATION_ID_CONFLICT\');');const f=await fixture();await f.push(base());await direct(m,f,{metadata:{draft:null}});assert.equal((await direct(m,f,{metadata:{draft:{id:'different'}}})).status,200,'mutant accepts same mutation ID with changed content');killed++;
}
{
  const m=await mutant("if (!(await crypto.subtle.verify('HMAC',await macKey(state),unb64(parts[1]),cursorInput(userId,canonical)))) fail('SYNC_CURSOR_INVALID',400);",'if (false) fail(\'SYNC_CURSOR_INVALID\',400);');const first=await ok(await big.call('records'));const forged=`${first.continuation.split('.')[0]}.${Buffer.alloc(32).toString('base64url')}`;assert.equal((await m.recordPage(new Request(`${ORIGIN}/api/sync/records?cursor=${encodeURIComponent(forged)}`),big.env,big.id)).status,200,'mutant accepts forged cursor MAC');killed++;
}
assert.equal(killed,5);
console.log('Record transport PASS: coherent bounded raw pages/signed prefix+locator, >60k exact reconstruction/touched delta, relative/global/child order, CAS writer/deletion races, receipts/retry/TTL, SQL rollback, opaque/tombstone/composite/PWA, schema/auth/account/cleanup/budget safety; five critical mutants killed.');
