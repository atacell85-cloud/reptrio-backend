import {storageTables,recordSchemaStatus,personalRestoreSchemaStatus,readRecordState,splitData,storageJSON,assembleRecordData,compatible,compatibleStorageRow,recordChunks,inspect,RECORD_WRITE_GATE_SQL} from './record-sync-storage.js';
import {portableBody,portableHash,byteHash,WIRE_RULES,canonicalPortable,portableBytes,portableFail as fail,object,own,exactFields,validatePortableRoot,parsePortable} from './personal-backup-contract.js';
export const RESTORE_LIMITS=Object.freeze({ttl:3_600_000,pageRows:256,pageBytes:1_800_000,pages:8,queries:50,roots:128,chunks:10000});
const json=(body,status=200)=>new Response(storageJSON(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const reject=e=>json({code:typeof e.code==='string'&&(e.code.startsWith('RESTORE_')||e.code.startsWith('SYNC_'))?e.code:'RESTORE_UNAVAILABLE'},e.status||503);
const int=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER;
const key=v=>storageJSON([v]);
const zero=()=>({sessions:0,sets:0,programs:0,days:0,sections:0,exercises:0,measurements:0,gyms:0,importHistory:0});
const sum=(a,b)=>{for(const k of Object.keys(a))a[k]+=b[k]||0;return a;};
const countKeys=Object.keys(zero());
const now=()=>new Date().toISOString();
const statementGate=`EXISTS(SELECT 1 FROM personal_restore_operations o JOIN users u ON u.id=o.user_id LEFT JOIN sync_account_state active ON active.user_id=u.id WHERE o.user_id=? AND o.operation_id=? AND o.generation_version=? AND o.state=? AND o.expires_at>? AND u.deleted_at IS NULL AND(active.write_status IS NULL OR active.write_status='ACTIVE'))`;
function boundedDB(db){let queries=1;const check=(sql,values)=>{if(++queries>50||portableBytes(sql)>100000||values.length>100||values.some(v=>typeof v==='string'&&portableBytes(v)>1800000))fail('LIMIT',413);};return {prepare(sql){return {bind(...values){check(sql,values);return db.prepare(sql).bind(...values);},first(){check(sql,[]);return db.prepare(sql).first();},all(){check(sql,[]);return db.prepare(sql).all();}};},batch:values=>db.batch(values)};}
async function ready(env,db){if(env.PERSONAL_RESTORE_ENABLED==='false')fail('DISABLED',503);const tables=await storageTables(db);if(recordSchemaStatus(tables)!=='ready'||personalRestoreSchemaStatus(tables)!=='ready')fail('MIGRATION_REQUIRED',503);}
async function operation(db,userId,id,purpose){const row=await db.prepare('SELECT * FROM personal_restore_operations WHERE user_id=? AND operation_id=? AND purpose=?').bind(userId,id,purpose).first();if(!row)fail('OPERATION_NOT_FOUND',404);return row;}
function live(op){if(op.expires_at<=now())fail('EXPIRED');}
function binding(op,p){if(p.localBinding!==op.local_binding)fail('LOCAL_BINDING_CHANGED');}
function counts(value){exactFields(value,countKeys);if(countKeys.some(k=>!int(value[k])))fail('COUNT_INVALID');return value;}
function progressReply(op,progress,status='PENDING'){return {operationId:op.operation_id,status,generationId:op.generation_id,progress:{phase:progress.phase,processed:progress.processed,counts:progress.counts},continuation:status==='PENDING'?op.generation_id:null};}
export async function personalRestoreRequest(request,env,userId,purpose,id,action='start'){
 try{
  const db=boundedDB(env.DB);await ready(env,db);const state=await readRecordState(db,userId);
  if(action==='receipt'){const op=await operation(db,userId,id,purpose);if(!op.outcome_json)fail('RECEIPT_NOT_READY');return json(JSON.parse(op.outcome_json));}
  const p=await portableBody(request);
  if(action==='start')return json(await start(db,userId,purpose,state,p));
  const op=await operation(db,userId,id,purpose);
  if(action==='cancel')return json(await cancel(db,userId,op));
  if(op.state==='COMMITTED'&&action==='commit'){binding(op,p);exactFields(p,purpose==='RESTORE'?['localBinding','confirm','previewDigest','semanticDigest','selectionDigest','baseRevision']:['localBinding','confirm','confirmationDigest','semanticDigest','baseRevision']);if((purpose==='RESTORE'?p.previewDigest:p.confirmationDigest)!==op.preview_hash||p.semanticDigest!==op.semantic_hash||p.confirm!==true||p.baseRevision!==JSON.parse(op.outcome_json).baseRevision||purpose==='RESTORE'&&p.selectionDigest!==op.selection_hash)fail('CONFIRMATION_INVALID');return json(JSON.parse(op.outcome_json));}
  if(op.state==='UNDONE'&&action==='undo'){binding(op,p);exactFields(p,['localBinding','confirm','undoDigest','baseRevision']);if(p.undoDigest!==op.confirm_hash||p.confirm!==true||p.baseRevision!==JSON.parse(op.outcome_json).undoRevision-1)fail('CONFIRMATION_INVALID');return json(JSON.parse(op.outcome_json));}
  if(!['COMMITTED','UNDO_PREVIEWING','UNDO_READY','UNDONE'].includes(op.state))live(op);binding(op,p);
  if(action==='chunks')return json(await chunk(db,userId,op,p));
  if(action==='finalize')return json(await finalize(db,userId,op,state,p));
  if(action==='preview'&&purpose==='RESTORE')return json(await preview(db,userId,op,state,p));
  if(action==='commit')return json(await commit(db,userId,op,state,p));
  if(action==='undo-preview'&&purpose==='RESTORE')return json(await undoPreview(db,userId,op,state,p));
  if(action==='undo'&&purpose==='RESTORE')return json(await undo(db,userId,op,state,p));
  fail('ROUTE_INVALID',404);
 }catch(e){return reject(e);}
}
async function start(db,userId,purpose,state,p){
 exactFields(p,['sourceNamespace','archiveRetryHash','localBinding','dataSchemaVersion','expectedChunks','expectedCounts','baseRevision']);
 if(typeof p.sourceNamespace==='string'&&new TextDecoder().decode(new TextEncoder().encode(p.sourceNamespace))!==p.sourceNamespace||typeof p.localBinding==='string'&&new TextDecoder().decode(new TextEncoder().encode(p.localBinding))!==p.localBinding)fail('START_INVALID');
 if(purpose==='SYNC'&&![5,8,9].includes(p.dataSchemaVersion))fail('SYNC_SCHEMA_INVALID');
 if(typeof p.sourceNamespace!=='string'||!p.sourceNamespace.length||p.sourceNamespace.length>128||typeof p.archiveRetryHash!=='string'||!/^[a-f0-9]{64}$/.test(p.archiveRetryHash)||typeof p.localBinding!=='string'||!p.localBinding.length||p.localBinding.length>256||!int(p.dataSchemaVersion)||!int(p.expectedChunks)||p.expectedChunks<1||p.expectedChunks>RESTORE_LIMITS.chunks||!int(p.baseRevision))fail('START_INVALID');counts(p.expectedCounts);
 if(p.baseRevision!==state.sync_version)fail('REVISION_CHANGED');
 if(purpose==='SYNC'){
  const source=await db.prepare(`SELECT COALESCE((SELECT json_extract(payload_json,'$') FROM sync_records WHERE user_id=? AND kind='metadata' AND record_key='["schemaVersion"]' AND tombstone=0),(SELECT json_extract(payload_json,'$.schemaVersion')FROM user_data WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM sync_account_state WHERE user_id=?)))AS schema_value`).bind(userId,userId,userId).first();
  if(source.schema_value!==null&&(![5,8,9].includes(source.schema_value)||source.schema_value===9&&p.dataSchemaVersion!==9))fail('SYNC_CLIENT_UPGRADE_REQUIRED');
 }

 const id=crypto.randomUUID(),created=now(),expiry=new Date(Date.now()+RESTORE_LIMITS.ttl).toISOString();
 await db.prepare(`INSERT INTO personal_restore_operations(user_id,operation_id,purpose,source_namespace,archive_retry_hash,local_binding,data_schema_version,expected_chunks,expected_counts_json,base_revision,state,expires_at,created_at,updated_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,'UPLOADING',?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)`).bind(userId,id,purpose,p.sourceNamespace,p.archiveRetryHash,p.localBinding,p.dataSchemaVersion,p.expectedChunks,storageJSON(p.expectedCounts),p.baseRevision,expiry,created,created,userId).run();
 return {operationId:id,purpose,protocol:1,status:'UPLOADING',expiresAt:expiry,limits:RESTORE_LIMITS};
}
function metadataItems(v){const out=[];for(const [field,value]of Object.entries(v)){if(field==='heroPreference')continue;if(field==='profile'){for(const [leaf,val]of Object.entries(value))out.push({path:['profile',leaf],value:val});}else if(field==='gyms'){for(const gym of value)out.push({path:['gyms',gym.id],value:gym});}else if(field==='legacyWeightUnit'||field==='legacyWeightUnitCapturedAt'){if(field==='legacyWeightUnit')out.push({path:['legacyUnitContext'],value:{legacyWeightUnit:v.legacyWeightUnit,legacyWeightUnitCapturedAt:v.legacyWeightUnitCapturedAt}});}else out.push({path:[field],value});}return out;}
async function derive(root){
 const count=zero(),records=[],v=root.record;let source;
 if(root.kind==='settings'){source=key('settings');count.gyms=(v.gyms||[]).length;for(const item of metadataItems(v))records.push({kind:'metadataPath',record_key:key('settings'),parent_key:null,ordinal:0,address_json:storageJSON(item.path),payload_json:storageJSON(item.value),source_tuple:storageJSON(['settings',...item.path]),publish_kind:null});}
 else if(root.kind==='importHistory'){source=key(v.importId);count.importHistory=1;records.push({kind:'metadataPath',record_key:key('importHistory'),parent_key:null,ordinal:0,address_json:storageJSON([v.importId]),payload_json:storageJSON(v),source_tuple:storageJSON(['importHistory',v.importId]),publish_kind:null});}
 else if(root.kind==='metadata'){source=key(root.field);records.push({...splitData({[root.field]:v})[0],source_tuple:key(root.field),publish_kind:'metadata'});}
 else{source=key(v.id);const field={session:'sessions',program:'programs',measurement:'measurements'}[root.kind];count[field]=1;
  const rows=splitData({[field]:[v]}).filter(r=>r.kind!=='metadata');for(const r of rows)records.push({...r,source_tuple:r.record_key,publish_kind:r.kind});
  if(root.kind==='session')count.sets=records.filter(r=>r.kind==='set').length;
  if(root.kind==='program')for(const d of v.days||[]){count.days++;if(own(root,'setOrder')||root.kind==='program'&&root.record.schemaVersion==='1.0')records.push(virtual('day',v.id,d.id,['days',d.id],d));for(const s of d.sections||[]){count.sections++;records.push(virtual('section',v.id,s.id,['days',d.id,'sections',s.id],s));for(const e of s.items||[]){count.exercises++;records.push(virtual('exercise',v.id,e.id,['days',d.id,'sections',s.id,'items',e.id],e));}}}
 }
 for(const r of records){r.portable_hash=await portableHash(JSON.parse(r.payload_json));r.address_hash=await portableHash(JSON.parse(r.address_json));r.container_json='{}';if(portableBytes(storageJSON(r))+256>1800000)fail('ROOT_TOO_LARGE',413);}
 return {source,count,records,hash:await portableHash(root.kind==='session'&&own(root,'setOrder')?{record:v,setOrder:root.setOrder}:v)};
}
function virtual(kind,program,id,path,value){return {kind,record_key:key(program),parent_key:null,ordinal:0,address_json:storageJSON(path),payload_json:storageJSON(value),source_tuple:storageJSON([program,id]),publish_kind:null};}
async function chunk(db,userId,op,p){
 exactFields(p,['localBinding','index','roots']);if(!int(p.index)||p.index>=op.expected_chunks||!Array.isArray(p.roots)||!p.roots.length||p.roots.length>128)fail('CHUNK_INVALID');
 const hash=await portableHash(p),existing=await db.prepare('SELECT chunk_hash,roots,records,counts_json,byte_count FROM personal_restore_chunks WHERE user_id=? AND operation_id=? AND chunk_index=?').bind(userId,op.operation_id,p.index).first();
 if(existing){if(existing.chunk_hash!==hash)fail('CHUNK_CONFLICT');return {index:p.index,hash,counts:JSON.parse(existing.counts_json),roots:existing.roots,records:existing.records};}
 if(op.state!=='UPLOADING')fail('STAGE_FROZEN');
 const rootRows=[],recordRows=[],total=zero();
 for(let i=0;i<p.roots.length;i++){
  const root=op.purpose==='RESTORE'?validatePortableRoot(p.roots[i]):validateSyncRoot(p.roots[i]),derived=await derive(root),rootId=p.index*128+i;
  rootRows.push({root_id:rootId,root_kind:root.kind,source_tuple:derived.source,source_ordinal:rootId,portable_hash:derived.hash,counts_json:storageJSON(derived.count)});sum(total,derived.count);
  derived.records.forEach((r,j)=>recordRows.push({...r,root_id:rootId,item_ordinal:j}));
 }
 const serializedRoots=storageJSON(rootRows),serializedRecords=storageJSON(recordRows);if(portableBytes(serializedRoots)>1800000||portableBytes(serializedRecords)>1800000)fail('ROOT_TOO_LARGE',413);
 const guard=[userId,op.operation_id,op.generation_version,'UPLOADING',now()];
 const insertRoots=db.prepare(`INSERT INTO personal_restore_roots(user_id,operation_id,root_id,root_kind,source_tuple,source_ordinal,portable_hash,counts_json)
 SELECT ?,?,json_extract(value,'$.root_id'),json_extract(value,'$.root_kind'),json_extract(value,'$.source_tuple'),json_extract(value,'$.source_ordinal'),json_extract(value,'$.portable_hash'),json_extract(value,'$.counts_json') FROM json_each(?) WHERE ${statementGate}`).bind(userId,op.operation_id,serializedRoots,...guard);
 const fields=['root_id','item_ordinal','kind','record_key','parent_key','ordinal','address_json','payload_json','source_tuple','portable_hash','address_hash','container_json','publish_kind'];
 const insertRecords=db.prepare(`INSERT INTO personal_restore_records(user_id,operation_id,${fields.join(',')}) SELECT ?,?,${fields.map(f=>`json_extract(value,'$.${f}')`).join(',')} FROM json_each(?) WHERE ${statementGate}`).bind(userId,op.operation_id,serializedRecords,...guard);
 const insertChunk=db.prepare(`INSERT INTO personal_restore_chunks(user_id,operation_id,chunk_index,chunk_hash,roots,records,counts_json,byte_count) SELECT ?,?,?,?,?,?,?,? WHERE ${statementGate}`).bind(userId,op.operation_id,p.index,hash,rootRows.length,recordRows.length,storageJSON(total),portableBytes(canonicalPortable(p)),...guard);
 try{const result=await db.batch([insertRoots,insertRecords,insertChunk]);if(result[2].meta.changes!==1)fail('STAGE_CHANGED');}catch(e){if(e.code)throw e;const retry=await db.prepare('SELECT chunk_hash FROM personal_restore_chunks WHERE user_id=? AND operation_id=? AND chunk_index=?').bind(userId,op.operation_id,p.index).first();if(retry?.chunk_hash===hash)return {index:p.index,hash,counts:total,roots:rootRows.length,records:recordRows.length};fail('DUPLICATE_SOURCE_ID');}
 return {index:p.index,hash,counts:total,roots:rootRows.length,records:recordRows.length};
}
const pinnedGate=`EXISTS(SELECT 1 FROM users u LEFT JOIN sync_account_state s ON s.user_id=u.id LEFT JOIN user_data d ON d.user_id=u.id WHERE u.id=? AND u.deleted_at IS NULL AND (s.write_status IS NULL OR s.write_status='ACTIVE') AND COALESCE(s.revision,d.sync_version,0)=? AND COALESCE(s.write_token,'')=?)`;
async function saveProgress(db,userId,op,progress,fields={}){
 const next=op.generation_version+1,assign=['progress_json=?','generation_version=?','updated_at=?'],values=[storageJSON(progress),next,now()];
 for(const [field,value]of Object.entries(fields)){assign.push(`${field}=?`);values.push(value);}
 const result=await db.prepare(`UPDATE personal_restore_operations SET ${assign.join(',')} WHERE user_id=? AND operation_id=? AND generation_version=? AND generation_id=? AND state=? AND expires_at>? AND ${pinnedGate}`).bind(...values,userId,op.operation_id,op.generation_version,op.generation_id,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
 if(result.meta.changes!==1)fail('GENERATION_CHANGED');return {...op,...fields,generation_version:next,progress_json:storageJSON(progress)};
}
function pinMatches(op,state){return op.pinned_revision===state.sync_version&&(op.pinned_token||'')===(state.write_token||'');}
async function beginProgress(db,userId,op,state,phase,fields={}){
 const generation=crypto.randomUUID(),progress={phase,last:-1,item:-1,processed:0,counts:zero(),chain:await portableHash(['reptrio-personal-stage-v1',phase,op.operation_id,op.source_namespace,op.data_schema_version]),selection:fields.selection_hash||null};
 const assigns=['generation_id=?','generation_version=generation_version+1','pinned_revision=?','pinned_token=?','progress_json=?','updated_at=?'],vals=[generation,state.sync_version,state.write_token||'',storageJSON(progress),now()];
 for(const [field,value]of Object.entries(fields)){assigns.push(`${field}=?`);vals.push(value);}
 const result=await db.prepare(`UPDATE personal_restore_operations SET ${assigns.join(',')} WHERE user_id=? AND operation_id=? AND generation_version=? AND(expires_at>? OR state='COMMITTED') AND ${pinnedGate}`).bind(...vals,userId,op.operation_id,op.generation_version,now(),userId,state.sync_version,state.write_token||'').run();if(result.meta.changes!==1)fail('GENERATION_CHANGED');return {...op,...fields,generation_id:generation,generation_version:op.generation_version+1,pinned_revision:state.sync_version,pinned_token:state.write_token||'',progress_json:storageJSON(progress)};
}
async function rootPage(db,userId,op,progress){
 const fields=['root_id','root_kind','source_tuple','source_ordinal','portable_hash','counts_json'];
 const sql=`WITH candidates AS(SELECT ${fields.join(',')} FROM personal_restore_roots WHERE user_id=? AND operation_id=? AND root_id>? ORDER BY root_id LIMIT 256),
 measured AS(SELECT *,SUM(length(CAST(json_object(${fields.map(f=>`'${f}',${f}`).join(',')},'oversized',0) AS BLOB))+1) OVER(ORDER BY root_id) AS bytes FROM candidates)
 SELECT ${fields.join(',')},0 AS oversized FROM measured WHERE bytes<=1799998 AND ${pinnedGate} AND ${statementGate}
 UNION ALL SELECT ${fields.map(()=> 'NULL').join(',')},1 AS oversized WHERE EXISTS(SELECT 1 FROM measured WHERE root_id=(SELECT MIN(root_id) FROM measured) AND bytes>1799998) ORDER BY root_id`;
 const rows=(await db.prepare(sql).bind(userId,op.operation_id,progress.last,userId,op.pinned_revision,op.pinned_token||'',userId,op.operation_id,op.generation_version,op.state,now()).all()).results;
 if(rows.some(r=>r.oversized))fail('PAGE_LIMIT',413);return rows;
}
async function finalize(db,userId,op,state,p){
 exactFields(p,['localBinding','generationId']);
 if(op.purpose==='SYNC'&&['FROZEN','SYNC_CHECKING','SYNC_READY'].includes(op.state))return finalizeSync(db,userId,op,state,p);
 if(['FROZEN','PREVIEWING','READY'].includes(op.state))return {operationId:op.operation_id,status:'READY',semanticDigest:op.semantic_hash};
 if(!['UPLOADING','FINALIZING'].includes(op.state))fail('STATE_INVALID');
 if(op.state==='UPLOADING'){
  const receipt=await db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(roots),0) AS roots,COALESCE(SUM(records),0) AS records FROM personal_restore_chunks WHERE user_id=? AND operation_id=?').bind(userId,op.operation_id).first();if(receipt.count!==op.expected_chunks)fail('INCOMPLETE');
  op=await beginProgress(db,userId,op,state,'finalize',{state:'FINALIZING'});
 }else {if(!pinMatches(op,state))fail('GENERATION_CHANGED');if(p.generationId!==op.generation_id)fail('GENERATION_CHANGED');}
 let progress=JSON.parse(op.progress_json),done=false;
 for(let page=0;page<8;page++){
  const rows=await rootPage(db,userId,op,progress);if(!rows.length){done=true;break;}
  for(const r of rows){const descriptor={kind:r.root_kind,source:r.source_tuple,ordinal:r.source_ordinal,hash:r.portable_hash,counts:JSON.parse(r.counts_json)};progress.chain=await portableHash(['reptrio-personal-chain-v1','finalize',progress.chain,progress.processed,await portableHash(descriptor)]);progress.processed++;progress.last=r.root_id;sum(progress.counts,descriptor.counts);}
  op=await saveProgress(db,userId,op,progress);
 }
 if(!done)return progressReply(op,progress);
 const actual=await db.prepare(`SELECT (SELECT COUNT(*) FROM personal_restore_roots WHERE user_id=? AND operation_id=? AND root_id>=0) AS roots,(SELECT COUNT(*) FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0) AS records,SUM(roots) AS chunk_roots,SUM(records) AS chunk_records FROM personal_restore_chunks WHERE user_id=? AND operation_id=?`).bind(userId,op.operation_id,userId,op.operation_id,userId,op.operation_id).first();
 if(actual.roots!==progress.processed||actual.roots!==actual.chunk_roots||actual.records!==actual.chunk_records||canonicalPortable(progress.counts)!==canonicalPortable(JSON.parse(op.expected_counts_json)))fail('COUNT_MISMATCH');
 const semantic=await portableHash(['reptrio-personal-finish-v1','finalize',progress.chain,progress.counts,actual.records]);
 op=await saveProgress(db,userId,op,progress,{state:'FROZEN',semantic_hash:semantic});if(op.purpose==='SYNC')return finalizeSync(db,userId,op,state,p);return {...progressReply(op,progress,'READY'),semanticDigest:semantic,counts:progress.counts};
}
async function cancel(db,userId,op){
 if(op.state==='CANCELLED')return {operationId:op.operation_id,status:'CANCELLED'};
 if(op.committed_revision!==null||['COMMITTED','UNDONE'].includes(op.state))fail('CANNOT_CANCEL');
 const token=crypto.randomUUID(),stamp=now();const batch=[db.prepare(`UPDATE personal_restore_operations SET state='CANCELLED',generation_id=?,progress_json=NULL,generation_version=generation_version+1,updated_at=? WHERE user_id=? AND operation_id=? AND state NOT IN('COMMITTED','UNDONE')`).bind(token,stamp,userId,op.operation_id)];
 for(const table of ['personal_restore_records','personal_restore_roots','personal_restore_chunks'])batch.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND operation_id=? AND EXISTS(SELECT 1 FROM personal_restore_operations WHERE user_id=? AND operation_id=? AND state='CANCELLED' AND generation_id=?)`).bind(userId,op.operation_id,userId,op.operation_id,token));
 await db.batch(batch);return {operationId:op.operation_id,status:'CANCELLED'};
}
// Length checks and payload fetch share one SQL snapshot and pinned owner predicate.
async function boundedMetadata(db,userId,op,field){
 const row=await db.prepare(`SELECT CASE WHEN length(CAST(json_object('payload_json',payload_json,'address_json',address_json) AS BLOB))<=1799000 AND ${pinnedGate} THEN payload_json ELSE NULL END AS payload_json,length(CAST(json_object('payload_json',payload_json,'address_json',address_json) AS BLOB)) AS bytes FROM (SELECT payload_json,address_json FROM sync_records WHERE user_id=? AND kind='metadata' AND record_key=? AND tombstone=0 UNION ALL SELECT payload_json,address_json FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id=-1 AND kind='metadata' AND record_key=? AND NOT EXISTS(SELECT 1 FROM sync_account_state WHERE user_id=?))`).bind(userId,op.pinned_revision,op.pinned_token||'',userId,key(field),userId,op.operation_id,key(field),userId).first();
 if(row && row.payload_json===null)fail('METADATA_LIMIT',413);return row?JSON.parse(row.payload_json):undefined;
}
function pathValue(container,path){
 if(path[0]==='legacyUnitContext'){
  if(!object(container))return {present:container!==undefined,value:container,invalid:container!==undefined};
  const present=own(container,'legacyWeightUnit')||own(container,'legacyWeightUnitCapturedAt');return {present,value:{legacyWeightUnit:container.legacyWeightUnit,legacyWeightUnitCapturedAt:container.legacyWeightUnitCapturedAt},invalid:present&&(!own(container,'legacyWeightUnit')||!own(container,'legacyWeightUnitCapturedAt'))};
 }
 if(path.length===1){if(container===undefined)return {present:false};if(!object(container))return {present:true,invalid:true};return {present:own(container,path[0]),value:container[path[0]]};}
 if(container===undefined)return {present:false};if(!object(container))return {present:true,invalid:true};
 if(path[0]==='gyms'){if(!own(container,'gyms'))return {present:false};if(!Array.isArray(container.gyms)||container.gyms.some(g=>!object(g)||typeof g.id!=='string'))return {present:true,invalid:true};const matches=container.gyms.filter(g=>g.id===path[1]);return {present:matches.length!==0,value:matches[0],invalid:matches.length>1};}
 if(!own(container,path[0]))return {present:false};const child=container[path[0]];if(!object(child))return {present:true,invalid:true};return {present:own(child,path[1]),value:child[path[1]]};
}
async function recordPage(db,userId,op,progress){
 const columns={root_id:'r.root_id',item_ordinal:'r.item_ordinal',kind:'r.kind',record_key:'r.record_key',parent_key:'r.parent_key',ordinal:'r.ordinal',address_json:'r.address_json',source_tuple:'r.source_tuple',portable_hash:'r.portable_hash',publish_kind:'r.publish_kind',existing_payload:'s.payload_json',existing_address:'s.address_json',existing_ordinal:'s.ordinal',existing_tombstone:'s.tombstone',existing_created:'s.created_revision',existing_modified:'s.modified_revision',journal_state:'j.state',journal_hash:'j.import_hash',journal_target:'j.target_key',journal_disposition:'j.disposition'};
 const list=Object.entries(columns).map(([name,column])=>`${column} AS ${name}`).join(',');
 const projection=Object.keys(columns).map(k=>`'${k}',${k}`).join(',');
 const sql=`WITH candidates AS(SELECT ${list} FROM personal_restore_records r LEFT JOIN(SELECT user_id,kind,record_key,payload_json,address_json,ordinal,tombstone,created_revision,modified_revision FROM sync_records UNION ALL SELECT user_id,kind,record_key,payload_json,address_json,ordinal,0,0,0 FROM personal_restore_records b WHERE b.root_id=-1 AND NOT EXISTS(SELECT 1 FROM sync_account_state a WHERE a.user_id=b.user_id))s ON s.user_id=r.user_id AND s.kind=COALESCE(r.publish_kind,CASE WHEN r.kind IN('day','section','exercise') THEN 'program' END) AND s.record_key=r.record_key LEFT JOIN personal_restore_identity_journal j ON j.user_id=r.user_id AND j.source_namespace=? AND j.kind=r.kind AND j.source_tuple=r.source_tuple WHERE r.user_id=? AND r.operation_id=? AND r.root_id>=0 AND (r.root_id>? OR (r.root_id=? AND r.item_ordinal>?)) ORDER BY r.root_id,r.item_ordinal LIMIT 256),measured AS(SELECT *,SUM(length(CAST(json_object(${projection},'oversized',0) AS BLOB))+1) OVER(ORDER BY root_id,item_ordinal) AS bytes FROM candidates)
 SELECT ${Object.keys(columns).join(',')},0 AS oversized FROM measured WHERE bytes<=1799998 AND ${pinnedGate} AND ${statementGate}
 UNION ALL SELECT ${Object.keys(columns).map(()=> 'NULL').join(',')},1 AS oversized WHERE EXISTS(SELECT 1 FROM measured WHERE bytes>1799998 AND (root_id,item_ordinal)=(SELECT root_id,item_ordinal FROM measured ORDER BY root_id,item_ordinal LIMIT 1)) ORDER BY root_id,item_ordinal`;
 const rows=(await db.prepare(sql).bind(op.source_namespace,userId,op.operation_id,progress.last,progress.last,progress.item,userId,op.pinned_revision,op.pinned_token||'',userId,op.operation_id,op.generation_version,op.state,now()).all()).results;
 if(rows.some(r=>r.oversized))fail('PAGE_LIMIT',413);return rows;
}
function selectionInput(p){
 if(p.selection===undefined)return {mode:'all-eligible'};
 exactFields(p.selection,['mode','roots']);if(p.selection.mode==='all-eligible'){if(own(p.selection,'roots'))fail('SELECTION_INVALID');return p.selection;}
 if(p.selection.mode!=='explicit'||!Array.isArray(p.selection.roots)||p.selection.roots.length>128)fail('SELECTION_INVALID');
 const seen=new Set();for(const r of p.selection.roots){exactFields(r,['kind','sourceTuple']);if(typeof r.kind!=='string'||typeof r.sourceTuple!=='string'||seen.has(canonicalPortable(r)))fail('SELECTION_INVALID');seen.add(canonicalPortable(r));}return p.selection;
}
async function preview(db,userId,op,state,p){
 exactFields(p,['localBinding','generationId','selection']);if(!['FROZEN','PREVIEWING','READY'].includes(op.state))fail('STATE_INVALID');
 const selection=selectionInput(p),selectionHash=await portableHash(selection);
 if(op.state==='READY'&&pinMatches(op,state)&&op.selection_hash===selectionHash)return {operationId:op.operation_id,status:'READY',previewDigest:op.preview_hash,semanticDigest:op.semantic_hash,selectionDigest:op.selection_hash,warnings:JSON.parse(op.progress_json).warnings};
 if(op.state!=='PREVIEWING'||op.selection_hash!==selectionHash||!pinMatches(op,state)){
  op=await beginProgress(db,userId,op,state,'preview',{state:'PREVIEWING',selection_hash:selectionHash,preview_hash:null});
  await clearSynthetic(db,userId,op);
  const chosen=selection.mode==='all-eligible'?null:storageJSON(selection.roots);
  await db.prepare(`UPDATE personal_restore_roots SET selected=CASE WHEN ? IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM json_each(?) j WHERE root_kind=json_extract(j.value,'$.kind') AND source_tuple=json_extract(j.value,'$.sourceTuple')) END,classification=NULL WHERE user_id=? AND operation_id=? AND root_id>=0 AND ${statementGate}`).bind(chosen,chosen||'[]',userId,op.operation_id,userId,op.operation_id,op.generation_version,'PREVIEWING',now()).run();
 }else if(p.generationId!==op.generation_id)fail('GENERATION_CHANGED');
 if(!state.write_token){await bootstrapBaseline(db,userId,op,state);}
 const settings=await boundedMetadata(db,userId,op,'settings'),history=await boundedMetadata(db,userId,op,'importHistory');
 let progress=JSON.parse(op.progress_json),done=false;
 if(progress.phase==='proof')return finishPreviewProof(db,userId,op,progress);
 for(let page=0;page<4;page++){
  const rows=await recordPage(db,userId,op,progress);if(!rows.length){done=true;break;}
  const updates=[];
  for(const r of rows){
   let classification;
   if(r.journal_state==='UNDONE'||r.journal_state==='LIVE'&&(r.journal_target!==r.record_key||r.journal_hash!==r.portable_hash))classification='LEDGER';
   else if(r.kind==='metadataPath'){
    let present;const path=JSON.parse(r.address_json);
    if(r.record_key===key('importHistory')){if(history===undefined)present={present:false};else if(!Array.isArray(history)||history.some(h=>!object(h)||typeof h.importId!=='string'))present={present:true,invalid:true};else{const matches=history.filter(h=>h.importId===path[0]);present={present:matches.length>0,value:matches[0],invalid:matches.length>1};}}
    else present=pathValue(settings,path);
    classification=present.invalid?'CONFLICT':!present.present?'NEW':await portableHash(present.value)===r.portable_hash?'SAME':'CONFLICT';
    if(r.journal_state==='LIVE'&&!present.present)classification='LEDGER';
   }else if(r.publish_kind){
    classification=r.existing_tombstone?'TOMBSTONE':r.existing_payload===null?'NEW':await portableHash(JSON.parse(r.existing_payload))===r.portable_hash&&samePortableAddress(r.kind,r.existing_address,r.address_json)?'SAME':'CONFLICT';
    if(r.journal_state==='LIVE'&&r.existing_payload===null)classification='LEDGER';
   }else {const present=virtualValue(r.existing_payload,r.address_json);classification=r.existing_tombstone?'TOMBSTONE':!present.present?'NEW':await portableHash(present.value)===r.portable_hash?'SAME':'CONFLICT';if(r.journal_state==='LIVE'&&!present.present)classification='LEDGER';}
   updates.push({root:r.root_id,item:r.item_ordinal,classification});
   const descriptor={kind:r.kind,source:r.source_tuple,hash:r.portable_hash,address:r.address_json,classification};
   progress.chain=await portableHash(['reptrio-personal-chain-v1','preview',progress.chain,progress.processed,await portableHash(descriptor)]);progress.processed++;progress.last=r.root_id;progress.item=r.item_ordinal;
  }
  const values=storageJSON(updates);
  const update=db.prepare(`WITH updates AS MATERIALIZED(SELECT json_extract(value,'$.root')AS root_id,json_extract(value,'$.item')AS item_ordinal,json_extract(value,'$.classification')AS classification FROM json_each(?)) UPDATE personal_restore_records AS r SET classification=u.classification FROM updates u WHERE r.user_id=? AND r.operation_id=? AND r.root_id=u.root_id AND r.item_ordinal=u.item_ordinal AND ${statementGate} AND ${pinnedGate}`).bind(values,userId,op.operation_id,userId,op.operation_id,op.generation_version,'PREVIEWING',now(),userId,op.pinned_revision,op.pinned_token||'');
  // Classification and checkpoint must advance together; a retry cannot double-advance.
  const next=op.generation_version+1;
  const advance=db.prepare(`UPDATE personal_restore_operations SET progress_json=?,generation_version=?,updated_at=? WHERE user_id=? AND operation_id=? AND generation_version=? AND state='PREVIEWING' AND expires_at>? AND ${pinnedGate}`).bind(storageJSON(progress),next,now(),userId,op.operation_id,op.generation_version,now(),userId,op.pinned_revision,op.pinned_token||'');
  const result=await db.batch([update,advance]);if(result[1].meta.changes!==1)fail('GENERATION_CHANGED');op={...op,generation_version:next};
 }
 if(!done)return progressReply(op,progress);
 const verified=await db.prepare('SELECT COUNT(*) AS total,SUM(CASE WHEN classification IS NULL THEN 1 ELSE 0 END) AS incomplete FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0').bind(userId,op.operation_id).first();if(verified.total!==progress.processed||verified.incomplete)fail('INCOMPLETE');
 await db.prepare(`UPDATE personal_restore_roots SET classification=CASE WHEN EXISTS(SELECT 1 FROM personal_restore_records r WHERE r.user_id=personal_restore_roots.user_id AND r.operation_id=personal_restore_roots.operation_id AND r.root_id=personal_restore_roots.root_id AND r.classification NOT IN('NEW','SAME')) THEN 'CONFLICT' WHEN EXISTS(SELECT 1 FROM personal_restore_records r WHERE r.user_id=personal_restore_roots.user_id AND r.operation_id=personal_restore_roots.operation_id AND r.root_id=personal_restore_roots.root_id AND r.classification='NEW') THEN 'NEW' ELSE 'SAME' END WHERE user_id=? AND operation_id=? AND root_id>=0 AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,'PREVIEWING',now(),userId,op.pinned_revision,op.pinned_token||'').run();
 await dependencyClosure(db,userId,op);
 await db.prepare(`UPDATE personal_restore_records SET selected=CASE WHEN classification IN('NEW','SAME') AND EXISTS(SELECT 1 FROM personal_restore_roots t WHERE t.user_id=personal_restore_records.user_id AND t.operation_id=personal_restore_records.operation_id AND t.root_id=personal_restore_records.root_id AND t.selected=1 AND (t.root_kind IN('settings','importHistory') OR t.classification IN('NEW','SAME'))) THEN 1 ELSE 0 END WHERE user_id=? AND operation_id=? AND root_id>=0 AND ${statementGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,'PREVIEWING',now()).run();
 const classification=(await db.prepare('SELECT classification,COUNT(*) AS count FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 GROUP BY classification').bind(userId,op.operation_id).all()).results;
 await prepareMetadata(db,userId,op,settings,history);
 await prepareMarkers(db,userId,op);
 progress.phase='proof';progress.warnings=await historicalWarnings(db,userId,op);progress.classifications=classification;progress.proof=await proofSeed(op);
 op=await saveProgress(db,userId,op,progress);return progressReply(op,progress);

}

// Normal staged publication carries raw complete storage roots, independently of the portable allowlist.
function validateSyncRoot(root){
 exactFields(root,['kind','record','field']);inspect(root);
 if(!['session','program','measurement','metadata'].includes(root.kind))fail('SYNC_ROOT_INVALID');
 if(root.kind==='metadata'){if(typeof root.field!=='string'||!root.field.length||['__proto__','constructor','prototype'].includes(root.field)||['sessions','programs','measurements'].includes(root.field)&&(!Array.isArray(root.record)||root.record.length))fail('SYNC_ROOT_INVALID');}
 else if(!object(root.record)||typeof root.record.id!=='string'||!root.record.id.length)fail('SYNC_ROOT_INVALID');
 return root;
}
async function stageSynthetic(db,userId,op,rootId,records){
 const root=db.prepare(`INSERT INTO personal_restore_roots(user_id,operation_id,root_id,root_kind,source_tuple,source_ordinal,portable_hash,counts_json,classification,selected) SELECT ?,?,?,'internal',?,?,'','{}','NEW',1 WHERE ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,rootId,key(rootId),rootId,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'');
 const fields=['root_id','item_ordinal','kind','record_key','parent_key','ordinal','address_json','payload_json','source_tuple','portable_hash','address_hash','container_json','publish_kind','classification','selected'];
 for(const r of records){r.portable_hash=await portableHash(JSON.parse(r.payload_json));r.address_hash=await portableHash(JSON.parse(r.address_json));r.container_json='{}';}
 const chunks=recordChunks(records.map((r,i)=>({...r,root_id:rootId,item_ordinal:i,source_tuple:storageJSON([rootId,r.kind,r.record_key]),portable_hash:r.portable_hash,address_hash:r.address_hash,container_json:'{}',publish_kind:r.kind,classification:'NEW',selected:1})));
 if(chunks.length>30)fail('BOOTSTRAP_LIMIT',413);
 const statements=[db.prepare(`DELETE FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id=? AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,rootId,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||''),db.prepare(`DELETE FROM personal_restore_roots WHERE user_id=? AND operation_id=? AND root_id=? AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,rootId,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||''),root];
 for(const chunk of chunks)statements.push(db.prepare(`INSERT INTO personal_restore_records(user_id,operation_id,${fields.join(',')}) SELECT ?,?,${fields.map(f=>`json_extract(value,'$.${f}')`).join(',')} FROM json_each(?) WHERE ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,chunk,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||''));
 const result=await db.batch(statements);if(result[2].meta.changes!==1)fail('GENERATION_CHANGED');
}
async function bootstrapBaseline(db,userId,op,state){
 const existing=await db.prepare('SELECT counts_json FROM personal_restore_roots WHERE user_id=? AND operation_id=? AND root_id=-1').bind(userId,op.operation_id).first();if(existing&&JSON.parse(existing.counts_json).baseRevision===op.pinned_revision)return;
 // Exactly escaped response length and ownership are checked in the same statement before legacy payload leaves D1.
 const row=await db.prepare(`SELECT CASE WHEN length(CAST(json_object('data_json',payload_json) AS BLOB))<=1799998 AND ${pinnedGate} THEN payload_json ELSE NULL END AS data_json FROM user_data WHERE user_id=?`).bind(userId,op.pinned_revision,op.pinned_token||'',userId).first();
 if(row&&row.data_json===null)fail('LEGACY_UNSUPPORTED',413);
 let records=[];try{if(row?.data_json){const data=parsePortable(row.data_json);records=splitData(data);}}catch{fail('LEGACY_UNSUPPORTED');}
 await stageSynthetic(db,userId,op,-1,records);
 await db.prepare(`UPDATE personal_restore_roots SET counts_json=? WHERE user_id=? AND operation_id=? AND root_id=-1 AND ${statementGate} AND ${pinnedGate}`).bind(storageJSON({baseRevision:op.pinned_revision}),userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
}
function addPath(container,path,value){
 if(path[0]==='legacyUnitContext'){container.legacyWeightUnit=value.legacyWeightUnit;container.legacyWeightUnitCapturedAt=value.legacyWeightUnitCapturedAt;}
 else if(path[0]==='gyms'){if(!own(container,'gyms'))container.gyms=[];container.gyms.push(value);}
 else if(path.length===2){if(!own(container,path[0]))container[path[0]]={};container[path[0]][path[1]]=value;}
 else container[path[0]]=value;
}
async function prepareMetadata(db,userId,op,settings,history){
 for(const [index,field,current]of [[-2,'settings',settings],[-3,'importHistory',history]]){
  const row=await db.prepare(`WITH candidates AS(SELECT address_json,payload_json FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND kind='metadataPath' AND record_key=? AND selected=1 AND classification='NEW'), measured AS(SELECT SUM(length(CAST(json_object('address_json',address_json,'payload_json',payload_json)AS BLOB))+1)+2 AS bytes FROM candidates) SELECT address_json,payload_json FROM candidates WHERE (SELECT COALESCE(bytes,2) FROM measured)<=1799998 AND ${pinnedGate} UNION ALL SELECT NULL,NULL WHERE (SELECT bytes FROM measured)>1799998`).bind(userId,op.operation_id,key(field),userId,op.pinned_revision,op.pinned_token||'').all();
  if(row.results.some(r=>r.payload_json===null))fail('METADATA_LIMIT',413);if(!row.results.length)continue;
  const merged=current===undefined?(field==='settings'?{}:[]):structuredClone(current);
  for(const item of row.results){const path=JSON.parse(item.address_json),value=JSON.parse(item.payload_json);if(field==='settings')addPath(merged,path,value);else merged.push(value);}
  const witnesses=[];
  for(const item of row.results){const path=JSON.parse(item.address_json),value=JSON.parse(item.payload_json);witnesses.push({path:item.address_json,witness:storageJSON({version:2,fieldPresent:current!==undefined,profilePresent:object(current)&&own(current,'profile'),gymsPresent:object(current)&&own(current,'gyms'),ownedRawHash:await rawProofHash(value),ownedPosition:metadataPosition(field,merged,path)})});}
  const encodedWitnesses=storageJSON(witnesses);if(portableBytes(encodedWitnesses)>1800000)fail('METADATA_LIMIT',413);
  await db.prepare(`WITH witnesses AS(SELECT json_extract(value,'$.path')AS path,json_extract(value,'$.witness')AS witness FROM json_each(?)) UPDATE personal_restore_records AS r SET container_json=w.witness FROM witnesses w WHERE r.address_json=w.path AND r.user_id=? AND r.operation_id=? AND r.kind='metadataPath' AND r.record_key=? AND ${statementGate} AND ${pinnedGate}`).bind(encodedWitnesses,userId,op.operation_id,key(field),userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
  const record={kind:'metadata',record_key:key(field),parent_key:null,ordinal:0,address_json:storageJSON({field,collection:false}),payload_json:storageJSON(merged)};
  if(portableBytes(storageJSON(record))+256>1800000)fail('METADATA_LIMIT',413);await stageSynthetic(db,userId,op,index,[record]);
 }
}
function metadataPosition(field,value,path){
 if(field==='importHistory')return value.findIndex(item=>item?.importId===path[0]);
 if(path[0]==='gyms')return value.gyms.findIndex(item=>item?.id===path[1]);
 if(path[0]==='legacyUnitContext')return [Object.keys(value).indexOf('legacyWeightUnit'),Object.keys(value).indexOf('legacyWeightUnitCapturedAt')];
 if(path.length===2)return Object.keys(value[path[0]]).indexOf(path[1]);
 return Object.keys(value).indexOf(path[0]);
}
function virtualValue(payload,pathJSON){
 if(payload===null)return {present:false};const path=JSON.parse(pathJSON);let node=JSON.parse(payload);
 for(let i=0;i<path.length;i+=2){const list=node?.[path[i]];if(!Array.isArray(list))return {present:false};const found=list.filter(n=>object(n)&&n.id===path[i+1]);if(found.length!==1)return {present:false};node=found[0];}return {present:true,value:node};
}
async function dependencyClosure(db,userId,op){
 // An absent source historical target remains a warning. A supplied, excluded or conflicted source target
 // must never silently become a link to unrelated target-account content under the same identifier.
 const availableProgram=id=>`NOT EXISTS(SELECT 1 FROM personal_restore_roots t WHERE t.user_id=r.user_id AND t.operation_id=r.operation_id AND t.root_kind='program' AND t.source_tuple=json_array(${id}) AND NOT(t.classification='SAME' OR(t.classification='NEW' AND t.selected=1)))`;
 const availableGym=id=>`NOT EXISTS(SELECT 1 FROM personal_restore_records g WHERE g.user_id=r.user_id AND g.operation_id=r.operation_id AND g.kind='metadataPath' AND g.record_key='["settings"]' AND json_extract(g.address_json,'$[0]')='gyms' AND json_extract(g.address_json,'$[1]')=${id} AND NOT(g.classification='SAME' OR(g.classification='NEW' AND EXISTS(SELECT 1 FROM personal_restore_roots t WHERE t.user_id=g.user_id AND t.operation_id=g.operation_id AND t.root_id=g.root_id AND t.selected=1))))`;
 const program=`CASE WHEN r.kind='session' THEN json_extract(r.payload_json,'$.programId') WHEN r.kind='metadataPath' AND json_extract(r.address_json,'$[0]')='activeProgramId' THEN json_extract(r.payload_json,'$') WHEN r.kind='metadataPath' AND r.record_key='["importHistory"]' THEN json_extract(r.payload_json,'$.finalProgramId') END`;
 const gym=`CASE WHEN r.kind='session' THEN json_extract(r.payload_json,'$.gymId') WHEN r.kind='metadataPath' AND json_extract(r.address_json,'$[0]')='defaultGymId' THEN json_extract(r.payload_json,'$') END`;
 await db.prepare(`UPDATE personal_restore_records AS r SET classification='DEPENDENCY' WHERE r.user_id=? AND r.operation_id=? AND r.root_id>=0 AND r.classification IN('NEW','SAME') AND (NOT(${availableProgram(program)}) OR NOT(${availableGym(gym)})) AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
 await db.prepare(`UPDATE personal_restore_records AS r SET classification='DEPENDENCY' WHERE r.user_id=? AND r.operation_id=? AND r.kind='session' AND r.root_id>=0 AND r.classification IN('NEW','SAME') AND json_extract(r.payload_json,'$.weightUnit')IS NULL AND NOT EXISTS(SELECT 1 FROM personal_restore_records context JOIN personal_restore_roots t ON t.user_id=context.user_id AND t.operation_id=context.operation_id AND t.root_id=context.root_id WHERE context.user_id=r.user_id AND context.operation_id=r.operation_id AND context.kind='metadataPath' AND json_extract(context.address_json,'$[0]')='legacyUnitContext' AND json_extract(context.payload_json,'$.legacyWeightUnit')IN('kg','lb') AND json_type(context.payload_json,'$.legacyWeightUnitCapturedAt')='text' AND(context.classification='SAME' OR(context.classification='NEW' AND t.selected=1))) AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
 // Session/program indivisibility includes child identity conflicts and dependency failures.
 await db.prepare(`UPDATE personal_restore_roots SET classification='CONFLICT' WHERE user_id=? AND operation_id=? AND root_id>=0 AND root_kind IN('session','program') AND EXISTS(SELECT 1 FROM personal_restore_records r WHERE r.user_id=personal_restore_roots.user_id AND r.operation_id=personal_restore_roots.operation_id AND r.root_id=personal_restore_roots.root_id AND r.classification NOT IN('NEW','SAME')) AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
}
async function historicalWarnings(db,userId,op){
 // Supplied but excluded/conflicted targets are dependencies, not missing-history warnings.
 // This count has no payload/list copy and includes only final selected additions.
 const sql=`WITH refs AS(SELECT r.kind,r.record_key,json_extract(r.payload_json,'$.programId')AS program,
 j.key AS alias,j.value AS id,CASE WHEN j.key IN('programId','activeProgramId','finalProgramId')THEN 'program' WHEN j.key IN('gymId','defaultGymId')THEN 'gym' ELSE 'day' END AS target
 FROM personal_restore_records r,json_each(r.payload_json)j WHERE r.user_id=? AND r.operation_id=? AND r.root_id>=0 AND r.selected=1 AND r.classification='NEW' AND r.kind IN('session','metadataPath') AND j.type='text' AND j.key IN('programId','finalProgramId','gymId','dayId','workoutDayId')
 UNION ALL SELECT r.kind,r.record_key,NULL,json_extract(r.address_json,'$[0]'),json_extract(r.payload_json,'$'),CASE json_extract(r.address_json,'$[0]')WHEN 'activeProgramId'THEN 'program' ELSE 'gym' END FROM personal_restore_records r WHERE r.user_id=? AND r.operation_id=? AND r.root_id>=0 AND r.selected=1 AND r.classification='NEW' AND r.kind='metadataPath' AND json_type(r.payload_json,'$')='text' AND json_extract(r.address_json,'$[0]')IN('activeProgramId','defaultGymId'))
 SELECT COUNT(*)AS count FROM refs f WHERE NOT EXISTS(SELECT 1 FROM personal_restore_records t WHERE t.user_id=? AND t.operation_id=? AND((f.target IN('program','day')AND t.kind='program' AND t.record_key=json_array(CASE WHEN f.target='program'THEN f.id ELSE f.program END) AND(f.target='program' OR EXISTS(SELECT 1 FROM json_each(t.payload_json,'$.days')d WHERE json_extract(d.value,'$.id')=f.id)))OR(f.target='gym' AND((t.kind='metadataPath' AND json_extract(t.address_json,'$[0]')='gyms' AND json_extract(t.address_json,'$[1]')=f.id)OR(t.root_id=-1 AND t.kind='metadata' AND t.record_key='["settings"]' AND EXISTS(SELECT 1 FROM json_each(t.payload_json,'$.gyms')g WHERE json_extract(g.value,'$.id')=f.id))))))
 AND NOT EXISTS(SELECT 1 FROM sync_records t WHERE t.user_id=? AND t.tombstone=0 AND((f.target IN('program','day')AND t.kind='program' AND t.record_key=json_array(CASE WHEN f.target='program'THEN f.id ELSE f.program END) AND(f.target='program' OR EXISTS(SELECT 1 FROM json_each(t.payload_json,'$.days')d WHERE json_extract(d.value,'$.id')=f.id)))OR(f.target='gym' AND t.kind='metadata' AND t.record_key='["settings"]' AND EXISTS(SELECT 1 FROM json_each(t.payload_json,'$.gyms')g WHERE json_extract(g.value,'$.id')=f.id))))`;
 return {historicalReferences:(await db.prepare(sql).bind(userId,op.operation_id,userId,op.operation_id,userId,op.operation_id,userId).first()).count};
}
const referenceKeys=Object.freeze({programId:'program',activeProgramId:'program',finalProgramId:'program',gymId:'gym',defaultGymId:'gym',sessionId:'session',exportedSessionIds:'session',deletedSessionIds:'session',closedWorkoutIds:'session',dayId:'day',workoutDayId:'day',sectionId:'section'});
function references(value,owner){
 const found=[];const walk=(node,path,context)=>{
  if(!object(node)&&!Array.isArray(node))return;
  const program=object(node)&&typeof node.programId==='string'?node.programId:context.program;
  for(const [field,v]of Object.entries(node)){
   const next=[...path,field],kind=referenceKeys[field];
   const add=(raw,at)=>{if(typeof raw!=='string'||!raw.length)return;const tuple=['day','section'].includes(kind)?[typeof program==='string'?program:null,raw]:[raw];found.push({kind,tuple:storageJSON(tuple),ownerKind:owner.kind,ownerKey:owner.record_key,path:at,value:raw});};
   if(kind){if(Array.isArray(v))v.forEach((raw,i)=>add(raw,[...next,String(i)]));else add(v,next);}
   if(object(v)||Array.isArray(v))walk(v,next,{program:owner.kind==='program'?JSON.parse(owner.record_key)[0]:program});
  }
 };
 walk(value,[],{program:owner.kind==='program'?JSON.parse(owner.record_key)[0]:undefined});return found;
}
function opaqueFields(value,rules){
 if(!object(value))return {malformed:value};const out={};
 for(const [field,v]of Object.entries(value)){
  if(!own(rules,field)){out[field]=v;continue;}
  const rule=rules[field];if(typeof rule==='string'){
   const base=rule.replace(/[?~]/g,'');if(v===null&&rule.includes('~'))continue;const scalarType=['unit','date','completion','version','exercise','theme','hero','density','avatar'].includes(base)?'string':base;
   if(base!=='sets'&&base!=='strings'&&(typeof v!==scalarType||scalarType==='number'&&!Number.isFinite(v))||base==='strings'&&(!Array.isArray(v)||v.some(x=>typeof x!=='string'))||base==='sets'&&!object(v)){out[field]={malformed:v};continue;}
   if(base==='sets'&&object(v)){const groups={};for(const [g,sets]of Object.entries(v)){if(!object(sets)){groups[g]={malformed:sets};continue;}const children={};for(const [k,set]of Object.entries(sets)){const unknown=opaqueFields(set,WIRE_RULES.fields.set);if(Object.keys(unknown).length)children[k]=unknown;}if(Object.keys(children).length)groups[g]=children;}if(Object.keys(groups).length)out[field]=groups;}
  }else {if(v===null){if(!WIRE_RULES.nullableObjectFields.includes(field))out[field]={malformed:null};continue;}if(rule.fields){const unknown=opaqueFields(v,rule.fields);if(Object.keys(unknown).length)out[field]=unknown;}else if(rule.array){if(!Array.isArray(v)){out[field]={malformed:v};continue;}const unknown=v.map((child,i)=>({index:i,id:child?.id??null,opaque:opaqueFields(child,rule.array)})).filter(child=>Object.keys(child.opaque).length);if(unknown.length)out[field]=unknown;}}
 }
 return Object.keys(out).length?{fields:out,rawKeyOrder:Object.keys(value)}:out;
}
function opaqueScope(row,payload){
 if(['session','program','measurement','set'].includes(row.kind))return opaqueFields(payload,WIRE_RULES.fields[row.kind]);
 if(row.kind==='metadata'){
  const field=JSON.parse(row.address_json).field;
  if(['sessions','programs','measurements','schemaVersion'].includes(field))return {};
  if(field==='settings')return opaqueFields(payload,WIRE_RULES.fields.settings);
  if(field==='importHistory'){if(!Array.isArray(payload))return {malformed:payload};const entries=payload.map((v,i)=>({index:i,id:v?.importId??null,opaque:opaqueFields(v,WIRE_RULES.fields.importHistory)})).filter(v=>Object.keys(v.opaque).length);return entries.length?{entries}:{};}
  return {raw:payload};
 }
 return {raw:payload};
}
const proofSeed=async op=>({version:2,lastKind:'',lastKey:'',processed:0,incoming:0,opaque:0,chain:await portableHash(['reptrio-personal-reversal-baseline-v2',op.operation_id])});
async function currentPage(db,userId,op,proof){
 const fields=['kind','record_key','parent_key','ordinal','address_json','payload_json','created_revision','modified_revision','tombstone','parent_address'];
 const expressions=fields.map(f=>`'${f}',${f}`).join(',');
 const sql=`WITH live AS(SELECT ${fields.filter(f=>f!=='parent_address').map(f=>`r.${f}`).join(',')},CASE WHEN r.kind='set' THEN(SELECT address_json FROM sync_records parent WHERE parent.user_id=r.user_id AND parent.kind='session' AND parent.record_key=r.parent_key AND parent.tombstone=0)ELSE NULL END AS parent_address FROM sync_records r WHERE r.user_id=? AND tombstone=0 UNION ALL SELECT kind,record_key,parent_key,ordinal,address_json,payload_json,?, ?,0,CASE WHEN kind='set'THEN(SELECT parent.address_json FROM personal_restore_records parent WHERE parent.user_id=b.user_id AND parent.operation_id=b.operation_id AND parent.root_id=-1 AND parent.kind='session' AND parent.record_key=b.parent_key)ELSE NULL END FROM personal_restore_records b WHERE user_id=? AND operation_id=? AND root_id=-1 AND NOT EXISTS(SELECT 1 FROM sync_account_state WHERE user_id=?)),candidates AS(SELECT * FROM live WHERE (kind>? OR(kind=? AND record_key>?)) ORDER BY kind,record_key LIMIT 256),measured AS(SELECT *,SUM(length(CAST(json_object(${expressions},'oversized',0)AS BLOB))+1)OVER(ORDER BY kind,record_key)AS bytes FROM candidates) SELECT ${fields.join(',')},0 AS oversized FROM measured WHERE bytes<=1799998 AND ${pinnedGate} AND ${statementGate} UNION ALL SELECT ${fields.map(()=> 'NULL').join(',')},1 WHERE EXISTS(SELECT 1 FROM measured WHERE bytes>1799998 AND(kind,record_key)=(SELECT kind,record_key FROM measured ORDER BY kind,record_key LIMIT 1)) ORDER BY kind,record_key`;
 const rows=(await db.prepare(sql).bind(userId,op.base_revision,op.base_revision,userId,op.operation_id,userId,proof.lastKind,proof.lastKind,proof.lastKey,userId,op.pinned_revision,op.pinned_token||'',userId,op.operation_id,op.generation_version,op.state,now()).all()).results;
 if(rows.some(r=>r.oversized))fail('PROOF_LIMIT',413);return rows;
}
async function matchReferences(db,userId,op,refs,undoMode){
 if(!refs.length)return [];const encoded=storageJSON(refs);if(portableBytes(encoded)>1800000)fail('PROOF_LIMIT',413);
 const target=undoMode?`EXISTS(SELECT 1 FROM personal_restore_identity_journal j WHERE j.user_id=? AND j.operation_id=? AND j.disposition='ADDED' AND j.state='LIVE' AND ((j.kind=json_extract(v.value,'$.kind') AND j.source_tuple=json_extract(v.value,'$.tuple')) OR(json_extract(v.value,'$.kind')='gym' AND j.kind='metadataPath' AND json_extract(j.target_path,'$[0]')='gyms' AND json_array(json_extract(j.target_path,'$[1]'))=json_extract(v.value,'$.tuple'))))`:
 `EXISTS(SELECT 1 FROM personal_restore_records r WHERE r.user_id=? AND r.operation_id=? AND r.root_id>=0 AND r.selected=1 AND r.classification='NEW' AND ((r.kind=json_extract(v.value,'$.kind') AND r.source_tuple=json_extract(v.value,'$.tuple')) OR(json_extract(v.value,'$.kind')='gym' AND r.kind='metadataPath' AND json_extract(r.address_json,'$[0]')='gyms' AND json_array(json_extract(r.address_json,'$[1]'))=json_extract(v.value,'$.tuple'))))`;
 const rows=(await db.prepare(`SELECT CAST(v.key AS INTEGER) AS index_value FROM json_each(?) v WHERE ${target} AND ${pinnedGate} ORDER BY CAST(v.key AS INTEGER)`).bind(encoded,userId,op.operation_id,userId,op.pinned_revision,op.pinned_token||'').all()).results;
 return rows.map(r=>refs[r.index_value]);
}
async function scanProof(db,userId,op,progress,undoMode=false){
 if(!progress.proof)progress.proof=await proofSeed(op);
 for(let page=0;page<8;page++){
  const rows=await currentPage(db,userId,op,progress.proof);if(!rows.length)return {op,progress,done:true};
  const owned=undoMode?await ownedForRows(db,userId,op,rows):[],descriptors=[],refs=[];
  for(const row of rows){
   const journals=owned.filter(j=>j.target_kind===row.kind&&j.target_key===row.record_key);let payload=JSON.parse(row.payload_json),skip=false;
   if(undoMode&&journals.some(j=>j.kind!=='metadataPath'))skip=true;
   if(!skip&&undoMode&&row.kind==='metadata'&&journals.length){const subtracted=subtractOwnedMetadata(row,payload,journals);payload=subtracted.value;skip=!subtracted.present;}
   if(!skip){const opaque=opaqueScope(row,payload),rowRefs=references(payload,row),childContexts=rowRefs.filter(ref=>['day','section'].includes(ref.kind));if(childContexts.length)opaque.referenceCoverage=childContexts;if(row.kind==='session')opaque.storageOrder=JSON.parse(row.address_json);if(row.kind==='set'&&Object.keys(opaque).length)opaque.storageOrder={address:JSON.parse(row.address_json),ordinal:row.ordinal,parent:row.parent_address===null?null:JSON.parse(row.parent_address)};descriptors.push({kind:row.kind,key:row.record_key,opaque});refs.push(...rowRefs);}
   progress.proof.lastKind=row.kind;progress.proof.lastKey=row.record_key;progress.proof.processed++;
  }
  const incoming=await matchReferences(db,userId,op,refs,undoMode);
  for(const descriptor of descriptors){
   if(Object.keys(descriptor.opaque).length){progress.proof.chain=await portableHash(['reptrio-personal-reversal-opaque-v2',progress.proof.chain,await rawProofHash(descriptor)]);progress.proof.opaque++;}
   for(const ref of incoming.filter(ref=>ref.ownerKind===descriptor.kind&&ref.ownerKey===descriptor.key)){progress.proof.chain=await portableHash(['reptrio-personal-reversal-reference-v2',progress.proof.chain,await portableHash(ref)]);progress.proof.incoming++;}
  }
  op=await saveProgress(db,userId,op,progress);
 }
 return {op,progress,done:false};
}
async function finishPreviewProof(db,userId,op,progress){
 const scan=await scanProof(db,userId,op,progress);op=scan.op;progress=scan.progress;if(!scan.done)return progressReply(op,progress);
 const previewHash=await portableHash(['reptrio-personal-preview-ready-v1',op.operation_id,op.semantic_hash,op.selection_hash,op.local_binding,op.pinned_revision,op.pinned_token,op.expires_at,progress.chain,progress.classifications,progress.proof]);
 op=await saveProgress(db,userId,op,progress,{state:'READY',preview_hash:previewHash});return {...progressReply(op,progress,'READY'),semanticDigest:op.semantic_hash,previewDigest:previewHash,selectionDigest:op.selection_hash,classifications:progress.classifications,warnings:progress.warnings};
}
async function prepareMarkers(db,userId,op){
 const kinds=(await db.prepare("SELECT DISTINCT publish_kind AS kind FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND selected=1 AND classification='NEW' AND publish_kind IN('session','program','measurement')").bind(userId,op.operation_id).all()).results;
 const records=[];
 for(const row of kinds){const field={session:'sessions',program:'programs',measurement:'measurements'}[row.kind];
  const exists=await db.prepare("SELECT 1 AS present FROM sync_records WHERE user_id=? AND kind='metadata' AND record_key=? AND tombstone=0 UNION ALL SELECT 1 FROM personal_restore_records WHERE user_id=? AND operation_id=? AND(root_id=-1 OR(root_id>=0 AND selected=1)) AND kind='metadata' AND record_key=? LIMIT 1").bind(userId,key(field),userId,op.operation_id,key(field)).first();
  if(!exists)records.push({kind:'metadata',record_key:key(field),parent_key:null,ordinal:0,address_json:storageJSON({field,collection:true}),payload_json:'null'});
 }
 const schema=await db.prepare("SELECT 1 AS present FROM sync_records WHERE user_id=? AND kind='metadata' AND record_key='[\"schemaVersion\"]' AND tombstone=0 UNION ALL SELECT 1 FROM personal_restore_records WHERE user_id=? AND operation_id=? AND(root_id=-1 OR(root_id>=0 AND selected=1)) AND kind='metadata' AND record_key='[\"schemaVersion\"]' LIMIT 1").bind(userId,userId,op.operation_id).first();
 if(!schema&&(kinds.length||(await db.prepare("SELECT COUNT(*)AS n FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND selected=1 AND classification='NEW'").bind(userId,op.operation_id).first()).n))records.push({kind:'metadata',record_key:key('schemaVersion'),parent_key:null,ordinal:0,address_json:storageJSON({field:'schemaVersion',collection:false}),payload_json:storageJSON(op.data_schema_version)});
 if(records.length)await stageSynthetic(db,userId,op,-4,records);
}
async function allocateOrdinals(db,userId,op){
 const sql=`WITH maxima AS MATERIALIZED(SELECT kind,MAX(ordinal) AS maximum FROM(SELECT kind,ordinal FROM sync_records WHERE user_id=? UNION ALL SELECT kind,ordinal FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id=-1)GROUP BY kind),newroots AS MATERIALIZED(SELECT r.rowid,r.publish_kind,ROW_NUMBER()OVER(PARTITION BY r.publish_kind ORDER BY r.root_id,r.item_ordinal)AS rank FROM personal_restore_records r WHERE r.user_id=? AND r.operation_id=? AND r.selected=1 AND r.classification='NEW' AND r.publish_kind IN('session','program','measurement','metadata') AND r.root_id<>-1 AND NOT EXISTS(SELECT 1 FROM sync_records s WHERE s.user_id=r.user_id AND s.kind=r.publish_kind AND s.record_key=r.record_key) AND NOT EXISTS(SELECT 1 FROM personal_restore_records b WHERE b.user_id=r.user_id AND b.operation_id=r.operation_id AND b.root_id=-1 AND b.kind=r.publish_kind AND b.record_key=r.record_key)) UPDATE personal_restore_records AS r SET target_ordinal=CASE WHEN r.root_id=-1 OR r.publish_kind='set' THEN r.ordinal WHEN r.publish_kind IS NOT NULL THEN COALESCE((SELECT ordinal FROM sync_records s WHERE s.user_id=r.user_id AND s.kind=r.publish_kind AND s.record_key=r.record_key),(SELECT ordinal FROM personal_restore_records b WHERE b.user_id=r.user_id AND b.operation_id=r.operation_id AND b.root_id=-1 AND b.kind=r.publish_kind AND b.record_key=r.record_key),(SELECT COALESCE(m.maximum,-1)+n.rank FROM newroots n LEFT JOIN maxima m ON m.kind=n.publish_kind WHERE n.rowid=r.rowid)) ELSE 0 END WHERE r.user_id=? AND r.operation_id=? AND ${statementGate} AND ${pinnedGate}`;
 await db.prepare(sql).bind(userId,userId,op.operation_id,userId,op.operation_id,userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
 const bad=await db.prepare('SELECT COUNT(*) AS n FROM personal_restore_records WHERE user_id=? AND operation_id=? AND publish_kind IS NOT NULL AND selected=1 AND classification=\'NEW\' AND(target_ordinal IS NULL OR target_ordinal>=9007199254740991)').bind(userId,op.operation_id).first();if(bad.n)fail('ORDER_LIMIT',413);
}
const publicationGate=`EXISTS(SELECT 1 FROM personal_restore_operations o JOIN sync_account_state s ON s.user_id=o.user_id JOIN users u ON u.id=o.user_id WHERE o.user_id=? AND o.operation_id=? AND o.state=? AND o.generation_id=? AND s.revision=? AND s.write_token=? AND s.storage_schema_version=1 AND s.write_status='ACTIVE' AND u.deleted_at IS NULL)`;
async function commit(db,userId,op,state,p){
 if(op.purpose!=='RESTORE')return commitSync(db,userId,op,state,p);
 exactFields(p,['localBinding','confirm','previewDigest','semanticDigest','selectionDigest','baseRevision']);
 if(op.state!=='READY'||p.confirm!==true||p.previewDigest!==op.preview_hash||p.semanticDigest!==op.semantic_hash||p.selectionDigest!==op.selection_hash||p.baseRevision!==op.pinned_revision||!pinMatches(op,state))fail('CONFIRMATION_INVALID');
 const counts=(await db.prepare("SELECT kind,classification,COUNT(*) AS count FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND selected=1 GROUP BY kind,classification").bind(userId,op.operation_id).all()).results;
 if(!counts.length)fail('EMPTY_SELECTION',409);
 await allocateOrdinals(db,userId,op);

 const progress=JSON.parse(op.progress_json),version=state.sync_version+1,token=crypto.randomUUID(),stamp=now();if(!int(version))fail('REVISION_LIMIT');
 const outcome={operationId:op.operation_id,purpose:'RESTORE',status:'COMMITTED',semanticDigest:op.semantic_hash,previewDigest:op.preview_hash,selectionDigest:op.selection_hash,localBinding:op.local_binding,baseRevision:op.pinned_revision,committedRevision:version,counts,warnings:progress.warnings,undoEvidence:{version:2,chain:progress.proof.chain,incoming:progress.proof.incoming,opaque:progress.proof.opaque},updatedAt:stamp};
 const encoded=storageJSON(outcome);if(portableBytes(encoded)+2048>1800000)fail('RECEIPT_LIMIT',413);
 const guard=[userId,op.operation_id,'COMMITTED',token,version,token];
 const operationReady=`EXISTS(SELECT 1 FROM personal_restore_operations o WHERE o.user_id=? AND o.operation_id=? AND o.state='READY' AND o.generation_version=? AND o.preview_hash=? AND o.expires_at>?)`;
 const cas=state.write_token?db.prepare(`UPDATE sync_account_state SET revision=?,write_token=?,updated_at=? WHERE user_id=? AND revision=? AND write_token=? AND storage_schema_version=1 AND write_status='ACTIVE' AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL) AND ${operationReady}`).bind(version,token,stamp,userId,state.sync_version,state.write_token,userId,userId,op.operation_id,op.generation_version,op.preview_hash,stamp):db.prepare(`INSERT INTO sync_account_state(user_id,storage_schema_version,revision,write_token,write_status,updated_at)SELECT ?,1,?,?,'ACTIVE',? WHERE ${pinnedGate} AND NOT EXISTS(SELECT 1 FROM sync_account_state WHERE user_id=?) AND ${operationReady}`).bind(userId,version,token,stamp,userId,state.sync_version,'',userId,userId,op.operation_id,op.generation_version,op.preview_hash,stamp);
 const ownOperation=db.prepare(`UPDATE personal_restore_operations SET state='COMMITTED',generation_id=?,committed_revision=?,updated_at=? WHERE user_id=? AND operation_id=? AND state='READY' AND generation_version=? AND expires_at>? AND ${RECORD_WRITE_GATE_SQL}`).bind(token,version,stamp,userId,op.operation_id,op.generation_version,stamp,userId,version,token);
 const publish=db.prepare(`INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision,tombstone,deleted_revision) SELECT user_id,publish_kind,record_key,parent_key,target_ordinal,address_json,payload_json,?, ?,0,NULL FROM personal_restore_records WHERE user_id=? AND operation_id=? AND publish_kind IS NOT NULL AND selected=1 AND classification='NEW' AND ${publicationGate} ON CONFLICT(user_id,kind,record_key)DO UPDATE SET payload_json=excluded.payload_json,address_json=excluded.address_json,modified_revision=excluded.modified_revision WHERE sync_records.tombstone=0 AND sync_records.kind='metadata'`).bind(version,version,userId,op.operation_id,...guard);
 const journal=db.prepare(`INSERT INTO personal_restore_identity_journal(user_id,source_namespace,kind,source_tuple,target_kind,target_key,target_path,operation_id,import_hash,address_hash,container_json,target_ordinal,added_revision,disposition,state) SELECT r.user_id,?,CASE WHEN r.root_id=-4 THEN 'metadataMarker' ELSE r.kind END,r.source_tuple,COALESCE(r.publish_kind,CASE WHEN r.kind='metadataPath' THEN 'metadata' ELSE 'program' END),r.record_key,CASE WHEN r.kind='metadataPath' OR r.publish_kind IS NULL THEN r.address_json ELSE '[]' END,?,r.portable_hash,r.address_hash,r.container_json,COALESCE(s.ordinal,r.target_ordinal,0),?,CASE WHEN r.classification='NEW' THEN 'ADDED' ELSE 'SAME_EXISTING' END,'LIVE' FROM personal_restore_records r LEFT JOIN sync_records s ON s.user_id=r.user_id AND s.kind=COALESCE(r.publish_kind,CASE WHEN r.kind='metadataPath' THEN 'metadata' ELSE 'program' END) AND s.record_key=r.record_key WHERE r.user_id=? AND r.operation_id=? AND(r.root_id>=0 OR r.root_id=-4) AND r.selected=1 AND r.classification IN('NEW','SAME') AND ${publicationGate} ON CONFLICT(user_id,source_namespace,kind,source_tuple)DO NOTHING`).bind(op.source_namespace,op.operation_id,version,userId,op.operation_id,...guard);
 const receipt=db.prepare(`UPDATE personal_restore_operations SET outcome_json=?,progress_json=NULL WHERE user_id=? AND operation_id=? AND ${publicationGate}`).bind(encoded,userId,op.operation_id,...guard);
 const statements=[cas,ownOperation,publish,journal,receipt];for(const table of ['personal_restore_records','personal_restore_roots','personal_restore_chunks'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND operation_id=? AND ${publicationGate}`).bind(userId,op.operation_id,...guard));
 const result=await db.batch(statements);
 const stored=await operation(db,userId,op.operation_id,op.purpose);
 if(result[0].meta.changes!==1||result[1].meta.changes!==1){if(stored.state==='COMMITTED'&&stored.preview_hash===p.previewDigest&&stored.outcome_json)return JSON.parse(stored.outcome_json);fail('REVISION_CHANGED');}
 if(!stored.outcome_json)fail('RECEIPT_NOT_READY',503);return JSON.parse(stored.outcome_json);
}
export async function cleanupPersonalOperations(env){
 try{
  const tables=await storageTables(env.DB);if(personalRestoreSchemaStatus(tables)!=='ready')return;
  const stamp=now();
  // Bound actual payload-row deletion first; roots cannot cascade to remaining payloads.
  for(let page=0;page<8;page++)await env.DB.prepare(`DELETE FROM personal_restore_records WHERE rowid IN(SELECT r.rowid FROM personal_restore_records r JOIN personal_restore_operations o ON o.user_id=r.user_id AND o.operation_id=r.operation_id WHERE o.expires_at<=? AND o.state NOT IN('COMMITTED','UNDONE','UNDO_READY','UNDO_PREVIEWING') ORDER BY o.expires_at,r.rowid LIMIT 256)`).bind(stamp).run();
  await env.DB.prepare(`DELETE FROM personal_restore_roots WHERE rowid IN(SELECT t.rowid FROM personal_restore_roots t JOIN personal_restore_operations o ON o.user_id=t.user_id AND o.operation_id=t.operation_id WHERE o.expires_at<=? AND NOT EXISTS(SELECT 1 FROM personal_restore_records r WHERE r.user_id=t.user_id AND r.operation_id=t.operation_id AND r.root_id=t.root_id) ORDER BY o.expires_at,t.rowid LIMIT 256)`).bind(stamp).run();
  await env.DB.prepare(`DELETE FROM personal_restore_chunks WHERE rowid IN(SELECT c.rowid FROM personal_restore_chunks c JOIN personal_restore_operations o ON o.user_id=c.user_id AND o.operation_id=c.operation_id WHERE o.expires_at<=? AND NOT EXISTS(SELECT 1 FROM personal_restore_roots t WHERE t.user_id=c.user_id AND t.operation_id=c.operation_id) ORDER BY o.expires_at,c.rowid LIMIT 256)`).bind(stamp).run();
  await env.DB.prepare(`UPDATE personal_restore_operations SET state='EXPIRED',progress_json=NULL,pinned_token=NULL WHERE rowid IN(SELECT rowid FROM personal_restore_operations WHERE expires_at<=? AND state IN('UPLOADING','FINALIZING','FROZEN','PREVIEWING','READY')ORDER BY expires_at,rowid LIMIT 256)`).bind(stamp).run();
  await env.DB.prepare(`DELETE FROM personal_restore_operations WHERE rowid IN(SELECT o.rowid FROM personal_restore_operations o WHERE purpose='SYNC' AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM personal_restore_records r WHERE r.user_id=o.user_id AND r.operation_id=o.operation_id) AND NOT EXISTS(SELECT 1 FROM personal_restore_roots t WHERE t.user_id=o.user_id AND t.operation_id=o.operation_id) AND NOT EXISTS(SELECT 1 FROM personal_restore_chunks c WHERE c.user_id=o.user_id AND c.operation_id=o.operation_id) ORDER BY expires_at,rowid LIMIT 256)`).bind(stamp).run();
 }catch{/* Maintenance retries later; never emit account or payload data. */}
}
async function ownedForRows(db,userId,op,rows){
 const keys=storageJSON(rows.map(r=>({kind:r.kind,key:r.record_key})));if(portableBytes(keys)>1800000)fail('PROOF_LIMIT',413);
 const fields=['kind','target_kind','target_key','target_path','container_json','import_hash','address_hash','target_ordinal','added_revision'];
 const encoded=fields.map(f=>`'${f}',j.${f}`).join(',');
 const results=(await db.prepare(`WITH candidates AS(SELECT ${fields.map(f=>`j.${f}`).join(',')} FROM json_each(?)v CROSS JOIN personal_restore_identity_journal j INDEXED BY personal_restore_journal_target WHERE j.target_kind=json_extract(v.value,'$.kind') AND j.target_key=json_extract(v.value,'$.key') AND j.user_id=? AND j.operation_id=? AND j.disposition='ADDED' AND j.state='LIVE'),bounds AS(SELECT SUM(length(CAST(json_object(${fields.map(f=>`'${f}',${f}`).join(',')})AS BLOB))+1)+2 AS bytes FROM candidates) SELECT ${fields.join(',')} FROM candidates WHERE COALESCE((SELECT bytes FROM bounds),2)<=1799998 AND ${pinnedGate} UNION ALL SELECT ${fields.map(()=> 'NULL').join(',')} WHERE(SELECT bytes FROM bounds)>1799998`).bind(keys,userId,op.operation_id,userId,op.pinned_revision,op.pinned_token||'').all()).results;
 if(results.some(r=>r.kind===null))fail('PROOF_LIMIT',413);return results;
}
function subtractOwnedMetadata(row,payload,journals){
 let next=structuredClone(payload),fieldPresent=true;
 for(const j of journals.filter(j=>j.kind==='metadataPath')){
  const path=JSON.parse(j.target_path),witness=JSON.parse(j.container_json);
  if(row.record_key===key('importHistory')){if(!Array.isArray(next))fail('UNDO_CHANGED');next=next.filter(item=>item?.importId!==path[0]);if(!witness.fieldPresent&&!next.length)fieldPresent=false;continue;}
  if(!object(next))fail('UNDO_CHANGED');
  if(path[0]==='legacyUnitContext'){delete next.legacyWeightUnit;delete next.legacyWeightUnitCapturedAt;}
  else if(path[0]==='gyms'){if(!Array.isArray(next.gyms))fail('UNDO_CHANGED');next.gyms=next.gyms.filter(g=>g?.id!==path[1]);if(!witness.gymsPresent&&!next.gyms.length)delete next.gyms;}
  else if(path.length===2){if(!object(next[path[0]]))fail('UNDO_CHANGED');delete next[path[0]][path[1]];if(path[0]==='profile'&&!witness.profilePresent&&!Object.keys(next.profile).length)delete next.profile;}
  else delete next[path[0]];
  if(!witness.fieldPresent&&!Object.keys(next).length)fieldPresent=false;
 }
 return {value:next,present:fieldPresent};
}
async function journalPage(db,userId,op,progress){
 const fields={kind:'j.kind',source_tuple:'j.source_tuple',target_kind:'j.target_kind',target_key:'j.target_key',target_path:'j.target_path',import_hash:'j.import_hash',address_hash:'j.address_hash',container_json:'j.container_json',target_ordinal:'j.target_ordinal',added_revision:'j.added_revision',payload_json:'s.payload_json',address_json:'s.address_json',ordinal:'s.ordinal',created_revision:'s.created_revision',modified_revision:'s.modified_revision',tombstone:'s.tombstone'};
 const names=Object.keys(fields),projection=names.map(k=>`'${k}',${k}`).join(',');
 const sql=`WITH candidates AS(SELECT ${Object.entries(fields).map(([k,v])=>`${v} AS ${k}`).join(',')} FROM personal_restore_identity_journal j LEFT JOIN sync_records s ON s.user_id=j.user_id AND s.kind=j.target_kind AND s.record_key=j.target_key WHERE j.user_id=? AND j.operation_id=? AND j.disposition='ADDED' AND j.state='LIVE' AND(j.kind>? OR(j.kind=? AND j.source_tuple>?))ORDER BY j.kind,j.source_tuple LIMIT 256),measured AS(SELECT *,SUM(length(CAST(json_object(${projection},'oversized',0)AS BLOB))+1)OVER(ORDER BY kind,source_tuple)AS bytes FROM candidates) SELECT ${names.join(',')},0 AS oversized FROM measured WHERE bytes<=1799998 AND ${pinnedGate} AND ${statementGate} UNION ALL SELECT ${names.map(()=> 'NULL').join(',')},1 WHERE EXISTS(SELECT 1 FROM measured WHERE bytes>1799998 AND(kind,source_tuple)=(SELECT kind,source_tuple FROM measured ORDER BY kind,source_tuple LIMIT 1))ORDER BY kind,source_tuple`;
 const rows=(await db.prepare(sql).bind(userId,op.operation_id,progress.lastKind,progress.lastKind,progress.lastKey,userId,op.pinned_revision,op.pinned_token||'',userId,op.operation_id,op.generation_version,op.state,now()).all()).results;if(rows.some(r=>r.oversized))fail('PROOF_LIMIT',413);return rows;
}
async function undoPreview(db,userId,op,state,p){
 exactFields(p,['localBinding','generationId']);if(!['COMMITTED','UNDO_PREVIEWING','UNDO_READY'].includes(op.state))fail('STATE_INVALID');
 if(op.state==='UNDO_READY'&&pinMatches(op,state))return {operationId:op.operation_id,status:'READY',undoDigest:op.confirm_hash,baseRevision:op.pinned_revision};
 if(op.state!=='UNDO_PREVIEWING'||!pinMatches(op,state)){
  op=await beginProgress(db,userId,op,state,'undo-ownership',{state:'UNDO_PREVIEWING',confirm_hash:null,expires_at:new Date(Date.now()+RESTORE_LIMITS.ttl).toISOString()});
  const progress=JSON.parse(op.progress_json);progress.lastKind='';progress.lastKey='';progress.proof=await proofSeed(op);op=await saveProgress(db,userId,op,progress);
 }else if(p.generationId!==op.generation_id)fail('GENERATION_CHANGED');
 let progress=JSON.parse(op.progress_json);
 if(progress.phase==='undo-ownership'){
  let done=false;for(let page=0;page<8;page++){
   const rows=await journalPage(db,userId,op,progress);if(!rows.length){done=true;break;}
   for(const row of rows){
    if(row.payload_json===null||row.tombstone)fail('UNDO_CHANGED');const payload=JSON.parse(row.payload_json);let value=payload;
    if(row.kind==='metadataPath'){
     const path=JSON.parse(row.target_path);let located;if(row.target_key===key('importHistory')){if(!Array.isArray(payload))fail('UNDO_CHANGED');const matches=payload.filter(h=>h?.importId===path[0]);located={present:matches.length===1,value:matches[0]};}else located=pathValue(payload,path);
     if(!located.present||located.invalid)fail('UNDO_CHANGED');value=located.value;
     const witness=JSON.parse(row.container_json),field=JSON.parse(row.target_key)[0];if(witness.version!==2||typeof witness.ownedRawHash!=='string'||await rawProofHash(value)!==witness.ownedRawHash||storageJSON(metadataPosition(field,payload,path))!==storageJSON(witness.ownedPosition))fail('UNDO_CHANGED');
    }else{
     if(row.created_revision!==row.added_revision||row.modified_revision!==row.added_revision||row.ordinal!==row.target_ordinal)fail('UNDO_CHANGED');
     if(['day','section','exercise'].includes(row.kind)){const located=virtualValue(row.payload_json,row.target_path);if(!located.present)fail('UNDO_CHANGED');value=located.value;}
     else if(await portableHash(JSON.parse(row.address_json))!==row.address_hash)fail('UNDO_CHANGED');
    }
    if(await portableHash(value)!==row.import_hash)fail('UNDO_CHANGED');
    progress.chain=await portableHash(['reptrio-personal-undo-ownership-v1',progress.chain,row.kind,row.source_tuple,row.import_hash,row.address_hash,row.target_ordinal,row.added_revision]);progress.processed++;progress.lastKind=row.kind;progress.lastKey=row.source_tuple;
   }
   op=await saveProgress(db,userId,op,progress);
  }
  if(!done)return progressReply(op,progress);
  const total=await db.prepare("SELECT COUNT(*) AS count FROM personal_restore_identity_journal WHERE user_id=? AND operation_id=? AND disposition='ADDED' AND state='LIVE'").bind(userId,op.operation_id).first();if(total.count!==progress.processed)fail('INCOMPLETE');
  // Synthetic collection metadata cannot be removed while a later surviving root depends on it.
  const used=await db.prepare(`SELECT COUNT(*) AS count FROM personal_restore_identity_journal j JOIN sync_records m ON m.user_id=j.user_id AND m.kind=j.target_kind AND m.record_key=j.target_key WHERE j.user_id=? AND j.operation_id=? AND j.kind='metadataMarker' AND j.disposition='ADDED' AND j.state='LIVE' AND json_extract(m.address_json,'$.collection')=1 AND EXISTS(SELECT 1 FROM sync_records r WHERE r.user_id=j.user_id AND r.tombstone=0 AND r.kind=CASE json_extract(m.address_json,'$.field')WHEN 'sessions'THEN 'session' WHEN 'programs'THEN 'program' WHEN 'measurements'THEN 'measurement' END AND NOT EXISTS(SELECT 1 FROM personal_restore_identity_journal own INDEXED BY personal_restore_journal_target WHERE own.user_id=r.user_id AND own.operation_id=j.operation_id AND own.disposition='ADDED' AND own.state='LIVE' AND own.target_kind=r.kind AND own.target_key=r.record_key))`).bind(userId,op.operation_id).first();if(used.count)fail('UNDO_DEPENDENCY');
  progress.phase='undo-proof';op=await saveProgress(db,userId,op,progress);return progressReply(op,progress);
 }
 const scan=await scanProof(db,userId,op,progress,true);op=scan.op;progress=scan.progress;if(!scan.done)return progressReply(op,progress);
 const evidence=JSON.parse(op.outcome_json)?.undoEvidence;if(!evidence||evidence.version!==2||evidence.chain!==progress.proof.chain||evidence.incoming!==progress.proof.incoming||evidence.opaque!==progress.proof.opaque)fail('UNDO_DEPENDENCY');
 await prepareUndoMetadata(db,userId,op);
 const digest=await portableHash(['reptrio-personal-undo-ready-v1',op.operation_id,op.semantic_hash,op.pinned_revision,op.pinned_token,op.local_binding,op.expires_at,progress.chain,progress.proof]);
 op=await saveProgress(db,userId,op,progress,{state:'UNDO_READY',confirm_hash:digest});return {...progressReply(op,progress,'READY'),undoDigest:digest,baseRevision:op.pinned_revision};
}
async function prepareUndoMetadata(db,userId,op){
 for(const [rootId,field]of [[-2,'settings'],[-3,'importHistory']]){
  const current=await boundedMetadata(db,userId,op,field);if(current===undefined)continue;
  const row={kind:'metadata',record_key:key(field)},owned=await ownedForRows(db,userId,op,[row]);if(!owned.some(j=>j.kind==='metadataPath'))continue;
  const subtracted=subtractOwnedMetadata(row,current,owned),record={kind:'metadata',record_key:key(field),parent_key:null,ordinal:0,address_json:storageJSON({field,collection:false}),payload_json:storageJSON(subtracted.value)};
  if(portableBytes(storageJSON(record))+256>1800000)fail('METADATA_LIMIT',413);
  await stageSynthetic(db,userId,op,rootId,[record]);
  if(!subtracted.present)await db.prepare(`UPDATE personal_restore_records SET classification='REMOVE' WHERE user_id=? AND operation_id=? AND root_id=? AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,rootId,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
 }
}
async function undo(db,userId,op,state,p){
 exactFields(p,['localBinding','confirm','undoDigest','baseRevision']);
 if(op.state!=='UNDO_READY'||p.confirm!==true||p.undoDigest!==op.confirm_hash||p.baseRevision!==op.pinned_revision||!pinMatches(op,state))fail('CONFIRMATION_INVALID');live(op);
 const version=state.sync_version+1,token=crypto.randomUUID(),stamp=now();if(!int(version))fail('REVISION_LIMIT');
 const previous=JSON.parse(op.outcome_json),outcome={...previous,status:'UNDONE',undoRevision:version,undoDigest:op.confirm_hash,updatedAt:stamp},encoded=storageJSON(outcome);if(portableBytes(encoded)+2048>1800000)fail('RECEIPT_LIMIT',413);
 const guard=[userId,op.operation_id,'UNDONE',token,version,token];
 const cas=db.prepare(`UPDATE sync_account_state SET revision=?,write_token=?,updated_at=? WHERE user_id=? AND revision=? AND write_token=? AND storage_schema_version=1 AND write_status='ACTIVE' AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL) AND EXISTS(SELECT 1 FROM personal_restore_operations o WHERE o.user_id=? AND o.operation_id=? AND o.state='UNDO_READY' AND o.generation_version=? AND o.confirm_hash=? AND o.expires_at>?)`).bind(version,token,stamp,userId,state.sync_version,state.write_token,userId,userId,op.operation_id,op.generation_version,op.confirm_hash,stamp);
 const owner=db.prepare(`UPDATE personal_restore_operations SET state='UNDONE',generation_id=?,undo_revision=?,updated_at=? WHERE user_id=? AND operation_id=? AND state='UNDO_READY' AND generation_version=? AND expires_at>? AND ${RECORD_WRITE_GATE_SQL}`).bind(token,version,stamp,userId,op.operation_id,op.generation_version,stamp,userId,version,token);
 const reverse=db.prepare(`UPDATE sync_records AS r SET tombstone=1,deleted_revision=?,modified_revision=? WHERE r.user_id=? AND EXISTS(SELECT 1 FROM personal_restore_identity_journal j INDEXED BY personal_restore_journal_target WHERE j.user_id=r.user_id AND j.operation_id=? AND j.disposition='ADDED' AND j.state='LIVE' AND j.kind<>'metadataPath' AND j.target_kind=r.kind AND j.target_key=r.record_key) AND ${publicationGate}`).bind(version,version,userId,op.operation_id,...guard);
 const metadata=db.prepare(`UPDATE sync_records AS r SET payload_json=(SELECT payload_json FROM personal_restore_records s WHERE s.user_id=r.user_id AND s.operation_id=? AND s.publish_kind='metadata' AND s.record_key=r.record_key),modified_revision=?,tombstone=CASE WHEN EXISTS(SELECT 1 FROM personal_restore_records s WHERE s.user_id=r.user_id AND s.operation_id=? AND s.record_key=r.record_key AND s.classification='REMOVE')THEN 1 ELSE 0 END,deleted_revision=CASE WHEN EXISTS(SELECT 1 FROM personal_restore_records s WHERE s.user_id=r.user_id AND s.operation_id=? AND s.record_key=r.record_key AND s.classification='REMOVE')THEN ? ELSE NULL END WHERE r.user_id=? AND r.kind='metadata' AND EXISTS(SELECT 1 FROM personal_restore_records s WHERE s.user_id=r.user_id AND s.operation_id=? AND s.record_key=r.record_key AND s.publish_kind='metadata') AND ${publicationGate}`).bind(op.operation_id,version,op.operation_id,op.operation_id,version,userId,op.operation_id,...guard);
 const ledger=db.prepare(`UPDATE personal_restore_identity_journal SET state='UNDONE' WHERE user_id=? AND operation_id=? AND disposition='ADDED' AND state='LIVE' AND ${publicationGate}`).bind(userId,op.operation_id,...guard);
 const receipt=db.prepare(`UPDATE personal_restore_operations SET outcome_json=?,progress_json=NULL WHERE user_id=? AND operation_id=? AND ${publicationGate}`).bind(encoded,userId,op.operation_id,...guard);
 const statements=[cas,owner,reverse,metadata,ledger,receipt];for(const table of ['personal_restore_records','personal_restore_roots','personal_restore_chunks'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND operation_id=? AND ${publicationGate}`).bind(userId,op.operation_id,...guard));
 const result=await db.batch(statements),stored=await operation(db,userId,op.operation_id,op.purpose);
 if(result[0].meta.changes!==1||result[1].meta.changes!==1){if(stored.state==='UNDONE'&&stored.confirm_hash===p.undoDigest&&stored.outcome_json)return JSON.parse(stored.outcome_json);fail('REVISION_CHANGED');}
 if(!stored.outcome_json)fail('RECEIPT_NOT_READY',503);return JSON.parse(stored.outcome_json);
}
async function matchingStage(db,userId,op,rows){
 const keys=storageJSON(rows.map(r=>({kind:r.kind,key:r.record_key})));if(portableBytes(keys)>1800000)fail('PROOF_LIMIT',413);
 const fields=['kind','record_key','address_json','payload_json','root_id','item_ordinal'];
 const output=(await db.prepare(`WITH candidates AS(SELECT ${fields.map(f=>`r.${f}`).join(',')} FROM json_each(?)v CROSS JOIN personal_restore_records r INDEXED BY personal_restore_record_target WHERE r.publish_kind=json_extract(v.value,'$.kind') AND r.record_key=json_extract(v.value,'$.key') AND user_id=? AND operation_id=? AND root_id>=0 AND publish_kind IS NOT NULL),bounds AS(SELECT SUM(length(CAST(json_object(${fields.map(f=>`'${f}',${f}`).join(',')})AS BLOB))+1)+2 AS bytes FROM candidates) SELECT ${fields.join(',')} FROM candidates WHERE COALESCE((SELECT bytes FROM bounds),2)<=1799998 AND ${pinnedGate} UNION ALL SELECT ${fields.map(()=> 'NULL').join(',')} WHERE(SELECT bytes FROM bounds)>1799998`).bind(keys,userId,op.operation_id,userId,op.pinned_revision,op.pinned_token||'').all()).results;
 if(output.some(r=>r.kind===null))fail('PROOF_LIMIT',413);return output;
}
async function finalizeSync(db,userId,op,state,p){
 if(!pinMatches(op,state)||op.base_revision!==state.sync_version)fail('REVISION_CHANGED');
 if(op.state==='SYNC_READY')return {operationId:op.operation_id,status:'READY',semanticDigest:op.semantic_hash,confirmationDigest:op.preview_hash,baseRevision:op.pinned_revision};
 if(op.state==='FROZEN'){
  op=await beginProgress(db,userId,op,state,'sync-check',{state:'SYNC_CHECKING'});const progress=JSON.parse(op.progress_json);progress.proof=await proofSeed(op);op=await saveProgress(db,userId,op,progress);
  await db.prepare(`UPDATE personal_restore_roots SET selected=1,classification='NEW' WHERE user_id=? AND operation_id=? AND root_id>=0 AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
  await db.prepare(`UPDATE personal_restore_records SET selected=1,classification='NEW' WHERE user_id=? AND operation_id=? AND root_id>=0 AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'').run();
  if(!state.write_token)await bootstrapBaseline(db,userId,op,state);
  return progressReply(op,progress);
 }
 if(p.generationId!==op.generation_id)fail('GENERATION_CHANGED');let progress=JSON.parse(op.progress_json),done=false;
 const present=(await db.prepare("SELECT DISTINCT publish_kind AS kind FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND publish_kind IN('session','program','measurement') UNION SELECT CASE json_extract(address_json,'$.field')WHEN 'sessions'THEN 'session' WHEN 'programs'THEN 'program' WHEN 'measurements'THEN 'measurement' END AS kind FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND publish_kind='metadata' AND json_extract(address_json,'$.collection')=1").bind(userId,op.operation_id,userId,op.operation_id).all()).results.map(r=>r.kind);
 for(let page=0;page<4;page++){
  const rows=await currentPage(db,userId,op,progress.proof);if(!rows.length){done=true;break;}
  const next=await matchingStage(db,userId,op,rows),updates=[];
  for(const row of rows){
   const after=next.find(r=>r.kind===row.kind&&r.record_key===row.record_key);let touches=Boolean(after)||present.includes(row.kind)||row.kind==='set'&&present.includes('session');
   if(row.kind==='metadata'&&!after)touches=false;
   if(touches){const value=compatibleStorageRow(row,after,op.data_schema_version);if(after){const payload=storageJSON(value);updates.push({root:after.root_id,item:after.item_ordinal,payload,classification:payload===row.payload_json&&after.address_json===row.address_json?'SAME':'NEW'});}
    progress.chain=await portableHash(['reptrio-normal-stage-compatibility-v1',progress.chain,row.kind,row.record_key,await portableHash(JSON.parse(row.payload_json)),after?await portableHash(value):null]);
   }
   progress.proof.lastKind=row.kind;progress.proof.lastKey=row.record_key;progress.processed++;
  }
  if(updates.length){const encoded=storageJSON(updates);if(portableBytes(encoded)>1800000)fail('PROOF_LIMIT',413);
   const update=db.prepare(`WITH updates AS MATERIALIZED(SELECT json_extract(value,'$.root')AS root_id,json_extract(value,'$.item')AS item_ordinal,json_extract(value,'$.payload')AS payload_json,json_extract(value,'$.classification')AS classification FROM json_each(?)) UPDATE personal_restore_records AS r SET payload_json=u.payload_json,classification=u.classification FROM updates u WHERE r.user_id=? AND r.operation_id=? AND r.root_id=u.root_id AND r.item_ordinal=u.item_ordinal AND ${statementGate} AND ${pinnedGate}`).bind(encoded,userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||'');
   // The checkpoint owns exactly these row classifications; loser requests cannot publish them.
   const advance=db.prepare(`UPDATE personal_restore_operations SET progress_json=?,generation_version=generation_version+1 WHERE user_id=? AND operation_id=? AND generation_version=? AND state='SYNC_CHECKING' AND expires_at>? AND ${pinnedGate}`).bind(storageJSON(progress),userId,op.operation_id,op.generation_version,now(),userId,op.pinned_revision,op.pinned_token||'');const result=await db.batch([update,advance]);if(result[1].meta.changes!==1)fail('GENERATION_CHANGED');op={...op,generation_version:op.generation_version+1};
  }else op=await saveProgress(db,userId,op,progress);
 }
 if(!done)return progressReply(op,progress);
 const tombstone=await db.prepare('SELECT COUNT(*) AS count FROM personal_restore_records r JOIN sync_records s ON s.user_id=r.user_id AND s.kind=r.publish_kind AND s.record_key=r.record_key WHERE r.user_id=? AND r.operation_id=? AND r.root_id>=0 AND s.tombstone=1').bind(userId,op.operation_id).first();if(tombstone.count)fail('SYNC_RECORD_DELETED');
 const schema=await db.prepare("SELECT payload_json FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND publish_kind='metadata' AND record_key='[\"schemaVersion\"]'").bind(userId,op.operation_id).first();if(schema&&JSON.parse(schema.payload_json)!==op.data_schema_version)fail('SYNC_SCHEMA_INVALID');
 if(op.data_schema_version===5){const incompatible=await db.prepare("SELECT MAX(CASE WHEN tombstone=0 AND((kind='session' AND COALESCE(json_extract(address_json,'$.container'),'absent')<>'array')OR(kind='program' AND COALESCE(json_extract(payload_json,'$.schemaVersion'),'absent')<>'1.0')OR(kind='metadata' AND record_key='[\"schemaVersion\"]' AND payload_json<>'5'))THEN 1 ELSE 0 END)AS blocked FROM sync_records WHERE user_id=?").bind(userId).first();if(incompatible.blocked)fail('SYNC_CLIENT_UPGRADE_REQUIRED');}
 await prepareMarkers(db,userId,op);
 const confirmation=await portableHash(['reptrio-normal-stage-ready-v1',op.operation_id,op.semantic_hash,op.local_binding,op.pinned_revision,op.pinned_token,op.expires_at,progress.chain,progress.processed]);op=await saveProgress(db,userId,op,progress,{state:'SYNC_READY',preview_hash:confirmation});return {operationId:op.operation_id,status:'READY',semanticDigest:op.semantic_hash,confirmationDigest:confirmation,baseRevision:op.pinned_revision};
}
async function commitSync(db,userId,op,state,p){
 exactFields(p,['localBinding','confirm','confirmationDigest','semanticDigest','baseRevision']);
 if(op.state!=='SYNC_READY'||p.confirm!==true||p.confirmationDigest!==op.preview_hash||p.semanticDigest!==op.semantic_hash||p.baseRevision!==op.pinned_revision||!pinMatches(op,state))fail('CONFIRMATION_INVALID');
 await allocateOrdinals(db,userId,op);const version=state.sync_version+1,token=crypto.randomUUID(),stamp=now();if(!int(version))fail('REVISION_LIMIT');
 const counts=(await db.prepare('SELECT kind,classification,COUNT(*)AS count FROM personal_restore_records WHERE user_id=? AND operation_id=? AND root_id>=0 AND publish_kind IS NOT NULL GROUP BY kind,classification').bind(userId,op.operation_id).all()).results;
 const outcome={operationId:op.operation_id,purpose:'SYNC',status:'COMMITTED',semanticDigest:op.semantic_hash,confirmationDigest:op.preview_hash,baseRevision:op.pinned_revision,committedRevision:version,localBinding:op.local_binding,counts,updatedAt:stamp},encoded=storageJSON(outcome);if(portableBytes(encoded)+2048>1800000)fail('RECEIPT_LIMIT',413);
 const guard=[userId,op.operation_id,'COMMITTED',token,version,token],ready=`EXISTS(SELECT 1 FROM personal_restore_operations o WHERE o.user_id=? AND o.operation_id=? AND o.state='SYNC_READY' AND o.generation_version=? AND o.preview_hash=? AND o.expires_at>?)`;
 const cas=state.write_token?db.prepare(`UPDATE sync_account_state SET revision=?,write_token=?,updated_at=? WHERE user_id=? AND revision=? AND write_token=? AND storage_schema_version=1 AND write_status='ACTIVE' AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL) AND ${ready}`).bind(version,token,stamp,userId,state.sync_version,state.write_token,userId,userId,op.operation_id,op.generation_version,op.preview_hash,stamp):db.prepare(`INSERT INTO sync_account_state(user_id,storage_schema_version,revision,write_token,write_status,updated_at)SELECT ?,1,?,?,'ACTIVE',? WHERE ${pinnedGate} AND NOT EXISTS(SELECT 1 FROM sync_account_state WHERE user_id=?) AND ${ready}`).bind(userId,version,token,stamp,userId,state.sync_version,'',userId,userId,op.operation_id,op.generation_version,op.preview_hash,stamp);
 const owner=db.prepare(`UPDATE personal_restore_operations SET state='COMMITTED',generation_id=?,committed_revision=?,updated_at=? WHERE user_id=? AND operation_id=? AND state='SYNC_READY' AND generation_version=? AND expires_at>? AND ${RECORD_WRITE_GATE_SQL}`).bind(token,version,stamp,userId,op.operation_id,op.generation_version,stamp,userId,version,token);
 const publish=db.prepare(`INSERT INTO sync_records(user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision,tombstone,deleted_revision)SELECT r.user_id,r.publish_kind,r.record_key,r.parent_key,r.target_ordinal,r.address_json,r.payload_json,?, ?,0,NULL FROM personal_restore_records r WHERE r.user_id=? AND r.operation_id=? AND r.publish_kind IS NOT NULL AND r.classification='NEW' AND r.selected=1 AND ${publicationGate} ON CONFLICT(user_id,kind,record_key)DO UPDATE SET parent_key=excluded.parent_key,ordinal=excluded.ordinal,payload_json=excluded.payload_json,address_json=excluded.address_json,modified_revision=excluded.modified_revision WHERE sync_records.tombstone=0`).bind(version,version,userId,op.operation_id,...guard);
 const absent=db.prepare(`UPDATE sync_records AS s SET tombstone=1,deleted_revision=?,modified_revision=? WHERE s.user_id=? AND s.tombstone=0 AND s.kind IN('session','program','measurement','set') AND EXISTS(SELECT 1 FROM personal_restore_records r WHERE r.user_id=s.user_id AND r.operation_id=? AND r.root_id>=0 AND(r.publish_kind=CASE WHEN s.kind='set'THEN 'session' ELSE s.kind END OR(r.publish_kind='metadata' AND json_extract(r.address_json,'$.collection')=1 AND json_extract(r.address_json,'$.field')=CASE s.kind WHEN 'session'THEN 'sessions' WHEN 'set'THEN 'sessions' WHEN 'program'THEN 'programs' WHEN 'measurement'THEN 'measurements' END))) AND NOT EXISTS(SELECT 1 FROM personal_restore_records n INDEXED BY personal_restore_record_target WHERE n.user_id=s.user_id AND n.operation_id=? AND n.root_id>=0 AND n.publish_kind=s.kind AND n.record_key=s.record_key) AND ${publicationGate}`).bind(version,version,userId,op.operation_id,op.operation_id,...guard);
 const receipt=db.prepare(`UPDATE personal_restore_operations SET outcome_json=?,progress_json=NULL WHERE user_id=? AND operation_id=? AND ${publicationGate}`).bind(encoded,userId,op.operation_id,...guard);
 const statements=[cas,owner,publish,absent,receipt];for(const table of ['personal_restore_records','personal_restore_roots','personal_restore_chunks'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND operation_id=? AND ${publicationGate}`).bind(userId,op.operation_id,...guard));
 const results=await db.batch(statements),stored=await operation(db,userId,op.operation_id,'SYNC');if(results[0].meta.changes!==1||results[1].meta.changes!==1){if(stored.state==='COMMITTED'&&stored.preview_hash===p.confirmationDigest&&stored.outcome_json)return JSON.parse(stored.outcome_json);fail('REVISION_CHANGED');}if(!stored.outcome_json)fail('RECEIPT_NOT_READY',503);return JSON.parse(stored.outcome_json);
}
async function clearSynthetic(db,userId,op){
 const statements=[];for(const table of ['personal_restore_records','personal_restore_roots'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND operation_id=? AND root_id IN(-2,-3,-4) AND ${statementGate} AND ${pinnedGate}`).bind(userId,op.operation_id,userId,op.operation_id,op.generation_version,op.state,now(),userId,op.pinned_revision,op.pinned_token||''));await db.batch(statements);
}
function samePortableAddress(kind,a,b){
 const before=JSON.parse(a),after=JSON.parse(b);if(kind==='session'){delete before.fields;delete after.fields;}return canonicalPortable(before)===canonicalPortable(after);
}
const rawProofHash=value=>byteHash(new TextEncoder().encode(storageJSON(value)));
