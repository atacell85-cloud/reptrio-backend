import { body, currentUser, error, isJsonPost, issueSession, json, methodOrTypeError, randomToken, sameOrigin, sessionToken, tokenDigest, purgeAccountData, applePurgePrerequisite, deletionContext, oauthConfig, openProviderToken } from './account-api.js';
import { sendTransactionalEmail } from './transactional-email.js';
import { LIVE_ACTIVITY_PROBE_SQL, liveActivityProbeBindings, runLiveActivityEnds } from './live-activity-end.js';
const DAY=86400000, TTL=600000;
const wrapped=new WeakSet(),origins=new WeakMap(),gates=new WeakMap();
// Shared statement-level gate: rechecks ACTIVE inside the same SQL snapshot/CAS, including requests authenticated
// before a concurrent deletion. It preserves all existing parameter order, codecs and mutation guards.
export async function activeAccountDB(db,userId){
 if(!db)return db;
 if(db.accountLifecycleGuarded&&(!userId||db.accountLifecycleUserId===userId))return db;
 db=origins.get(db)||db;
 const key='';let known=gates.get(db);if(!userId&&known?.has(key))return known.get(key);
 if(!known){const columns=(await db.prepare('PRAGMA table_info(users)').all()).results||[];if(!columns.some(c=>c.name==='account_status'))return db;known=new Map();gates.set(db,known);}
 const prepare=sql=>{
  let guarded=sql.replace(/\b((?:u|users|owner)\.)?deleted_at IS NULL/g,(_,alias='')=>`${alias}deleted_at IS NULL AND ${alias}account_status='ACTIVE'`);
  // Import jobs use direct statements outside auth/sync. Gate all owner reads and mutations atomically.
  if(/^(?:SELECT|UPDATE)/i.test(guarded.trim())&&/\b(?:FROM|UPDATE) import_jobs\b/.test(guarded)&&/\bWHERE\b/.test(guarded))guarded=guarded.replace(/\bWHERE\b/,"WHERE EXISTS(SELECT 1 FROM users account_owner WHERE account_owner.id=import_jobs.user_id AND account_owner.deleted_at IS NULL AND account_owner.account_status='ACTIVE') AND");
  if(/INSERT INTO import_jobs/.test(guarded))guarded=guarded.replace(/VALUES\s*\(([^)]*)\)/,(_,values)=>`SELECT ${values} WHERE EXISTS(SELECT 1 FROM users account_owner WHERE account_owner.id=? AND account_owner.deleted_at IS NULL AND account_owner.account_status='ACTIVE')`);
  const scopedRead=userId&&/^\s*(?:SELECT|WITH)\b/i.test(guarded)&&!/\b(?:UPDATE|INSERT|DELETE)\b/i.test(guarded)&&/\b(?:sync_records|user_data|personal_restore_(?:operations|records|roots|chunks|identity_journal))\b/.test(guarded)&&!guarded.includes('sqlite_master');
  if(scopedRead)guarded=`SELECT * FROM (${guarded}) WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND account_status='ACTIVE')`;
  const prepared=db.prepare(guarded);
  if(scopedRead)return {...prepared,bind:(...args)=>prepared.bind(...args,userId)};
  if(/INSERT INTO import_jobs/.test(sql))return {...prepared,bind:(...args)=>prepared.bind(...args,args[1])};
  return prepared;
 };
 const gate={accountLifecycleGuarded:true,accountLifecycleUserId:userId,prepare,batch:items=>db.batch(items)};wrapped.add(gate);origins.set(gate,db);if(!userId)known.set(key,gate);return gate;
}
// One D1 round trip (Workers Free CPU is dominated by the number of D1 calls): the users columns and the lifecycle
// tables' SQL in a single snapshot. The checks are unchanged; any missing column/table fails closed.
const READY_SQL="SELECT (SELECT json_group_array(name) FROM pragma_table_info('users')) AS cols,(SELECT json_group_array(json_object('name',name,'sql',sql)) FROM sqlite_master WHERE type='table' AND name IN ('account_lifecycle_work','account_lifecycle_credentials','oauth_reauth_tickets','d1_write_budget')) AS tables";
export async function lifecycleReady(db){lifecycleReadyCheck(await db.prepare(READY_SQL).first());}
const MINUTE_PROBE_SQL=`SELECT (SELECT id FROM users WHERE account_status IN ('PENDING_DELETION','PURGING') AND purge_at<=? AND (purge_retry_at IS NULL OR purge_retry_at<=?) AND (purge_lease_until IS NULL OR purge_lease_until<=?) ORDER BY purge_at LIMIT 1) AS due_id,
 EXISTS(SELECT 1 FROM account_lifecycle_work WHERE state='RUNNING' AND expires_at<=?) AS stale,${READY_SQL.slice('SELECT '.length)}`;
export function lifecycleReadyCheck(row){
 const cols=JSON.parse(row?.cols||'[]').map(name=>({name}));
 const required=['account_status','credential_origin','email_verified_at','deletion_requested_at','purge_at','purge_lease','purge_lease_until','purge_attempts','purge_retry_at','purge_error'];
 const schema=JSON.parse(row?.tables||'[]');
 const w=schema.find(row=>row.name==='account_lifecycle_work'),budget=schema.find(row=>row.name==='d1_write_budget');
 // Migration 0014 (Free-plan cleanup ledger + daily write budget) is required: fail closed without it.
 if(!budget||!['day','scope','rows_written','lease'].every(c=>new RegExp(`\\b${c}\\b`).test(budget.sql)))throw Object.assign(new Error('ACCOUNT_LIFECYCLE_UNAVAILABLE'),{code:'ACCOUNT_LIFECYCLE_UNAVAILABLE',status:503});
 if(!w||!['id','user_id','state','response_id','created_at','expires_at','last_error','import_job_id'].every(c=>new RegExp(`\\b${c}\\b`).test(w.sql)))throw Object.assign(new Error('ACCOUNT_LIFECYCLE_UNAVAILABLE'),{code:'ACCOUNT_LIFECYCLE_UNAVAILABLE',status:503});
 const t=schema.find(row=>row.name==='account_lifecycle_credentials');
 const tickets=schema.find(row=>row.name==='oauth_reauth_tickets');
 if(!tickets||!['id','user_id','ticket_hash','created_at','expires_at','used_at','provider','session_hash'].every(c=>new RegExp(`\\b${c}\\b`).test(tickets.sql)))throw Object.assign(new Error('ACCOUNT_LIFECYCLE_UNAVAILABLE'),{code:'ACCOUNT_LIFECYCLE_UNAVAILABLE',status:503});
 if(!required.every(c=>cols.some(x=>x.name===c))||!t||!['id','user_id','token_hash','session_hash','purpose','created_at','expires_at','ownership_verified_at','used_at'].every(c=>new RegExp(`\\b${c}\\b`).test(t.sql)))throw Object.assign(new Error('ACCOUNT_LIFECYCLE_UNAVAILABLE'),{code:'ACCOUNT_LIFECYCLE_UNAVAILABLE',status:503});
}
async function rate(request,env){
 try{return (await env.ACCOUNT_LIFECYCLE_LIMITER?.limit({key:request.headers.get('cf-connecting-ip')||'unknown'}))?.success!==false;}catch{return false;}
}
export async function issueRecovery(env,userId,{freshOwnership=true}={}){
 await lifecycleReady(env.DB);
 const token=randomToken(32),stamp=new Date(),expires=new Date(stamp.getTime()+TTL).toISOString();
 const result=await env.DB.prepare(`INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at,ownership_verified_at)
 SELECT ?,id,?,?,'RECOVERY',?,?,? FROM users WHERE id=? AND account_status IN ('PENDING_DELETION','PURGING') AND deleted_at IS NULL`).bind(crypto.randomUUID(),await tokenDigest(token),await tokenDigest(token),stamp.toISOString(),expires,freshOwnership?stamp.toISOString():null,userId).run();
 if(result.meta.changes!==1)return error('AUTH_REQUIRED',401);
 return json({accountStatus:(await env.DB.prepare('SELECT account_status FROM users WHERE id=?').bind(userId).first()).account_status,recoveryToken:token,expiresAt:expires},201);
}
export async function recoveryOwner(request,env){
 const token=sessionToken(request);if(!token)return null;
 return env.DB.prepare(`SELECT u.id,u.email,u.account_status,u.deletion_requested_at,u.purge_at,u.purge_error,c.id AS credential_id,c.ownership_verified_at FROM account_lifecycle_credentials c JOIN users u ON u.id=c.user_id WHERE c.token_hash=? AND c.purpose='RECOVERY' AND c.used_at IS NULL AND c.expires_at>? AND u.deleted_at IS NULL AND u.account_status IN ('PENDING_DELETION','PURGING')`).bind(await tokenDigest(token),new Date().toISOString()).first();
}
export async function createDeleteProof(env,userId,sessionHash){
 const proof=randomToken(32),now=new Date();
 const result=await env.DB.prepare(`INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at)
 SELECT ?,id,?,?,'DELETE_PROOF',?,? FROM users WHERE id=? AND account_status='ACTIVE' AND deleted_at IS NULL`).bind(crypto.randomUUID(),await tokenDigest(proof),sessionHash,now.toISOString(),new Date(now.getTime()+TTL).toISOString(),userId).run();
 if(result.meta.changes!==1)throw Object.assign(new Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED',status:401});return proof;
}
export async function handleLifecycleRequest(request,env,path){
 if(path==='/account-deletion-link')return linkPage(request);
 const action=({'/api/auth/delete/request-link':'request','/api/auth/delete/verify-link':'verify','/api/auth/delete':'delete','/api/auth/account/status':'status','/api/auth/account/recover':'recover','/api/auth/account/purge-now':'purge'})[path];
 if(!action)return null;
 // GET delete context belongs to account-api.
 if(action==='delete'&&request.method==='GET')return null;
 if(action==='status'){if(request.method!=='GET')return error('METHOD_NOT_ALLOWED',405);}
 else{if(!isJsonPost(request))return methodOrTypeError(request);if(!sameOrigin(request))return error('AUTH_ORIGIN_INVALID',403);}
 try{
 await lifecycleReady(env.DB);
 if(action!=='status'&&!(await rate(request,env)))return error('ACCOUNT_LIFECYCLE_RATE_LIMITED',429);
 if(['status','recover','purge'].includes(action)){
  const owner=await recoveryOwner(request,env);if(!owner)return error('AUTH_REQUIRED',401);
  if(action==='status'){
   const context=await deletionContext(env,owner.id),config=oauthConfig(env,'apple');
   const tokens=await Promise.all(context.apple.map(row=>openProviderToken(config,'apple',row.provider_subject,row.refresh_token_ciphertext)));
   return json({user:{id:owner.id,email:owner.email},providers:context.providers,appleReauthRequired:context.apple.length>0&&(!config.ready||tokens.some(token=>!token)||owner.purge_error==='APPLE_REAUTH_REQUIRED'),purgeError:owner.purge_error||null,accountStatus:owner.account_status,deletionRequestedAt:owner.deletion_requested_at,purgeAt:owner.purge_at,ownershipVerificationRequired:!owner.ownership_verified_at,canRecover:!!owner.ownership_verified_at&&owner.account_status==='PENDING_DELETION'&&Date.now()<Date.parse(owner.purge_at)});
  }
  const p=await body(request);if(!owner.ownership_verified_at)return error('ACCOUNT_OWNERSHIP_VERIFICATION_REQUIRED',401);if(p.confirm!==(action==='recover'?'RECOVER':'DELETE'))return error('ACCOUNT_CONFIRMATION_REQUIRED',400);
  if(action==='purge'){
   // Same refusal as DELETE_NOW: an open AI outcome would leave the account PURGING (unrecoverable) yet unpurged.
   if(await env.DB.prepare("SELECT 1 FROM account_lifecycle_work WHERE user_id=? AND state IN ('RUNNING','UNKNOWN') LIMIT 1").bind(owner.id).first())return error('ACCOUNT_PURGE_UPSTREAM_UNRESOLVED',409);
   return await beginImmediatePurge(env,owner.id,owner.credential_id);
  }
  const stamp=new Date().toISOString(),marker=crypto.randomUUID();
  const results=await env.DB.batch([
   env.DB.prepare(`UPDATE users SET account_status='ACTIVE',deletion_requested_at=NULL,purge_at=NULL,purge_retry_at=NULL,purge_error=NULL,purge_lease=? WHERE id=? AND account_status='PENDING_DELETION' AND purge_at>? AND EXISTS(SELECT 1 FROM account_lifecycle_credentials WHERE id=? AND used_at IS NULL AND expires_at>? AND ownership_verified_at IS NOT NULL)`).bind(marker,owner.id,stamp,owner.credential_id,stamp),
   env.DB.prepare(`DELETE FROM account_lifecycle_credentials WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND account_status='ACTIVE' AND purge_lease=?)`).bind(owner.id,owner.id,marker)
  ]);
  if(results[0].meta.changes!==1)return error('ACCOUNT_RECOVERY_EXPIRED',409);
  return issueSession(env,owner.id,owner.email,201,{'X-Reptrio-Client':'mobile'});
 }
 const user=await currentUser(request,env);if(!user)return error('AUTH_REQUIRED',401);
 const sessionHash=await tokenDigest(sessionToken(request));
 if(action==='request'){
  const token=randomToken(32),id=crypto.randomUUID(),stamp=new Date(),now=stamp.toISOString();
  const result=await env.DB.prepare(`INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at)
   SELECT ?,id,?,?,'DELETE_LINK',?,? FROM users WHERE id=? AND account_status='ACTIVE' AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM auth_sessions WHERE user_id=users.id AND token_hash=? AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM account_lifecycle_credentials WHERE user_id=? AND purpose='DELETE_LINK' AND created_at>?)`).bind(id,await tokenDigest(token),sessionHash,now,new Date(stamp.getTime()+TTL).toISOString(),user.id,sessionHash,now,user.id,new Date(stamp.getTime()-60000).toISOString()).run();
  if(result.meta.changes!==1)return error('ACCOUNT_LIFECYCLE_RATE_LIMITED',429);
  const link=`https://api.reptrio.com/account-deletion-link#token=${token}`;
  const sent=await sendTransactionalEmail(env,{to:user.email,subject:'Reptrio hesap silme doğrulaması',text:`Bu bağlantı yalnızca kimliğini doğrular. Hesap silmek için uygulamada ayrıca onay gerekir. Bağlantı 10 dakika geçerlidir.\n${link}`,reference:id});
  if(!sent.ok){await env.DB.prepare('DELETE FROM account_lifecycle_credentials WHERE id=?').bind(id).run();return error('ACCOUNT_DELETE_MAIL_FAILED',503);}return json({ok:true,expiresInSeconds:600},202);
 }
 const p=await body(request),now=new Date().toISOString();
 if(action==='verify'){
  if(typeof p.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.token))return error('ACCOUNT_DELETE_LINK_INVALID',400);
  const hash=await tokenDigest(p.token),proof=randomToken(32),proofHash=await tokenDigest(proof);
  const guard=`EXISTS(SELECT 1 FROM account_lifecycle_credentials c JOIN users u ON u.id=c.user_id JOIN auth_sessions s ON s.user_id=u.id AND s.token_hash=c.session_hash WHERE c.token_hash=? AND c.user_id=? AND c.session_hash=? AND c.purpose='DELETE_LINK' AND c.used_at IS NULL AND c.expires_at>? AND s.expires_at>? AND u.account_status='ACTIVE' AND u.deleted_at IS NULL)`;
  const args=[hash,user.id,sessionHash,now,now];
  const results=await env.DB.batch([
   env.DB.prepare(`INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at) SELECT ?,?,?,?,'DELETE_PROOF',?,? WHERE ${guard}`).bind(crypto.randomUUID(),user.id,proofHash,sessionHash,now,new Date(Date.parse(now)+TTL).toISOString(),...args),
   env.DB.prepare(`UPDATE users SET email_verified_at=? WHERE id=? AND ${guard}`).bind(now,user.id,...args),
   env.DB.prepare(`UPDATE account_lifecycle_credentials SET used_at=? WHERE token_hash=? AND ${guard}`).bind(now,hash,...args)
  ]);
  if(results[0].meta.changes!==1)return error('ACCOUNT_DELETE_LINK_INVALID',400);return json({proof,expiresInSeconds:600});
 }
 if(p.confirm!=='DELETE')return error('ACCOUNT_DELETE_CONFIRMATION_REQUIRED',400);
 const method=p.method||'DELETE_AFTER_30_DAYS';if(!['DELETE_AFTER_30_DAYS','DELETE_NOW'].includes(method))return error('ACCOUNT_DELETE_METHOD_INVALID',400);
 if(typeof p.proof!=='string')return error('ACCOUNT_DELETE_PROOF_REQUIRED',401);
 // Cleanup preflight happens before the first state change and before upstream effects.
 await purgeAccountData(env,user.id,{preflight:true});
 const appleSnapshot=await applePurgePrerequisite(env,user.id);
 const proofHash=await tokenDigest(p.proof),confirmedAt=new Date().toISOString(),deadline=new Date(Date.parse(confirmedAt)+(method==='DELETE_NOW'?0:30*DAY)).toISOString(),marker=crypto.randomUUID();
 const guard=`EXISTS(SELECT 1 FROM users WHERE id=? AND account_status IN ('PENDING_DELETION','PURGING') AND purge_lease=?)`;
 const results=await env.DB.batch([
  env.DB.prepare(`UPDATE users SET account_status=CASE WHEN ?=1 THEN 'PURGING' ELSE 'PENDING_DELETION' END,deletion_requested_at=?,purge_at=?,purge_lease=?,purge_lease_until=NULL,purge_retry_at=NULL,purge_error=NULL WHERE id=? AND (?=0 OR NOT EXISTS(SELECT 1 FROM account_lifecycle_work WHERE user_id=users.id AND state IN ('RUNNING','UNKNOWN'))) AND account_status='ACTIVE' AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM account_lifecycle_credentials WHERE token_hash=? AND user_id=? AND session_hash=? AND purpose='DELETE_PROOF' AND used_at IS NULL AND expires_at>?) AND EXISTS(SELECT 1 FROM auth_sessions WHERE user_id=users.id AND token_hash=? AND expires_at>?) AND (SELECT json_group_array(json_object('provider_subject',provider_subject,'refresh_token_ciphertext',refresh_token_ciphertext)) FROM (SELECT provider_subject,refresh_token_ciphertext FROM oauth_accounts WHERE user_id=users.id AND provider='apple' ORDER BY provider_subject))=?`).bind(method==='DELETE_NOW'?1:0,confirmedAt,deadline,marker,user.id,method==='DELETE_NOW'?1:0,proofHash,user.id,sessionHash,confirmedAt,sessionHash,confirmedAt,appleSnapshot),
  ...['auth_sessions','password_reset_tokens','mobile_oauth_codes','oauth_reauth_tickets','account_lifecycle_credentials'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE user_id=? AND ${guard}`).bind(user.id,user.id,marker)),
  env.DB.prepare(`UPDATE import_jobs SET status='failed',error_code='ACCOUNT_PENDING_DELETION',updated_at=? WHERE user_id=? AND status IN ('queued','processing') AND ${guard}`).bind(confirmedAt,user.id,user.id,marker)
 ]);
 if(results[0].meta.changes!==1){
  // Immediate purge cannot finish while an AI upstream outcome is open; refuse before any state change, proof unused.
  // A bad/expired/used proof stays 401 first; the upstream refusal applies only to an otherwise valid request.
  if(method==='DELETE_NOW'&&await env.DB.prepare("SELECT 1 FROM account_lifecycle_credentials WHERE token_hash=? AND user_id=? AND session_hash=? AND purpose='DELETE_PROOF' AND used_at IS NULL AND expires_at>?").bind(proofHash,user.id,sessionHash,confirmedAt).first()&&await env.DB.prepare("SELECT 1 FROM account_lifecycle_work WHERE user_id=? AND state IN ('RUNNING','UNKNOWN') LIMIT 1").bind(user.id).first())return error('ACCOUNT_PURGE_UPSTREAM_UNRESOLVED',409);
  return error('ACCOUNT_DELETE_PROOF_INVALID',401);
 }
 // Accepted, not completed: the account is closed (sessions revoked) and PURGING; the minute cron erases it in bounded
 // steps. Completion is never reported here.
 if(method==='DELETE_NOW')return json({ok:true,accountStatus:'PURGING',purgeComplete:false,deletionRequestedAt:confirmedAt,purgeAt:deadline},202,{'Set-Cookie':'aks_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
 return json({ok:true,accountStatus:'PENDING_DELETION',deletionRequestedAt:confirmedAt,purgeAt:deadline},200,{'Set-Cookie':'aks_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
 }catch(cause){return error(cause.code||'ACCOUNT_LIFECYCLE_FAILED',cause.status||503);}
}
// Recovery-screen "purge now": pending -> PURGING (irreversible) with a fresh due time; an account already PURGING only
// has its retry backoff cleared. The minute cron performs the purge; nothing is erased in this request.
async function beginImmediatePurge(env,userId,recoveryCredentialId){
 await purgeAccountData(env,userId,{preflight:true});
 const now=new Date().toISOString(),marker=crypto.randomUUID();
 const credential="EXISTS(SELECT 1 FROM account_lifecycle_credentials WHERE id=? AND user_id=users.id AND purpose='RECOVERY' AND used_at IS NULL AND expires_at>? AND ownership_verified_at IS NOT NULL)";
 const moved=await env.DB.prepare(`UPDATE users SET account_status='PURGING',purge_at=CASE WHEN purge_at>? THEN ? ELSE purge_at END,purge_lease=?,purge_lease_until=NULL,purge_retry_at=NULL,purge_error=NULL WHERE id=? AND deleted_at IS NULL AND account_status='PENDING_DELETION' AND NOT EXISTS(SELECT 1 FROM account_lifecycle_work WHERE user_id=users.id AND state IN ('RUNNING','UNKNOWN')) AND ${credential}`).bind(now,now,marker,userId,recoveryCredentialId,now).run();
 if(moved.meta.changes!==1){
  const retried=await env.DB.prepare(`UPDATE users SET purge_retry_at=NULL WHERE id=? AND deleted_at IS NULL AND account_status='PURGING' AND (purge_lease_until IS NULL OR purge_lease_until<=?) AND ${credential}`).bind(userId,now,recoveryCredentialId,now).run();
  if(retried.meta.changes!==1){
   const row=await env.DB.prepare('SELECT account_status FROM users WHERE id=? AND deleted_at IS NULL').bind(userId).first();
   if(row?.account_status==='PENDING_DELETION'&&await env.DB.prepare("SELECT 1 FROM account_lifecycle_work WHERE user_id=? AND state IN ('RUNNING','UNKNOWN') LIMIT 1").bind(userId).first())return error('ACCOUNT_PURGE_UPSTREAM_UNRESOLVED',409);
   if(row?.account_status!=='PURGING')return error('ACCOUNT_PURGE_BUSY',409);
  }
 }
 return json({ok:true,accountStatus:'PURGING',purgeComplete:false},202);
}
// One bounded purge step for one due owner (minute cron only). Outcomes: erased; ACCOUNT_PURGE_IN_PROGRESS (upstream
// cleanup advanced; next step at the next minute, no backoff); or a failure with exponential backoff. Never a success
// report before the final erase batch deleted the users row.
export async function executePurge(env,userId){
 const stamp=new Date(),now=stamp.toISOString(),lease=randomToken(24);
 const acquire=env.DB.prepare(`UPDATE users SET account_status='PURGING',purge_lease=?,purge_lease_until=?,purge_attempts=purge_attempts+1 WHERE id=? AND deleted_at IS NULL AND ((account_status='PENDING_DELETION' AND purge_at<=?) OR (account_status='PURGING' AND (purge_lease_until IS NULL OR purge_lease_until<=?))) AND (purge_retry_at IS NULL OR purge_retry_at<=?)`).bind(lease,new Date(stamp.getTime()+PURGE_LEASE_MS).toISOString(),userId,now,now,now);
 // The lease is acquired as the first statement of purgeAccountData's snapshot batch (one D1 round trip); nothing else
 // in this invocation runs unless it changed exactly this row.
 try{await purgeAccountData(env,userId,{lease,acquire});return {ok:true,accountStatus:'DELETED'};}catch(cause){
  if(cause.code==='ACCOUNT_PURGE_BUSY'&&cause.notAcquired)return {ok:false,code:'ACCOUNT_PURGE_BUSY'};
  const code=cause.code||'ACCOUNT_PURGE_FAILED';
  // An upstream step hands back its (not yet run) confirmed-deletes statement: it is recorded in ONE atomic batch with
  // the users-row update below (one D1 round trip; Workers Free cron CPU), so progress is never lost or half-written.
  const record=cause.record?[cause.record]:[];
  if(code==='ACCOUNT_PURGE_IN_PROGRESS'){
   await env.DB.batch([...record,env.DB.prepare("UPDATE users SET purge_lease_until=NULL,purge_retry_at=NULL,purge_attempts=0,purge_error='ACCOUNT_PURGE_IN_PROGRESS' WHERE id=? AND purge_lease=? AND account_status='PURGING'").bind(userId,lease)]);
   console.log(JSON.stringify({event:'account_purge_progress',deleted:cause.progress||0}));return {ok:false,code};
  }
  // purge_attempts as read after this invocation's acquire (upstream failures carry it; otherwise it is read here).
  const attempts=Number.isFinite(cause.attempts)?cause.attempts:(await env.DB.prepare('SELECT purge_attempts FROM users WHERE id=? AND purge_lease=?').bind(userId,lease).first())?.purge_attempts;
  // A spent daily write budget resumes at the next UTC day; other failures back off exponentially (max 1 day).
  const retryAt=code==='ACCOUNT_PURGE_DAILY_BUDGET'?new Date(Date.UTC(stamp.getUTCFullYear(),stamp.getUTCMonth(),stamp.getUTCDate()+1)).getTime():Date.now()+Math.min(86400000,60000*2**Math.min(10,attempts||1));
  await env.DB.batch([...record,env.DB.prepare(`UPDATE users SET purge_lease_until=NULL,purge_retry_at=?,purge_error=? WHERE id=? AND purge_lease=? AND account_status='PURGING'`).bind(new Date(retryAt).toISOString(),code,userId,lease)]);
  console.warn(JSON.stringify({event:'account_purge_retry',code,attempt:attempts||1}));return {ok:false,code};
 }
}
// The lease outlives the bounded upstream step (PURGE_UPSTREAM_TIME_MS + one provider timeout).
const PURGE_LEASE_MS=120000;
// Build 45: the Live Activity end step shares this read (one extra EXISTS term); built lazily because
// live-activity-end.js and this module import each other.
let liveActivityProbeOffUntil=0;
async function minuteProbe(db,now,nowMs){
 if(nowMs>=liveActivityProbeOffUntil){
  try{return await db.prepare(`${MINUTE_PROBE_SQL},${LIVE_ACTIVITY_PROBE_SQL} AS live_activity`).bind(now,now,now,now,...liveActivityProbeBindings(nowMs)).first();}
  catch(cause){
   // Table missing (migration 0015 not applied yet): account purge keeps its unchanged probe; the end step is retried
   // in this isolate after 15 minutes (two reads per minute only while the table is missing and the retry is due).
   if(!/live_activity_end/.test(String(cause?.message||'')))throw cause;
   liveActivityProbeOffUntil=nowMs+15*60000;console.warn(JSON.stringify({event:'live_activity_end_unavailable'}));
  }
 }
 return db.prepare(MINUTE_PROBE_SQL).bind(now,now,now,now).first();
}
export async function purgeDueAccounts(env,{liveActivityEnds=runLiveActivityEnds}={}){
 try{
 const nowMs=Date.now(),now=new Date(nowMs).toISOString();
 // Workers Free cron CPU (10 ms): one read decides the minute. Readiness snapshot, the next due owner (one owner per
 // invocation leaves room for complete guarded cleanup on the smallest D1 allowance), whether interrupted work needs
 // the UNKNOWN sweep and whether a Live Activity end is due. Nothing to do = this single D1 call. Readiness is still
 // checked before any write.
 const probe=await minuteProbe(env.DB,now,nowMs);
 // The end push is time-critical and bounded (<= 5 sends); its failure never blocks the purge step.
 if(Number(probe?.live_activity)){try{await liveActivityEnds(env,{nowMs});}catch(cause){console.warn(JSON.stringify({event:'live_activity_end_failed',code:cause?.code||'DATABASE_UNAVAILABLE'}));}}
 if(!probe?.due_id&&!Number(probe?.stale))return;
 lifecycleReadyCheck(probe);
 if(Number(probe.stale))await env.DB.prepare("UPDATE account_lifecycle_work SET state='UNKNOWN',last_error='WORKER_INTERRUPTED' WHERE state='RUNNING' AND expires_at<=?").bind(now).run();
 if(probe.due_id)await executePurge(env,probe.due_id);
 }catch(cause){console.warn(JSON.stringify({event:'account_purge_unavailable',code:cause.code||'DATABASE_UNAVAILABLE'}));}
}
// 15-minute maintenance invocation (not the minute purge budget): expired credentials/tickets and overdue logging.
export async function lifecycleMaintenance(env){
 try{
 const now=new Date().toISOString();
 const overdue=await env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE account_status IN ('PENDING_DELETION','PURGING') AND purge_at<=?`).bind(new Date(Date.now()-3600000).toISOString()).first();
 if(overdue.count)console.warn(JSON.stringify({event:'account_purge_overdue',count:overdue.count}));
 await env.DB.prepare('DELETE FROM account_lifecycle_credentials WHERE expires_at<=?').bind(now).run();
 await env.DB.prepare('DELETE FROM oauth_reauth_tickets WHERE expires_at<=?').bind(now).run();
 }catch(cause){console.warn(JSON.stringify({event:'lifecycle_maintenance_unavailable',code:cause.code||'DATABASE_UNAVAILABLE'}));}
}
function linkPage(request){
 if(!['GET','HEAD'].includes(request.method))return error('METHOD_NOT_ALLOWED',405);
 const nonce=randomToken(16);
 return new Response(request.method==='HEAD'?null:`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reptrio hesap doğrulama</title><h1>Hesap silme doğrulaması</h1><p>Bağlantı hesabını silmez. Doğrulamak ve silme yöntemini seçmek için uygulamayı aç.</p><a id="app" href="reptrio://account-deletion">Reptrio uygulamasında aç</a><script nonce="${nonce}">const m=/^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash);history.replaceState(null,'',location.pathname);if(m)document.getElementById('app').href='reptrio://account-deletion#token='+m[1];</script></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`}});
}

// A stored background response can outlive the request. Acquisition closes atomically with ACTIVE; later operational
// ID persistence deliberately uses the raw DB, not the normal ACTIVE writer. Expiry is uncertainty, never success.
export function lifecycleRawDB(db){return origins.get(db)||db;}
export async function beginBackgroundWork(env,userId){
 const db=lifecycleRawDB(env.DB);await lifecycleReady(db);
 const id=crypto.randomUUID(),now=new Date();
 const r=await db.prepare(`INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at)
 SELECT ?,u.id,'RUNNING',?,? FROM users u JOIN ai_import_consents c ON c.user_id=u.id WHERE u.id=? AND u.account_status='ACTIVE' AND u.deleted_at IS NULL AND c.granted_at IS NOT NULL AND c.revoked_at IS NULL AND c.policy_version='ai_import_openai_document_v1'`).bind(id,now.toISOString(),new Date(now.getTime()+600000).toISOString(),userId).run();
 if(r.meta.changes!==1)throw Object.assign(new Error('AI_CONSENT_REQUIRED'),{code:'AI_CONSENT_REQUIRED',status:403});return id;
}
export async function backgroundReturned(env,id,responseId){
 if(typeof responseId!=='string'||!responseId)throw Object.assign(new Error('OPENAI_RESPONSE_ID_MISSING'),{code:'OPENAI_RESPONSE_ID_MISSING'});
 const r=await lifecycleRawDB(env.DB).prepare("UPDATE account_lifecycle_work SET state='RETURNED',response_id=? WHERE id=? AND state IN ('RUNNING','UNKNOWN')").bind(responseId,id).run();
 if(r.meta.changes!==1)throw Object.assign(new Error('AI_WORK_ID_UNRECORDED'),{code:'AI_WORK_ID_UNRECORDED'});
}
export async function backgroundResolved(env,id){await lifecycleRawDB(env.DB).prepare("UPDATE account_lifecycle_work SET state='RESOLVED',last_error=NULL WHERE id=? AND state='RETURNED'").bind(id).run();}
// Only a definite upstream rejection closes RUNNING work as nothing-stored; everything else stays UNKNOWN (fail closed).
export async function backgroundRejected(env,id,status){await lifecycleRawDB(env.DB).prepare("UPDATE account_lifecycle_work SET state='RESOLVED',last_error=? WHERE id=? AND state='RUNNING'").bind(`UPSTREAM_REJECTED_${Number(status)}`,id).run();}
export async function backgroundUnknown(env,id){await lifecycleRawDB(env.DB).prepare("UPDATE account_lifecycle_work SET state='UNKNOWN',last_error='UPSTREAM_OUTCOME_UNKNOWN' WHERE id=? AND state='RUNNING'").bind(id).run();}
export async function cleanupClosedBackgroundWork(env,id){
 const db=lifecycleRawDB(env.DB),row=await db.prepare("SELECT w.response_id,w.user_id FROM account_lifecycle_work w JOIN users u ON u.id=w.user_id WHERE w.id=? AND w.state='RETURNED' AND u.account_status<>'ACTIVE'").bind(id).first();
 if(!row)return;
 try{
  if(!env.OPENAI_API_KEY)throw new Error('unconfigured');
  const r=await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(row.response_id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},signal:AbortSignal.timeout(10000)});
  if(!r.ok&&r.status!==404)throw new Error('upstream');await backgroundResolved(env,id);
 }catch{await db.prepare("UPDATE account_lifecycle_work SET last_error='OPENAI_CLEANUP_FAILED' WHERE id=? AND state='RETURNED'").bind(id).run();}
}
