import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {createD1} from './lib/d1-sqlite.mjs';
import {tokenDigest,randomToken} from '../worker/account-api.js';
import {purgeDueAccounts} from '../worker/account-lifecycle.js';
const db=createD1(),env={DB:db,ZEPTOMAIL_API_KEY:'fixture',ASSETS:{fetch:()=>new Response('asset')}};
let mails=[],mailFailure=false;const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://cpaas.zoho.eu/v1.1/email');mails.push(JSON.parse(init.body));return new Response('{}',{status:mailFailure?503:200});};
const call=(path,token,payload,otherEnv=env)=>worker.fetch(new Request('https://api.reptrio.com'+path,{method:payload===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(payload===undefined?{}:{'Content-Type':'application/json','X-Reptrio-Client':'mobile'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),otherEnv,{});
const data=async r=>[r.status,await r.json()];
async function register(tag){const r=await call('/api/auth/register',null,{email:tag+'@example.test',password:'fixture-password'});assert.equal(r.status,201);return r.json();}
async function link(user){mails=[];const r=await call('/api/auth/delete/request-link',user.sessionToken,{});assert.equal(r.status,202);return /#token=([\w-]{43})/.exec(mails[0].textbody)[1];}
async function proof(user){const r=await call('/api/auth/delete/verify-link',user.sessionToken,{token:await link(user)});assert.equal(r.status,200);return(await r.json()).proof;}
async function pending(user){const p=await proof(user);const r=await call('/api/auth/delete',user.sessionToken,{proof:p,confirm:'DELETE'});assert.equal(r.status,200);return r.json();}
async function login(user){const r=await call('/api/auth/login',null,{email:user.user.email,password:'fixture-password'});assert.equal(r.status,201);return r.json();}
const a=await register('link'),b=await register('bystander'),t=await link(a);
assert.equal(db.rows('SELECT credential_origin,email_verified_at FROM users WHERE id=?',a.user.id)[0].credential_origin,'PASSWORD');
assert.equal(db.rows('SELECT email_verified_at FROM users WHERE id=?',a.user.id)[0].email_verified_at,null);
assert.notEqual(db.rows("SELECT token_hash FROM account_lifecycle_credentials WHERE purpose='DELETE_LINK'")[0].token_hash,t);
db.resetMetrics();for(const method of ['GET','HEAD']){const r=await worker.fetch(new Request('https://api.reptrio.com/account-deletion-link?token=ignored',{method}),env,{});assert.equal(r.status,200);assert.equal(r.headers.get('referrer-policy'),'no-referrer');}assert.equal(db.metrics.writes,0,'scanner page zero writes');
assert.deepEqual((await data(await call('/api/auth/delete/verify-link',b.sessionToken,{token:t}))).slice(0,1),[400]);
const alternate=await login(a);assert.equal((await call('/api/auth/delete/verify-link',alternate.sessionToken,{token:t})).status,400,'bound original session');
const verified=await call('/api/auth/delete/verify-link',a.sessionToken,{token:t}),p=(await verified.json()).proof;assert.equal(verified.status,200);assert.equal((await call('/api/auth/delete/verify-link',a.sessionToken,{token:t})).status,400,'single use');
assert.ok(db.rows('SELECT email_verified_at FROM users WHERE id=?',a.user.id)[0].email_verified_at);
assert.equal((await call('/api/auth/delete',a.sessionToken,{proof:p})).status,400,'separate confirm');
// Record bytes and revisions survive recovery. Seed legacy projection and active authority independently.
const raw='{"schemaVersion":8,"sessions":[{"id":"opaque","extra":{"neg":-0}}],"settings":{"theme":"dark"}}';
db.raw.prepare('INSERT INTO user_data(user_id,payload_json,sync_version,updated_at)VALUES(?,?,0,?)').run(a.user.id,raw,new Date().toISOString());
const removed=await call('/api/auth/delete',a.sessionToken,{proof:p,confirm:'DELETE'}),removedBody=await removed.json();assert.equal(removed.status,200);assert.equal(removedBody.accountStatus,'PENDING_DELETION');
assert.equal(Date.parse(removedBody.purgeAt)-Date.parse(removedBody.deletionRequestedAt),30*86400000);
assert.equal(db.rows('SELECT deleted_at FROM users WHERE id=?',a.user.id)[0].deleted_at,null);
for(const route of ['/api/me','/api/sync/pull','/api/sync/records','/api/sync/capabilities','/api/privacy/ai-import'])assert.equal((await call(route,a.sessionToken)).status,401,route);
for(const route of ['/api/sync/push','/api/import/jobs','/api/import/parse','/api/privacy/ai-import/consent','/api/backup/restore/operations'])assert.equal((await call(route,alternate.sessionToken,{})).status,401,route);
const recoveredLogin=await login(a);assert.ok(recoveredLogin.recoveryToken);assert.equal(recoveredLogin.sessionToken,undefined);assert.equal((await call('/api/me',recoveredLogin.recoveryToken)).status,401);
const scopedStatus=await call('/api/auth/account/status',recoveredLogin.recoveryToken);assert.equal(scopedStatus.status,200);const scopedBody=await scopedStatus.json();assert.deepEqual(scopedBody.user,a.user.id?{id:a.user.id,email:a.user.email}:{});assert.deepEqual(scopedBody.providers,[]);assert.equal(scopedBody.appleReauthRequired,false);assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',a.user.id)[0].account_status,'PENDING_DELETION','login never activates');
assert.equal((await call('/api/auth/account/recover',recoveredLogin.recoveryToken,{})).status,400);
const recover=await call('/api/auth/account/recover',recoveredLogin.recoveryToken,{confirm:'RECOVER'});assert.equal(recover.status,201);const recoverBody=await recover.json();assert.ok(recoverBody.sessionToken);assert.equal(db.rows('SELECT payload_json FROM user_data WHERE user_id=?',a.user.id)[0].payload_json,raw);assert.equal((await call('/api/me',a.sessionToken)).status,401,'old tokens stay dead');
assert.equal((await call('/api/auth/account/recover',recoveredLogin.recoveryToken,{confirm:'RECOVER'})).status,401);
// Expired links and proof/session replay.
const expired=await register('expired'),expiredToken=await link(expired);db.raw.prepare("UPDATE account_lifecycle_credentials SET expires_at=? WHERE user_id=?").run(new Date(Date.now()-1).toISOString(),expired.user.id);assert.equal((await call('/api/auth/delete/verify-link',expired.sessionToken,{token:expiredToken})).status,400);
const failed=await register('mail-failure');mailFailure=true;assert.equal((await call('/api/auth/delete/request-link',failed.sessionToken,{})).status,503);assert.equal(db.rows('SELECT * FROM account_lifecycle_credentials WHERE user_id=?',failed.user.id).length,0);mailFailure=false;
// Cron before deadline does not touch account/data. Exact deadline rejects recovery and permits purge.
const due=await register('due');await pending(due);await purgeDueAccounts(env);assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',due.user.id)[0].account_status,'PENDING_DELETION');
const recovery=await login(due);db.raw.prepare('UPDATE users SET purge_at=? WHERE id=?').run(new Date().toISOString(),due.user.id);assert.equal((await call('/api/auth/account/recover',recovery.recoveryToken,{confirm:'RECOVER'})).status,409);await purgeDueAccounts(env);assert.equal(db.rows('SELECT * FROM users WHERE id=?',due.user.id).length,0);
// All account tables explicitly deleted with FK enabled/disabled; DB rollback leaves retriable PURGING.
for(const foreignKeys of [true,false]){
 const local=createD1({foreignKeys}),e={...env,DB:local};
 const u=await(await call('/api/auth/register',null,{email:'wipe@example.test',password:'fixture-password'},e)).json();
 const token=randomToken(32),now=new Date().toISOString();local.raw.prepare("INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at)VALUES(?,?,?,?,'DELETE_PROOF',?,?)").run('proof',u.user.id,await tokenDigest(token),await tokenDigest(u.sessionToken),now,new Date(Date.now()+600000).toISOString());
 local.setFailOn(/DELETE FROM users/);const r=await call('/api/auth/delete',u.sessionToken,{proof:token,confirm:'DELETE',method:'DELETE_NOW'},e);assert.equal(r.status,503);assert.equal(local.rows('SELECT account_status FROM users')[0].account_status,'PURGING');
 local.setFailOn(null);local.raw.prepare('UPDATE users SET purge_retry_at=NULL,purge_lease_until=NULL').run();await purgeDueAccounts(e);
 for(const table of local.rows("SELECT name FROM sqlite_master WHERE type='table'")){const cols=local.rows(`PRAGMA table_info(${table.name})`);if(table.name==='users'||cols.some(c=>c.name==='user_id'))assert.equal(local.rows(`SELECT * FROM ${table.name}`).length,0,table.name);}
}
// Exactly10minutes is expired, not just an old date; proofs remain bounded by the same precise UTC clock.
const RealDate=Date,fixed=RealDate.now();globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
const boundary=await register('exact-link-boundary'),boundaryToken=await link(boundary);
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixed+600000]));}static now(){return fixed+600000;}};
assert.equal((await call('/api/auth/delete/verify-link',boundary.sessionToken,{token:boundaryToken})).status,400);globalThis.Date=RealDate;
// Parallel link consumption and final confirmation each have one winner and no duplicate state transition.
const parallel=await register('parallel'),parallelToken=await link(parallel);
const verifications=await Promise.all([call('/api/auth/delete/verify-link',parallel.sessionToken,{token:parallelToken}),call('/api/auth/delete/verify-link',parallel.sessionToken,{token:parallelToken})]);assert.deepEqual(verifications.map(r=>r.status).sort(),[200,400]);const parallelProof=(await verifications.find(r=>r.status===200).json()).proof;
const finalizations=await Promise.all([call('/api/auth/delete',parallel.sessionToken,{proof:parallelProof,confirm:'DELETE'}),call('/api/auth/delete',parallel.sessionToken,{proof:parallelProof,confirm:'DELETE'})]);assert.deepEqual(finalizations.map(r=>r.status).sort(),[200,401]);assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',parallel.user.id)[0].account_status,'PENDING_DELETION');
// Day29 recovery compares actual record bytes/order/revisions for sessions, programs, measurements and settings.
const day29=await register('day29');const original={schemaVersion:8,programs:[{id:'program',name:'day29',days:[]}],sessions:[{id:'session',weightUnit:'kg',sets:{g:{s:{reps:'5',weight:'100',completed:true,opaque:{neg:0}}}}}],measurements:[{id:'measurement',recordedAt:'2026-10-13',weightKg:80,waistCm:null,bodyFatPercent:null}],settings:{rest:90,opaque:{all:'preserved'}}};
assert.equal((await call('/api/sync/push',day29.sessionToken,{syncVersion:0,data:original})).status,200);
const snapshot=JSON.stringify({records:db.rows('SELECT * FROM sync_records WHERE user_id=? ORDER BY kind,record_key',day29.user.id),state:db.rows('SELECT * FROM sync_account_state WHERE user_id=?',day29.user.id)});await pending(day29);
db.raw.prepare('UPDATE users SET deletion_requested_at=?,purge_at=? WHERE id=?').run(new Date(Date.now()-29*86400000).toISOString(),new Date(Date.now()+86400000).toISOString(),day29.user.id);
const day29Auth=await login(day29);assert.equal((await call('/api/auth/account/recover',day29Auth.recoveryToken,{confirm:'RECOVER'})).status,201);assert.equal(JSON.stringify({records:db.rows('SELECT * FROM sync_records WHERE user_id=? ORDER BY kind,record_key',day29.user.id),state:db.rows('SELECT * FROM sync_account_state WHERE user_id=?',day29.user.id)}),snapshot);
// Both orderings of explicit recover versus permanent purge: only the winner determines account state.
for(const order of ['recover-first','purge-first']){
 const u=await register(order);await pending(u);const auth=await login(u);
 const paths=order==='recover-first'?['recover','purge-now']:['purge-now','recover'];const replies=await Promise.all(paths.map(action=>call('/api/auth/account/'+action,auth.recoveryToken,{confirm:action==='recover'?'RECOVER':'DELETE'})));
 assert.equal(replies.filter(r=>r.status===200||r.status===201).length,1,order);
 const current=db.rows('SELECT account_status FROM users WHERE id=?',u.user.id);if(replies[paths.indexOf('recover')].status===201)assert.equal(current[0].account_status,'ACTIVE');else assert.equal(current.length,0);
}
// Logout invalidates detached links/proofs and reauth tickets together with the requesting session.
const logoutUser=await register('logout'),logoutToken=await link(logoutUser);assert.equal((await call('/api/auth/logout',logoutUser.sessionToken,{})).status,200);assert.equal(db.rows('SELECT * FROM account_lifecycle_credentials WHERE user_id=?',logoutUser.user.id).length,0);assert.equal((await call('/api/auth/delete/verify-link',logoutUser.sessionToken,{token:logoutToken})).status,401);
// Revocation after request authentication but before the atomic final transition must still reject the action.
{
 const u=await register('late-link-revocation'),t=await link(u);
 db.setBeforeBatch(statements=>{if(statements[0].sql.includes("'DELETE_PROOF'")){db.setBeforeBatch(null);db.raw.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(u.user.id);}});
 assert.equal((await call('/api/auth/delete/verify-link',u.sessionToken,{token:t})).status,400);
 assert.equal(db.rows('SELECT email_verified_at FROM users WHERE id=?',u.user.id)[0].email_verified_at,null);
 assert.equal(db.rows("SELECT used_at FROM account_lifecycle_credentials WHERE user_id=? AND purpose='DELETE_LINK'",u.user.id)[0].used_at,null);
 assert.equal(db.rows("SELECT * FROM account_lifecycle_credentials WHERE user_id=? AND purpose='DELETE_PROOF'",u.user.id).length,0);
}
{
 let invalidate=false,local;
 local=createD1({beforeStatement(sql){if(invalidate&&sql.includes('INSERT INTO account_lifecycle_credentials')&&sql.includes("'DELETE_LINK'")){invalidate=false;local.raw.prepare('DELETE FROM auth_sessions').run();}}});
 const e={...env,DB:local},u=await(await call('/api/auth/register',null,{email:'issue-revocation@example.test',password:'fixture-password'},e)).json(),beforeMail=mails.length;
 invalidate=true;
 assert.notEqual((await call('/api/auth/delete/request-link',u.sessionToken,{},e)).status,202);
 assert.equal(local.rows('SELECT * FROM account_lifecycle_credentials').length,0);
 assert.equal(mails.length,beforeMail,'revoked session cannot initiate mail delivery');
}
{
 const u=await register('late-session-revocation'),p=await proof(u);
 db.setBeforeBatch(statements=>{if(statements[0].sql.startsWith("UPDATE users SET account_status='PENDING_DELETION'")){db.setBeforeBatch(null);db.raw.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(u.user.id);}});
 const r=await call('/api/auth/delete',u.sessionToken,{proof:p,confirm:'DELETE'});
 assert.equal(r.status,401,'a revoked initiating session cannot use its still-unconsumed proof');
 assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',u.user.id)[0].account_status,'ACTIVE');
}
for(const mode of ['revoked','expired']){
 const u=await register('late-recovery-'+mode);await pending(u);const scoped=await login(u);let authenticated=false;
 db.setBeforeRead(sql=>{if(sql.includes('FROM account_lifecycle_credentials c JOIN users u'))authenticated=true;else if(authenticated&&sql==='PRAGMA table_info(users)'){db.setBeforeRead(null);if(mode==='revoked')db.raw.prepare('DELETE FROM account_lifecycle_credentials WHERE user_id=?').run(u.user.id);else db.raw.prepare('UPDATE account_lifecycle_credentials SET expires_at=? WHERE user_id=?').run(new Date(Date.now()-1).toISOString(),u.user.id);}});
 const r=await call('/api/auth/account/purge-now',scoped.recoveryToken,{confirm:'DELETE'});
 assert.equal(r.status,409,'revoked scoped ownership cannot win the purge claim');
 assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',u.user.id)[0].account_status,'PENDING_DELETION');
}
// In-flight stored response: purge cannot finish while RUNNING; late ID is preserved operationally, no preview
// publishes after closure, and explicit cleanup permits a later purge. Interrupted ID persistence is UNKNOWN.
for(const mode of ['late-return','id-write-crash']){
 const u=await register('work-'+mode),deletionProof=await proof(u);
 env.OPENAI_API_KEY='mock';assert.equal((await call('/api/privacy/ai-import/consent',u.sessionToken,{action:'grant',policyVersion:'ai_import_openai_document_v1'})).status,200);
 let release,started;const invoked=new Promise(resolve=>started=resolve),response=new Promise(resolve=>release=resolve),deleted=[];
 const previous=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
  if(String(url)==='https://api.openai.com/v1/responses'){started();return response;}
  if(String(url).startsWith('https://api.openai.com/v1/responses/')&&init.method==='DELETE'){deleted.push(String(url));return new Response('{}');}
  return previous(url,init);
 };
 const form=new FormData();form.set('importId','job-'+mode);form.set('normalizedDocument',JSON.stringify({fileName:'routine.pdf',fileType:'pdf',blocks:[{type:'paragraph',text:'Squat 3x10'}]}));form.set('file',new Blob(['%PDF-fixture'],{type:'application/pdf'}),'routine.pdf');
 const uploading=worker.fetch(new Request('https://api.reptrio.com/api/import/jobs',{method:'POST',headers:{Authorization:'Bearer '+u.sessionToken},body:form}),env,{});
 await invoked;
 const purge=await call('/api/auth/delete',u.sessionToken,{proof:deletionProof,confirm:'DELETE',method:'DELETE_NOW'});assert.equal(purge.status,503);assert.equal((await purge.json()).code,'ACCOUNT_PURGE_UPSTREAM_UNRESOLVED');assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',u.user.id)[0].account_status,'PURGING');
 if(mode==='id-write-crash')db.setFailOn(/UPDATE account_lifecycle_work SET state='RETURNED'/);
 release(new Response(JSON.stringify({id:'resp_'+mode,status:'queued'}),{headers:{'Content-Type':'application/json'}}));
 assert.notEqual((await uploading).status,202);db.setFailOn(null);
 const lease=db.rows('SELECT state,response_id FROM account_lifecycle_work WHERE user_id=?',u.user.id)[0];
 assert.equal(db.rows('SELECT preview_json FROM import_jobs WHERE user_id=?',u.user.id)[0].preview_json,null);
 if(mode==='late-return'){assert.equal(lease.state,'RESOLVED');assert.equal(deleted.length,1);db.raw.prepare('UPDATE users SET purge_retry_at=NULL WHERE id=?').run(u.user.id);await purgeDueAccounts(env);assert.equal(db.rows('SELECT * FROM users WHERE id=?',u.user.id).length,0);}
 else{assert.equal(lease.state,'UNKNOWN');assert.equal(lease.response_id,null);db.raw.prepare('UPDATE users SET purge_retry_at=NULL WHERE id=?').run(u.user.id);await purgeDueAccounts(env);assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',u.user.id)[0].account_status,'PURGING','unknown upstream never timeout-as-success');}
 globalThis.fetch=previous;
}
// Crash of purge executor is retriable after execution lease expiry; not equivalent to unknown AI outcome.
const crash=await register('purge-crash');await pending(crash);db.raw.prepare("UPDATE users SET account_status='PURGING',purge_at=?,purge_lease='crashed',purge_lease_until=? WHERE id=?").run(new Date(Date.now()-1).toISOString(),new Date(Date.now()-1).toISOString(),crash.user.id);await purgeDueAccounts(env);assert.equal(db.rows('SELECT * FROM users WHERE id=?',crash.user.id).length,0);
// Recovery/purge CAS race: purge wins before recovery statement, never resurrects or changes personal bytes.
const race=await register('recover-race');await pending(race);const raceAuth=await login(race);db.setBeforeBatch(statements=>{if(statements[0].sql.startsWith('UPDATE users SET account_status=\'ACTIVE\'')){db.setBeforeBatch(null);db.raw.prepare("UPDATE users SET account_status='PURGING' WHERE id=?").run(race.user.id);}});assert.equal((await call('/api/auth/account/recover',raceAuth.recoveryToken,{confirm:'RECOVER'})).status,409);assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',race.user.id)[0].account_status,'PURGING');
assert.equal((await call('/api/me',b.sessionToken)).status,200,'other account untouched');
// Query budget counts every batch statement, not just network round trips. Cold password purge fits Free D1.
{
 const local=createD1(),e={...env,DB:local};const u=await(await call('/api/auth/register',null,{email:'query-budget@example.test',password:'fixture-password'},e)).json();
 const token=randomToken(),stamp=new Date().toISOString();local.raw.prepare('INSERT INTO account_lifecycle_credentials(id,user_id,purpose,token_hash,session_hash,created_at,expires_at)VALUES(?,?,?,?,?,?,?)').run('budget',u.user.id,'DELETE_PROOF',await tokenDigest(token),await tokenDigest(u.sessionToken),stamp,new Date(Date.now()+600000).toISOString());
 local.resetMetrics();assert.equal((await call('/api/auth/delete',u.sessionToken,{proof:token,confirm:'DELETE',method:'DELETE_NOW'},e)).status,200);assert.ok(local.metrics.queries<=50,`cold immediate query budget: ${local.metrics.queries}`);
 for(const id of ['cron-budget-a','cron-budget-b'])local.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at,account_status,purge_at)VALUES(?,?,?,?,?,'PENDING_DELETION',?)").run(id,id+'@example.test','fixture','fixture',stamp,new Date(Date.now()-1).toISOString());
 for(let remaining=1;remaining>=0;remaining--){local.resetMetrics();let task;await worker.scheduled({cron:'* * * * *'},e,{waitUntil(p){task=p;}});await task;assert.equal(local.rows('SELECT id FROM users').length,remaining,'bounded cron advances one owner per invocation');assert.ok(local.metrics.queries<=50,`cron query budget: ${local.metrics.queries}`);}
 local.resetMetrics();let maintenance;await worker.scheduled({cron:'*/15 * * * *'},e,{waitUntil(p){maintenance=p;}});await maintenance;assert.ok(!local.trace.some(row=>row.sql.includes('UPDATE account_lifecycle_work')),'legacy maintenance does not share purge budget');
}
globalThis.fetch=realFetch;console.log('Account lifecycle PASS: routed SQLite link scanner/session binding/expiry/replay/mail failure; pending access isolation; exact-byte explicit recovery; deadline cron; FK on/off purge rollback/retry.');
