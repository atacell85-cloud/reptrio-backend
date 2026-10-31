// B52-002 S3 (Guardian): the staged SYNC publication path also refuses an invalid first-time card list (duplicate ids) instead of storing it.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createD1} from './lib/d1-sqlite.mjs';import worker from '../worker/index.js';import {storageJSON} from '../worker/record-sync-storage.js';
const DB=createD1(),id='u1',token='t1';DB.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at)VALUES(?,?,'h','s','now')").run(id,'u@x.test');DB.raw.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at)VALUES(?,?,?,'now','2099-01-01')").run('a1',id,createHash('sha256').update(token).digest('base64url'));
const env={DB};
const call=async(action,p,op)=>{const r=await worker.fetch(new Request(`https://example.test/api/sync/records/operations${op?`/${op}/${action}`:''}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Reptrio-Data-Level':'2'},body:storageJSON(p)}),env,{waitUntil(){}});return {status:r.status,body:await r.json()};};
const push=async(data,sv)=>{const r=await worker.fetch(new Request('https://example.test/api/sync/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Reptrio-Data-Level':'2'},body:JSON.stringify({data,syncVersion:sv})}),env,{waitUntil(){}});return r.status;};
assert.equal(await push({schemaVersion:8,programs:[],sessions:[],measurements:[],settings:{weightUnit:'kg'}},0),200);
const zero={sessions:0,sets:0,programs:0,days:0,sections:0,exercises:0,measurements:0,gyms:0,importHistory:0};
const base=[{kind:'metadata',field:'schemaVersion',record:8},{kind:'metadata',field:'programs',record:[]},{kind:'metadata',field:'sessions',record:[]},{kind:'metadata',field:'measurements',record:[]},{kind:'metadata',field:'settings',record:{weightUnit:'kg'}}];
const s=await call('start',{sourceNamespace:'src',archiveRetryHash:'a'.repeat(64),localBinding:'l',dataSchemaVersion:8,expectedChunks:1,expectedCounts:zero,baseRevision:1});assert.equal(s.status,200);
const chunk=await call('chunks',{localBinding:'l',index:0,roots:[...base,{kind:'metadata',field:'personalExercises',record:[{id:'custom:card:x'},{id:'custom:card:x'}]}]},s.body.operationId);
assert.equal(chunk.status,400,'a duplicate-id card list is refused on the staged sync path');
assert.equal(DB.rows("SELECT payload_json FROM sync_records WHERE record_key='[\"personalExercises\"]'").length,0,'nothing stored');
console.log('Staged sync path: invalid first-time card list refused.');
