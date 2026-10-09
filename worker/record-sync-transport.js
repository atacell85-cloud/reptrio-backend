import { storageJSON } from './record-sync-storage.js';
import { storageTables, recordSchemaStatus, receiptSchemaStatus, readRecordState, boundedBody, inspect, compatible, splitData, assembleRecordData, recordChunks, RECORD_WRITE_GATE_SQL, LIMITS } from './record-sync-storage.js';
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).byteLength;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (obj,key) => Object.hasOwn(obj,key);
const fail = (code,status=409) => { throw Object.assign(new Error(code),{code,status}); };
const json = (value,status=200) => new Response(storageJSON(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const reject = cause => json({code:typeof cause.code==='string' && cause.code.startsWith('SYNC_') ? cause.code : 'SYNC_STORAGE_UNAVAILABLE'},cause.status || 503);
const fields = { programs:'program',sessions:'session',measurements:'measurement' };
const rootKinds = Object.values(fields);
const idKey = id => JSON.stringify([id]);
const identity = row => JSON.stringify([row.kind,row.record_key]);
const int = value => Number.isSafeInteger(value) && value >= 0;
export const TRANSPORT_LIMITS = Object.freeze({ pageRows:256,pageBytes:1_900_000,cursorBytes:16_384,cursorTTL:900_000,receiptTTL:3_600_000,roots:128,order:8,mutationQueries:30,cleanup:256 });
async function ready(env) {
  if (env.RECORD_TRANSPORT_ENABLED === 'false') fail('SYNC_TRANSPORT_DISABLED',503);
  const tables = await storageTables(env.DB);
  const storage = recordSchemaStatus(tables), receipts = receiptSchemaStatus(tables);
  if (storage !== 'ready') fail(storage === 'missing' ? 'SYNC_STORAGE_MIGRATION_REQUIRED' : 'SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
  if (receipts !== 'ready') fail(receipts === 'missing' ? 'SYNC_TRANSPORT_MIGRATION_REQUIRED' : 'SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
}
const authority = state => { if (!state.write_token) fail('SYNC_RECORD_AUTHORITY_REQUIRED'); };
const b64 = array => btoa(String.fromCharCode(...array)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function unb64(value) { if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('SYNC_CURSOR_INVALID',400); try { return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),x=>x.charCodeAt(0)); } catch { fail('SYNC_CURSOR_INVALID',400); } }
async function macKey(state) { return crypto.subtle.importKey('raw',encoder.encode(`reptrio-record-page-v1\0${state.write_token}`),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
const cursorInput = (userId,canonical) => encoder.encode(JSON.stringify(['reptrio-record-page-v1',userId,canonical]));
async function signCursor(state,userId,tuple) {
  const canonical = JSON.stringify(tuple);
  if (bytes(canonical) > TRANSPORT_LIMITS.cursorBytes / 2) fail('SYNC_CURSOR_LIMIT',413);
  return `${b64(encoder.encode(canonical))}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC',await macKey(state),cursorInput(userId,canonical))))}`;
}
async function decodeCursor(value,state,userId) {
  if (typeof value !== 'string' || value.length > TRANSPORT_LIMITS.cursorBytes) fail('SYNC_CURSOR_INVALID',400);
  const parts = value.split('.'); if (parts.length !== 2) fail('SYNC_CURSOR_INVALID',400);
  let tuple, canonical;
  try { canonical = new TextDecoder('utf-8',{fatal:true}).decode(unb64(parts[0])); tuple = JSON.parse(canonical); } catch { fail('SYNC_CURSOR_INVALID',400); }
  if (!Array.isArray(tuple) || tuple.length !== 10 || JSON.stringify(tuple) !== canonical || tuple[0] !== 1 || tuple[1] !== 1 || tuple[3] !== 'all' || !int(tuple[2]) || !rootKinds.concat(['metadata','set']).includes(tuple[4]) || typeof tuple[5] !== 'string' || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(tuple[5]) || BigInt(tuple[5]) < -9223372036854775808n || BigInt(tuple[5]) > 9223372036854775807n || typeof tuple[6] !== 'string' || !/^[a-f0-9]{64}$/.test(tuple[6]) || !int(tuple[7]) || !int(tuple[8]) || tuple[7] < 1 || tuple[7] >= tuple[8] || !int(tuple[9])) fail('SYNC_CURSOR_INVALID',400);
  if (tuple[2] !== state.revision) fail('SYNC_SNAPSHOT_CHANGED');
  if (!(await crypto.subtle.verify('HMAC',await macKey(state),unb64(parts[1]),cursorInput(userId,canonical)))) fail('SYNC_CURSOR_INVALID',400);
  if (tuple[9] <= Date.now() || tuple[9] > Date.now() + TRANSPORT_LIMITS.cursorTTL) fail('SYNC_CURSOR_EXPIRED');
  return tuple;
}
// State, count and byte/row bounded keyset page are observed in ONE SQL snapshot. Window arithmetic
// runs on record lengths/keys; no account-wide JSON aggregation or payload crosses D1 before bounding.
const PAGE_SQL = `WITH candidates AS (
 SELECT r.kind,r.record_key,
   length(CAST(json_object('kind',r.kind,'record_key',r.record_key,'parent_key',r.parent_key,'ordinal',r.ordinal,'address_json',r.address_json,'payload_json',r.payload_json,'created_revision',r.created_revision,'modified_revision',r.modified_revision,'tombstone',r.tombstone,'deleted_revision',r.deleted_revision) AS BLOB))+1 AS encoded_bytes
 FROM sync_records r WHERE r.user_id=? AND (r.kind>? OR (r.kind=? AND r.record_key>?)) ORDER BY r.kind,r.record_key LIMIT 256
), bounded AS (SELECT *, SUM(encoded_bytes) OVER (ORDER BY kind,record_key) AS cumulative_bytes FROM candidates),
 totals AS (SELECT count(*) AS total FROM sync_records WHERE user_id=?)
 SELECT s.storage_schema_version,s.revision,s.write_token,s.write_status,s.updated_at,u.deleted_at,t.total,
 r.kind,r.record_key,r.parent_key,r.ordinal,r.address_json,r.payload_json,r.created_revision,r.modified_revision,r.tombstone,r.deleted_revision,CAST(r.rowid AS TEXT) AS locator,
 CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (SELECT 1 FROM sync_records a WHERE a.user_id=s.user_id AND a.rowid=CAST(? AS INTEGER) AND a.kind=? AND a.record_key=?) END AS anchor_valid
 FROM sync_account_state s JOIN users u ON u.id=s.user_id CROSS JOIN totals t
 LEFT JOIN bounded b ON b.cumulative_bytes<=1880000
 LEFT JOIN sync_records r ON r.user_id=s.user_id AND r.kind=b.kind AND r.record_key=b.record_key
 WHERE s.user_id=? ORDER BY r.kind,r.record_key`;
export async function recordPage(request,env,userId) {
  try {
    await ready(env); let state = await readRecordState(env.DB,userId); authority(state);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key=>key!=='cursor')) fail('SYNC_PAGE_INVALID',400);
    const cursor = url.searchParams.get('cursor'); let tuple = cursor ? await decodeCursor(cursor,state,userId) : null;
    let anchorKey='';
    if (tuple) {
      const anchor=await env.DB.prepare('SELECT record_key FROM sync_records WHERE user_id=? AND rowid=CAST(? AS INTEGER) AND kind=?').bind(userId,tuple[5],tuple[4]).first();
      if (!anchor || await keyDigest(anchor.record_key)!==tuple[6]) fail('SYNC_SNAPSHOT_CHANGED');
      anchorKey=anchor.record_key;
    }
    let rows;
    for (let attempt=0;attempt<2;attempt++) {
      rows = (await env.DB.prepare(PAGE_SQL).bind(userId,tuple?.[4] || '',tuple?.[4] || '',anchorKey,userId,tuple?.[5] || null,tuple?.[5] || null,tuple?.[4] || '',anchorKey,userId).all()).results;
      const observed = rows?.[0];
      if (!observed || observed.deleted_at !== null || observed.write_status !== 'ACTIVE') fail('SYNC_ACCOUNT_BLOCKED');
      if (observed.anchor_valid !== 1) fail('SYNC_SNAPSHOT_CHANGED');
      if (observed.storage_schema_version !== 1) fail('SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
      if (observed.revision === state.revision && observed.write_token === state.write_token) break;
      if (cursor || attempt === 1) fail('SYNC_SNAPSHOT_CHANGED');
      state = await readRecordState(env.DB,userId); authority(state);
    }
    const total = rows[0].total; if (!int(total) || (tuple && tuple[8] !== total)) fail('SYNC_SNAPSHOT_CHANGED');
    const records = rows.filter(row=>row.kind !== null).map(({storage_schema_version,revision,write_token,write_status,updated_at,deleted_at,total,locator,anchor_valid,...record})=>record);
    const start = tuple?.[7] || 0, cumulative = start + records.length;
    if (cumulative > total || (!records.length && cumulative < total)) fail('SYNC_PAGE_LIMIT',413);
    const terminal = cumulative === total;
    const last = records.at(-1);
    const continuation = terminal ? null : await signCursor(state,userId,[1,1,state.revision,'all',last.kind,rows.filter(row=>row.kind!==null).at(-1).locator,await keyDigest(last.record_key),cumulative,total,tuple?.[9] || Date.now()+TRANSPORT_LIMITS.cursorTTL]);
    const result = {protocol:1,storageSchemaVersion:1,mode:'all',syncVersion:state.revision,updatedAt:state.updated_at,total,start,cumulative,terminal,continuation,records};
    if (bytes(JSON.stringify(result)) > TRANSPORT_LIMITS.pageBytes) fail('SYNC_PAGE_LIMIT',413);
    return json(result);
  } catch(cause) { return reject(cause); }
}
async function keyDigest(key) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(key))),x=>x.toString(16).padStart(2,'0')).join(''); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(canonical(value)))),x=>x.toString(16).padStart(2,'0')).join(''); }
function validateEnvelope(p) {
  if (!object(p) || Object.keys(p).some(key=>!['mutationId','baseRevision','clientSchemaVersion','upserts','deletes','metadata','order'].includes(key))) fail('SYNC_MUTATION_INVALID',400);
  if (typeof p.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.mutationId) || !int(p.baseRevision) || p.baseRevision === Number.MAX_SAFE_INTEGER) fail('SYNC_MUTATION_INVALID',400);
  if (![5,8].includes(p.clientSchemaVersion)) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
  const touched = [], seen = new Set();
  for (const container of ['upserts','deletes']) {
    if (own(p,container) && (!object(p[container]) || Object.keys(p[container]).some(field=>!own(fields,field)))) fail('SYNC_MUTATION_INVALID',400);
    for (const [field,entries] of Object.entries(p[container] || {})) {
      if (!Array.isArray(entries)) fail('SYNC_MUTATION_INVALID',400);
      for (const entry of entries) {
        const id = container === 'deletes' ? entry : entry?.id;
        if (typeof id !== 'string' || !id.length) fail('SYNC_RECORD_ID_INVALID',400);
        const item = {kind:fields[field],key:idKey(id),field,id,deleted:container==='deletes'};
        const key=JSON.stringify([item.kind,item.key]); if (seen.has(key)) fail('SYNC_RECORD_ID_DUPLICATE',400); seen.add(key); touched.push(item);
      }
    }
  }
  if ((own(p,'metadata') && !object(p.metadata)) || Object.keys(p.metadata || {}).some(field=>own(fields,field) || field==='schemaVersion')) fail('SYNC_MUTATION_INVALID',400);
  if (touched.length > TRANSPORT_LIMITS.roots || Object.keys(p.metadata || {}).length > TRANSPORT_LIMITS.roots) fail('SYNC_STRUCTURE_LIMIT',413);
  if (own(p,'order') && !Array.isArray(p.order)) fail('SYNC_ORDER_INVALID',400);
  const order = p.order || []; if (order.length > TRANSPORT_LIMITS.order) fail('SYNC_ORDER_LIMIT',413);
  const moved = new Set(), edges = new Map();
  for (const command of order) {
    if (!object(command) || Object.keys(command).some(key=>!['kind','key','anchor','placement'].includes(key)) || !rootKinds.includes(command.kind) || typeof command.key !== 'string' || !command.key.length || typeof command.anchor !== 'string' || !command.anchor.length || command.key===command.anchor || !['before','after'].includes(command.placement)) fail('SYNC_ORDER_INVALID',400);
    const key=JSON.stringify([command.kind,command.key]); if (moved.has(key)) fail('SYNC_ORDER_INVALID',400); moved.add(key);
    const a=command.placement==='before' ? key : JSON.stringify([command.kind,command.anchor]), b=command.placement==='before' ? JSON.stringify([command.kind,command.anchor]) : key;
    if (!edges.has(a)) edges.set(a,[]); edges.get(a).push(b);
  }
  const visit = (key,path=new Set()) => { if (path.has(key)) fail('SYNC_ORDER_INVALID',400); for (const next of edges.get(key) || []) visit(next,new Set([...path,key])); }; for(const key of edges.keys()) visit(key);
  return {touched,order};
}
const touchedPredicate = `((r.kind <> 'set' AND EXISTS (SELECT 1 FROM json_each(?) j WHERE r.kind=json_extract(j.value,'$.kind') AND r.record_key=json_extract(j.value,'$.key'))) OR (r.kind='set' AND r.parent_key IN (SELECT json_extract(j.value,'$.key') FROM json_each(?) j WHERE json_extract(j.value,'$.kind')='session')) OR (r.kind='metadata' AND r.record_key IN (SELECT value FROM json_each(?))))`;
// Exact explicit projection: raw JSON columns remain STRINGS, so quote/backslash/UTF-8
// expansion and repeated parent keys count before any personal row crosses D1.
const TOUCHED_FIELDS=['user_id','kind','record_key','parent_key','ordinal','address_json','payload_json','created_revision','modified_revision','tombstone','deleted_revision'];
const touchedJSON=TOUCHED_FIELDS.map(field=>`'${field}',r.${field}`).join(',');
async function touchedRows(db,userId,touched,metadataKeys,state) {
  const roots=JSON.stringify(touched),meta=JSON.stringify(metadataKeys);
  if(bytes(roots)>LIMITS.chunkBytes || bytes(meta)>LIMITS.chunkBytes)fail('SYNC_ROOT_LIMIT',413);
  const columns=TOUCHED_FIELDS.map(field=>`r.${field}`).join(',');
  // Null status columns are part of every returned personal row's exact JSON sizing. The numeric-only sentinel uses the exact count and seven-digit allowed-byte ceiling
  // for its byte field: every successful bounded_bytes value has <=7 digits. Add exact array framing.
  const owner=`s.revision=? AND s.write_token=? AND s.storage_schema_version=1 AND s.write_status='ACTIVE' AND u.id IS NOT NULL AND u.deleted_at IS NULL`;
  const sql=`WITH touched AS (SELECT ${columns} FROM sync_records r WHERE r.user_id=? AND ${touchedPredicate}),
    measured AS (SELECT count(*) AS count,COALESCE(SUM(length(CAST(json_object(${touchedJSON},'bounded_count',NULL,'bounded_bytes',NULL,'owner_valid',NULL) AS BLOB))+1),0) AS row_bytes FROM touched r),
    checked AS (SELECT b.count,b.row_bytes+length(CAST(json_object(${TOUCHED_FIELDS.map(field=>`'${field}',NULL`).join(',')},'bounded_count',b.count,'bounded_bytes',4000000,'owner_valid',1) AS BLOB))+2 AS bytes,CASE WHEN ${owner} THEN 1 ELSE 0 END AS valid FROM measured b LEFT JOIN sync_account_state s ON s.user_id=? LEFT JOIN users u ON u.id=?)
    SELECT ${TOUCHED_FIELDS.map(field=>`NULL AS ${field}`).join(',')},count AS bounded_count,bytes AS bounded_bytes,valid AS owner_valid FROM checked
    UNION ALL SELECT ${columns},NULL,NULL,NULL FROM touched r CROSS JOIN checked c WHERE c.count<=25000 AND c.bytes<=4000000 AND c.valid=1`;
  const rows=(await db.prepare(sql).bind(userId,roots,roots,meta,state.revision,state.write_token,userId,userId).all()).results;
  const bounds=rows?.[0];if(!bounds || bounds.owner_valid!==1)fail('SYNC_CONFLICT');
  if(bounds.bounded_count>LIMITS.records || bounds.bounded_bytes>LIMITS.dataBytes)fail('SYNC_ROOT_LIMIT',413);
  return rows.slice(1).map(({bounded_count,bounded_bytes,owner_valid,...row})=>row);
}

const chunkSQL = `INSERT INTO sync_records (user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision,tombstone,deleted_revision)
 SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.record_key'),json_extract(value,'$.parent_key'),json_extract(value,'$.ordinal'),json_extract(value,'$.address_json'),json_extract(value,'$.payload_json'),json_extract(value,'$.created_revision'),json_extract(value,'$.modified_revision'),json_extract(value,'$.tombstone'),json_extract(value,'$.deleted_revision') FROM json_each(?) WHERE ${RECORD_WRITE_GATE_SQL}
 ON CONFLICT(user_id,kind,record_key) DO UPDATE SET parent_key=excluded.parent_key,ordinal=excluded.ordinal,address_json=excluded.address_json,payload_json=excluded.payload_json,modified_revision=excluded.modified_revision,tombstone=excluded.tombstone,deleted_revision=excluded.deleted_revision WHERE sync_records.tombstone=0`;
function orderStatement(db,userId,version,token,command) {
  return db.prepare(`WITH ordered AS (SELECT record_key,ROW_NUMBER() OVER (ORDER BY ordinal,record_key) AS pos FROM sync_records WHERE user_id=? AND kind=? AND tombstone=0),
 ranked AS (SELECT record_key,ROW_NUMBER() OVER (ORDER BY CASE WHEN record_key=? THEN (SELECT pos FROM ordered WHERE record_key=?)*2+? ELSE pos*2 END,record_key)-1 AS next_ordinal FROM ordered)
 UPDATE sync_records SET ordinal=(SELECT next_ordinal FROM ranked WHERE ranked.record_key=sync_records.record_key),modified_revision=?
 WHERE user_id=? AND kind=? AND tombstone=0 AND ordinal<>(SELECT next_ordinal FROM ranked WHERE ranked.record_key=sync_records.record_key) AND ${RECORD_WRITE_GATE_SQL}`)
    .bind(userId,command.kind,idKey(command.key),idKey(command.anchor),command.placement==='before' ? -1 : 1,version,userId,command.kind,userId,version,token);
}
// Plan only ordinal headers, never personal payloads. This mirrors declared sequential moves so
// receipt UTF-8 bytes and final root ordinals are known BEFORE the first SQL write.
async function plannedOrdinals(db,userId,changes,roots,order,oldRows) {
  const requested=new Set(JSON.parse(roots).map(r=>JSON.stringify([r.kind,r.key])));
  if (!order.length) {
    const rows=new Map(oldRows.filter(r=>rootKinds.includes(r.kind)).map(r=>[identity(r),r]));
    for(const r of changes)if(rootKinds.includes(r.kind))rows.set(identity(r),r);
    return [...rows.values()].filter(r=>requested.has(identity(r))).sort((a,b)=>a.kind.localeCompare(b.kind)||a.record_key.localeCompare(b.record_key)).map(r=>({kind:r.kind,key:r.record_key,ordinal:r.ordinal,tombstone:r.tombstone}));
  }
  const headers=JSON.stringify(changes.filter(r=>rootKinds.includes(r.kind)).map(r=>({kind:r.kind,key:r.record_key,ordinal:r.ordinal,tombstone:r.tombstone})));
  if(bytes(headers)>LIMITS.chunkBytes)fail('SYNC_ROOT_LIMIT',413);
  const ctes=[`o0 AS (SELECT kind,record_key,ordinal,tombstone FROM sync_records WHERE user_id=? AND kind IN ('program','session','measurement') AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE kind=json_extract(j.value,'$.kind') AND record_key=json_extract(j.value,'$.key')) UNION ALL SELECT json_extract(value,'$.kind'),json_extract(value,'$.key'),json_extract(value,'$.ordinal'),json_extract(value,'$.tombstone') FROM json_each(?))`];
  const binds=[userId,headers,headers];
  order.forEach((c,i)=>{
    ctes.push(`p${i} AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY kind ORDER BY ordinal,record_key) AS pos FROM o${i} WHERE tombstone=0)`);
    ctes.push(`o${i+1} AS (SELECT kind,record_key,CASE WHEN kind=? THEN ROW_NUMBER() OVER (PARTITION BY kind ORDER BY CASE WHEN kind=? AND record_key=? THEN (SELECT pos FROM p${i} WHERE kind=? AND record_key=?)*2+? ELSE pos*2 END,record_key)-1 ELSE ordinal END AS ordinal,tombstone FROM p${i} UNION ALL SELECT kind,record_key,ordinal,tombstone FROM o${i} WHERE tombstone=1)`);
    binds.push(c.kind,c.kind,idKey(c.key),c.kind,idKey(c.anchor),c.placement==='before'?-1:1);
  });
  const sql=`WITH ${ctes.join(',')} SELECT kind,record_key AS key,ordinal,tombstone FROM o${order.length} WHERE EXISTS (SELECT 1 FROM json_each(?) j WHERE kind=json_extract(j.value,'$.kind') AND record_key=json_extract(j.value,'$.key')) ORDER BY kind,record_key`;
  binds.push(roots);if(binds.length>100 || bytes(sql)>100_000 || binds.some(v=>typeof v==='string' && bytes(v)>LIMITS.chunkBytes))fail('SYNC_ORDER_LIMIT',413);
  return (await db.prepare(sql).bind(...binds).all()).results;
}
// Validate every derived bound string/SQL before first use, including dynamically planned key lists.
function mutationDB(db) {
  return {batch:statements=>db.batch(statements),prepare(sql) {
    if(bytes(sql)>100_000)fail('SYNC_QUERY_LIMIT',413);
    return {bind(...values) {
      if(values.length>100 || values.some(value=>typeof value==='string' && bytes(value)>LIMITS.chunkBytes))fail('SYNC_ROOT_LIMIT',413);
      return db.prepare(sql).bind(...values);
    }};
  }};
}
export async function recordMutation(request,env,userId) {
  try {
    const p=await boundedBody(request); inspect(p); if(bytes(JSON.stringify(p))>LIMITS.dataBytes) fail('SYNC_PAYLOAD_INVALID',413); const {touched,order}=validateEnvelope(p); const requestHash=await digest(p);
    await ready(env); const db=mutationDB(env.DB);
    const state=await readRecordState(db,userId,p.mutationId); authority(state);
    const receipt=state.request_hash ? state : null;
    if (receipt && receipt.expires_at > new Date().toISOString()) { if (receipt.request_hash !== requestHash) fail('SYNC_MUTATION_ID_CONFLICT'); if(receipt.base_revision!==p.baseRevision || receipt.committed_revision!==p.baseRevision+1) fail('SYNC_STORAGE_UNAVAILABLE',503); return json(JSON.parse(receipt.outcome_json)); }
    if (state.revision !== p.baseRevision) fail('SYNC_CONFLICT');
    const metadataFields=new Set(['schemaVersion',...touched.map(item=>item.field),...Object.keys(p.metadata || {})]);
    const oldRows=await touchedRows(db,userId,touched,[...metadataFields].map(idKey),state);
    const previous=assembleRecordData(oldRows);
    if(previous.schemaVersion===9)fail('SYNC_CLIENT_UPGRADE_REQUIRED');
    // Schema 5 cannot edit an account containing any mobile-only root, even if that root is untouched.
    const maxima=(await db.prepare(`SELECT kind,MAX(ordinal) AS maximum,COUNT(*) AS count,MAX(CASE WHEN tombstone=0 AND ((kind='session' AND COALESCE(json_extract(address_json,'$.container'),'absent')<>'array') OR (kind='program' AND COALESCE(json_extract(payload_json,'$.schemaVersion'),'absent')<>'1.0')) THEN 1 ELSE 0 END) AS pwa_incompatible FROM sync_records WHERE user_id=? GROUP BY kind`).bind(userId).all()).results;
    if (p.clientSchemaVersion===5 && (previous.schemaVersion!==5 || maxima.some(row=>row.pwa_incompatible) || touched.some(item=>item.kind==='measurement'))) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
    const submitted={schemaVersion:p.clientSchemaVersion,...p.metadata};
    for (const field of new Set(touched.map(item=>item.field))) submitted[field]=p.upserts?.[field] || [];
    const nextData=compatible(previous,submitted); const nextRecords=splitData(nextData);
    const old=new Map(oldRows.map(item=>[identity(item),item]));
    const max=new Map(maxima.map(item=>[item.kind,item.maximum]));
    const version=p.baseRevision+1,token=crypto.randomUUID(),now=new Date().toISOString(),expires=new Date(Date.now()+TRANSPORT_LIMITS.receiptTTL).toISOString();
    const changes=[], next=new Set();
    for (const item of nextRecords) {
      const before=old.get(identity(item)); next.add(identity(item));
      if (before?.tombstone) fail('SYNC_RECORD_DELETED');
      if (item.kind !== 'set') {
        if (before) item.ordinal=before.ordinal;
        else { const ordinal=(max.get(item.kind) ?? -1)+1; if (!int(ordinal) || ordinal===Number.MAX_SAFE_INTEGER) fail('SYNC_ORDER_LIMIT',413); item.ordinal=ordinal; max.set(item.kind,ordinal); }
      }
      if (!before || ['payload_json','address_json','parent_key','ordinal'].some(field=>before[field]!==item[field])) changes.push({...item,created_revision:before?.created_revision ?? version,modified_revision:version,tombstone:0,deleted_revision:null});
    }
    for (const before of oldRows) if (!before.tombstone && !next.has(identity(before))) changes.push({...before,modified_revision:version,tombstone:1,deleted_revision:version});
    // Anchors are validated together using keys only; no payload or per-command reads.
    if (order.length) {
      const keys=JSON.stringify(order.flatMap(c=>[{kind:c.kind,key:idKey(c.key)},{kind:c.kind,key:idKey(c.anchor)}]));
      if(bytes(keys)>LIMITS.chunkBytes) fail('SYNC_ORDER_LIMIT',413);
      const rows=(await db.prepare(`SELECT kind,record_key,tombstone FROM sync_records WHERE user_id=? AND EXISTS (SELECT 1 FROM json_each(?) j WHERE kind=json_extract(j.value,'$.kind') AND record_key=json_extract(j.value,'$.key'))`).bind(userId,keys).all()).results;
      const live=new Set(rows.filter(row=>!row.tombstone).map(identity)); for(const item of nextRecords) if(rootKinds.includes(item.kind)) live.add(identity(item)); for(const item of touched) if(item.deleted) live.delete(JSON.stringify([item.kind,item.key]));
      for(const c of order) if (!live.has(JSON.stringify([c.kind,idKey(c.key)])) || !live.has(JSON.stringify([c.kind,idKey(c.anchor)]))) fail('SYNC_ORDER_INVALID',400);
    }
    for(const r of changes) {
      const persisted={user_id:userId,...Object.fromEntries(['kind','record_key','parent_key','ordinal','address_json','payload_json','created_revision','modified_revision','tombstone','deleted_revision'].map(key=>[key,r[key]]))};
      if(bytes(JSON.stringify(persisted))+256>LIMITS.rowBytes)fail('SYNC_RECORD_TOO_LARGE',413);
    }
    const chunks=recordChunks(changes);
    // F<=10: auth/schema/receipt/state/bounds/touched/maxima/optional anchors/outcome. CAS+receipt add 2.
    const fixed=order.length ? 8 : 6;
    if (fixed+2+chunks.length+order.length > TRANSPORT_LIMITS.mutationQueries) fail(order.length ? 'SYNC_ORDER_LIMIT' : 'SYNC_QUERY_LIMIT',413);
    const planHash=await digest({changes,order});
    const touchedRoots=JSON.stringify([...touched.map(item=>({kind:item.kind,key:item.key})),...order.map(c=>({kind:c.kind,key:idKey(c.key)}))]);
    if (bytes(touchedRoots)>LIMITS.chunkBytes) fail('SYNC_ROOT_LIMIT',413);
    const counts={upserts:changes.filter(r=>!r.tombstone).length,deletes:changes.filter(r=>r.tombstone).length,orderCommands:order.length};
    const cas=db.prepare(`UPDATE sync_account_state SET revision=?,write_token=?,updated_at=? WHERE user_id=? AND revision=? AND write_token=? AND storage_schema_version=1 AND write_status='ACTIVE' AND EXISTS (SELECT 1 FROM users WHERE id=sync_account_state.user_id AND deleted_at IS NULL)`).bind(version,token,now,userId,p.baseRevision,state.write_token);
    const ordinals=await plannedOrdinals(db,userId,changes,touchedRoots,order,oldRows);
    const outcomeJSON=JSON.stringify({ok:true,mutationId:p.mutationId,syncVersion:version,updatedAt:now,counts,ordinals});
    const receiptRow={user_id:userId,mutation_id:p.mutationId,request_hash:requestHash,plan_hash:planHash,base_revision:p.baseRevision,committed_revision:version,outcome_json:outcomeJSON,created_at:now,expires_at:expires};
    if(bytes(outcomeJSON)>LIMITS.chunkBytes || bytes(JSON.stringify(receiptRow))+256>LIMITS.rowBytes)fail('SYNC_ROOT_LIMIT',413);
    const receiptInsert=db.prepare(`INSERT INTO sync_mutation_receipts (user_id,mutation_id,request_hash,plan_hash,base_revision,committed_revision,outcome_json,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${RECORD_WRITE_GATE_SQL}
      ON CONFLICT(user_id,mutation_id) DO UPDATE SET request_hash=excluded.request_hash,plan_hash=excluded.plan_hash,base_revision=excluded.base_revision,committed_revision=excluded.committed_revision,outcome_json=excluded.outcome_json,created_at=excluded.created_at,expires_at=excluded.expires_at WHERE sync_mutation_receipts.expires_at<=excluded.created_at`)
      .bind(userId,p.mutationId,requestHash,planHash,p.baseRevision,version,outcomeJSON,now,expires,userId,version,token);
    const result=await db.batch([cas,...chunks.map(chunk=>db.prepare(chunkSQL).bind(userId,chunk,userId,version,token)),...order.map(c=>orderStatement(db,userId,version,token,c)),receiptInsert]);
    const outcome=await db.prepare(`SELECT m.request_hash,m.outcome_json,m.expires_at,m.base_revision,m.committed_revision FROM sync_mutation_receipts m JOIN users u ON u.id=m.user_id JOIN sync_account_state s ON s.user_id=m.user_id WHERE m.user_id=? AND m.mutation_id=? AND u.deleted_at IS NULL AND s.write_status='ACTIVE' AND s.storage_schema_version=1`).bind(userId,p.mutationId).first();
    if(result[0]?.meta?.changes!==1) {
      if(outcome && outcome.expires_at>new Date().toISOString()) { if(outcome.request_hash!==requestHash) fail('SYNC_MUTATION_ID_CONFLICT'); if(outcome.base_revision!==p.baseRevision || outcome.committed_revision!==version) fail('SYNC_STORAGE_UNAVAILABLE',503); return json(JSON.parse(outcome.outcome_json)); }
      fail('SYNC_CONFLICT');
    }
    if(!outcome || outcome.request_hash!==requestHash || outcome.committed_revision!==version) fail('SYNC_STORAGE_UNAVAILABLE',503);
    return json(JSON.parse(outcome.outcome_json));
  } catch(cause) { return reject(cause); }
}
export async function cleanupMutationReceipts(env) {
  const tables=await storageTables(env.DB);
  if (recordSchemaStatus(tables)!=='ready' || receiptSchemaStatus(tables)!=='ready') return;
  await env.DB.prepare(`DELETE FROM sync_mutation_receipts WHERE (user_id,mutation_id) IN (SELECT user_id,mutation_id FROM sync_mutation_receipts WHERE expires_at<=? ORDER BY expires_at,user_id,mutation_id LIMIT 256)`).bind(new Date().toISOString()).run();
}
