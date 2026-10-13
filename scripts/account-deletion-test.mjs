import {purgeDueAccounts} from '../worker/account-lifecycle.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { openProviderToken, sealProviderToken, tokenDigest } from '../worker/account-api.js';
import { createD1 } from './lib/d1-sqlite.mjs';

// Issue #6 (App Review Guideline 5.1.1(v)): provider-aware account deletion on real SQLite with the repository
// migrations. Google / Apple users are created through the real OAuth start → callback → mobile exchange path, with
// locally signed ID tokens and a mocked provider network. Covers: email/password, Google, Apple (token stored
// encrypted, revoked at Apple), unauthenticated / unconfirmed requests, no cross-account deletion, every linked
// table cleaned, Apple revoke failure modes, legacy Apple users without a stored token, atomic rollback on a database
// failure, OpenAI-stored import responses, the legacy soft-delete purge migration, and login after deletion.
const ORIGIN = 'https://a2.example';
const encoder = new TextEncoder();
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const jsonB64 = value => b64url(encoder.encode(JSON.stringify(value)));

// ---- Keys: RSA for provider ID tokens, EC P-256 for the Sign in with Apple client secret.
const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', rsa.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64');
const applePrivateKey = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
async function idToken(claims) {
  const input = `${jsonB64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })}.${jsonB64(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, encoder.encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

// ---- Provider network mock.
let mailLink='';
const net = { nonce: null, subject: null, email: null, appleRefreshToken: null, revokeMode: 'ok', revokes: [], openaiDeletes: [], openaiRequests: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if(target==='https://cpaas.zoho.eu/v1.1/email'){mailLink=/#token=([\w-]{43})/.exec(JSON.parse(init.body).textbody)[1];return new Response('{}');}
  const ok = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (target === 'https://www.googleapis.com/oauth2/v3/certs' || target === 'https://appleid.apple.com/auth/keys') return ok({ keys: [jwk] });
  if (target === 'https://oauth2.googleapis.com/token' || target === 'https://appleid.apple.com/auth/token') {
    const apple = target.includes('apple');
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: apple ? 'https://appleid.apple.com' : 'https://accounts.google.com', aud: apple ? 'com.reptrio.signin' : 'google-client', exp: now + 600, iat: now, sub: net.subject, email: net.email, nonce: net.nonce, email_verified: apple ? 'true' : true };
    return ok({ id_token: await idToken(claims), access_token: 'access', token_type: 'bearer', expires_in: 3600, ...(apple && net.appleRefreshToken ? { refresh_token: net.appleRefreshToken } : {}) });
  }
  if (target === 'https://appleid.apple.com/auth/revoke') {
    const form = new URLSearchParams(String(init.body));
    net.revokes.push(Object.fromEntries(form.entries()));
    if (net.revokeMode === 'network') throw new TypeError('fetch failed');
    if (net.revokeMode === 'server') return new Response('', { status: 503 });
    if (net.revokeMode === 'invalid_client') return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 });
    if (net.revokeMode === 'invalid_grant') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(null, { status: 200 });
  }
  if (target === 'https://api.openai.com/v1/responses' && init.method === 'POST') {
    net.openaiRequests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ error: { message: 'test' } }), { status: 500 });
  }
  if (target.startsWith('https://api.openai.com/v1/responses/') && init.method === 'DELETE') {
    net.openaiDeletes.push(target.split('/').pop());
    return ok({ deleted: true });
  }
  throw new Error(`Unexpected network call in test: ${target}`);
};

// Runs twice: with foreign keys (as D1) and without, so every table must be emptied by its own DELETE.
const foreignKeys = process.env.D1_FOREIGN_KEYS !== 'off';
const db = createD1({ foreignKeys });
const env = {
  DB: db, ZEPTOMAIL_API_KEY:'fixture',
  ASSETS: { fetch: async () => new Response('ok') },
  GOOGLE_OAUTH_CLIENT_ID: 'google-client', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  APPLE_OAUTH_CLIENT_ID: 'com.reptrio.signin', APPLE_OAUTH_TEAM_ID: 'TEAM123456', APPLE_OAUTH_KEY_ID: 'KEY1234567', APPLE_OAUTH_PRIVATE_KEY: applePrivateKey,
  OPENAI_API_KEY: 'test-openai-key',
};
const call = (path, init = {}, overrideEnv = env) => worker.fetch(new Request(`${ORIGIN}${path}`, init), overrideEnv, { waitUntil() {} });
const authed = (token, init = {}) => ({ ...init, headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
const deleteRequest = (token, payload) => authed(token, { method: 'POST', body: JSON.stringify(payload) });
const USER_TABLES = ['account_lifecycle_work','account_lifecycle_credentials','ai_import_consent_events','ai_import_consents','personal_restore_identity_journal','personal_restore_records','personal_restore_roots','personal_restore_chunks','personal_restore_operations','sync_mutation_receipts', 'sync_records', 'sync_account_state', 'import_jobs', 'mobile_oauth_codes', 'oauth_reauth_tickets', 'oauth_accounts', 'auth_sessions', 'user_data', 'programs', 'workout_sessions', 'workout_sets', 'user_settings', 'sync_metadata', 'password_reset_tokens'];
const footprint = userId => Object.fromEntries([...USER_TABLES.map(table => [table, db.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId)[0].n]), ['users', db.rows('SELECT COUNT(*) AS n FROM users WHERE id = ?', userId)[0].n]]);
const empty = Object.fromEntries([...USER_TABLES, 'users'].map(table => [table, 0]));

async function register(email, password = 'password123') {
  const response = await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { id: body.user?.id, token: body.sessionToken||body.recoveryToken, email };
}

async function oauthLogin(provider, subject, email, appleRefreshToken = null) {
  const start = await call(`/api/auth/oauth/${provider}/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}`);
  assert.equal(start.status, 302);
  const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]);
  const state = cookies.find(value => value.startsWith('aks_oauth_state=')).split('=')[1];
  net.nonce = cookies.find(value => value.startsWith('aks_oauth_nonce=')).split('=')[1];
  net.subject = subject; net.email = email; net.appleRefreshToken = appleRefreshToken;
  const callback = provider === 'apple'
    ? await call('/api/auth/oauth/apple/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.join('; ') }, body: new URLSearchParams({ code: 'provider-code', state }) })
    : await call(`/api/auth/oauth/google/callback?code=provider-code&state=${state}`, { headers: { Cookie: cookies.join('; ') } });
  assert.equal(callback.status, 303);
  const location = new URL(callback.headers.get('Location'));
  assert.equal(location.protocol, 'reptrio:', `oauth callback error: ${location}`);
  const exchange = await call('/api/auth/oauth/mobile/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ code: location.searchParams.get('code') }) });
  assert.equal(exchange.status, 201);
  const body = await exchange.json();
  return { id: body.user?.id, token: body.sessionToken||body.recoveryToken, email };
}

// Apple re-authorization for deletion: ticket from the signed-in app, Apple sign-in with `reauth=<ticket>`; returns the
// callback redirect (reptrio://auth?reauth=ok or ?auth_error=…).
async function appleReauth(token, subject, email, refreshToken, ticketOverride = null) {
  const ticketResponse = await call('/api/auth/reauth/apple', authed(token, { method: 'POST', body: '{}' }));
  const ticket = ticketOverride ?? (await ticketResponse.json()).ticket;
  const start = await call(`/api/auth/oauth/apple/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}&reauth=${ticket}`);
  const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]);
  const state = cookies.find(value => value.startsWith('aks_oauth_state=')).split('=')[1];
  net.nonce = cookies.find(value => value.startsWith('aks_oauth_nonce=')).split('=')[1];
  net.subject = subject; net.email = email; net.appleRefreshToken = refreshToken;
  const callback = await call('/api/auth/oauth/apple/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.join('; ') }, body: new URLSearchParams({ code: 'provider-code', state }) });
  assert.equal(callback.status, 303);
  return { location: new URL(callback.headers.get('Location')), ticket };
}

// Gives the account data in every user table: sync payload (programs, sessions, sets, settings with profile photo),
// an import job with an OpenAI response id, an unused mobile OAuth code and a password reset link.
async function seed(user, tag) {
  const data = { schemaVersion: 8, programs: [{ id: `p-${tag}` }], sessions: [{ id: `s-${tag}`, sets: { e1: { 1: { weight: '50', reps: '5', completed: true } } } }], settings: { profile: { displayName: tag, avatarDataUrl: 'data:image/jpeg;base64,AAAA' } } };
  const push = await call('/api/sync/push', authed(user.token, { method: 'POST', body: JSON.stringify({ data, syncVersion: 0 }) }));
  assert.equal(push.status, 200);
  const now = new Date().toISOString();
  // Legacy projections are intentionally retained without dual write. Seed them independently so deletion proves
  // both generations are cleaned, including with foreign keys disabled.
  db.raw.prepare('INSERT INTO user_data (user_id,payload_json,sync_version,updated_at) VALUES (?,?,0,?)').run(user.id,JSON.stringify(data),now);
  for (const table of ['programs','workout_sessions']) db.raw.prepare(`INSERT INTO ${table} (id,user_id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?)`).run(`${table}-${tag}`,user.id,'{}',now,now);
  db.raw.prepare('INSERT INTO workout_sets (id,user_id,session_id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(`set-${tag}`,user.id,`s-${tag}`,'{}',now,now);
  db.raw.prepare('INSERT INTO user_settings (user_id,payload_json,updated_at) VALUES (?,?,?)').run(user.id,'{}',now);
  db.raw.prepare('INSERT INTO sync_metadata (user_id,sync_version,updated_at) VALUES (?,0,?)').run(user.id,now);
  db.raw.prepare("INSERT INTO import_jobs (id, user_id, status, source_json, normalized_document_json, openai_response_id, created_at, updated_at) VALUES (?, ?, 'done', '{}', '{}', ?, ?, ?)").run(`job-${tag}`, user.id, `resp_${tag}`, now, now);
  db.raw.prepare('INSERT INTO mobile_oauth_codes (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(`code-${tag}`, user.id, `hash-${tag}`, now, now);
  db.raw.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(`reset-${tag}`, user.id, `reset-hash-${tag}`, now, now);
  // Populate every new account-scoped table, so FK-OFF verifies actual explicit cleanup rather than empty schemas.
  db.raw.prepare("INSERT INTO ai_import_consents VALUES(?, 'ai_import_openai_document_v1', ?,NULL,?)").run(user.id,now,now);
  db.raw.prepare("INSERT INTO ai_import_consent_events VALUES(?,?,'grant','ai_import_openai_document_v1',?)").run('consent-'+tag,user.id,now);
  db.raw.prepare("INSERT INTO sync_mutation_receipts VALUES(?,?,'h','p',0,1,'{}',?,?)").run(user.id,'receipt-'+tag,now,now);
  const op='restore-'+tag;
  db.raw.prepare("INSERT INTO personal_restore_operations(user_id,operation_id,purpose,source_namespace,archive_retry_hash,local_binding,data_schema_version,expected_chunks,expected_counts_json,base_revision,state,expires_at,created_at,updated_at)VALUES(?,?,'RESTORE','source','archive','binding',8,1,'{}',0,'READY',?,?,?)").run(user.id,op,now,now,now);
  db.raw.prepare("INSERT INTO personal_restore_roots(user_id,operation_id,root_id,root_kind,source_tuple,source_ordinal,portable_hash,counts_json)VALUES(?,?,0,'session','[\"source\"]',0,'h','{}')").run(user.id,op);
  db.raw.prepare("INSERT INTO personal_restore_records(user_id,operation_id,root_id,item_ordinal,kind,record_key,ordinal,address_json,payload_json,source_tuple,portable_hash)VALUES(?,?,0,0,'session','[\"source\"]',0,'{}','{}','[\"source\"]','h')").run(user.id,op);
  db.raw.prepare("INSERT INTO personal_restore_chunks VALUES(?,?,0,'h',1,1,'{}',2)").run(user.id,op);
  db.raw.prepare("INSERT INTO personal_restore_identity_journal(user_id,source_namespace,kind,source_tuple,target_kind,target_key,target_path,operation_id,import_hash,address_hash,target_ordinal,added_revision,disposition,state)VALUES(?,'source','session','[\"source\"]','session','[\"source\"]','[]',?,'h','h',0,1,'ADDED','LIVE')").run(user.id,op);
  db.raw.prepare("INSERT INTO account_lifecycle_work VALUES(?,?,'RESOLVED',NULL,?,?,NULL)").run('work-'+tag,user.id,now,now);
  db.raw.prepare("INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at)VALUES(?,?,?,?,'RECOVERY',?,?)").run('lifecycle-'+tag,user.id,'credential-'+tag,'session-'+tag,now,new Date(Date.now()+600000).toISOString());
  db.raw.prepare('INSERT INTO oauth_reauth_tickets(id,user_id,ticket_hash,created_at,expires_at)VALUES(?,?,?,?,?)').run('ticket-'+tag,user.id,'ticket-hash-'+tag,now,new Date(Date.now()+600000).toISOString());

}


const info=async user=>{const r=await call('/api/auth/delete',authed(user.token));assert.equal(r.status,200);return r.json();};
async function proof(user){
 db.raw.prepare("DELETE FROM account_lifecycle_credentials WHERE user_id=? AND purpose='DELETE_LINK'").run(user.id);
 assert.equal((await call('/api/auth/delete/request-link',deleteRequest(user.token,{}))).status,202);
 const r=await call('/api/auth/delete/verify-link',deleteRequest(user.token,{token:mailLink}));assert.equal(r.status,200);return(await r.json()).proof;
}
async function remove(user,extra={},override=env){const r=await call('/api/auth/delete',deleteRequest(user.token,{proof:await proof(user),confirm:'DELETE',method:'DELETE_NOW',...extra}),override);return {status:r.status,body:await r.json()};}
const bystander=await register('bystander@example.test');await seed(bystander,'bystander');const before=footprint(bystander.id);
for(const provider of ['password','google','apple']){
 const u=provider==='password'?await register('password@example.test'):await oauthLogin(provider,provider+'-sub',provider+'@example.test',provider==='apple'?'refresh':null);
 await seed(u,provider);const metadata=await info(u);assert.equal(metadata.requiresPassword,false);assert.equal(metadata.contractVersion,2);
 assert.equal((await call('/api/auth/delete',deleteRequest(u.token,{confirm:'DELETE',password:'password123'}))).status,401,'password/session alone never deletes');
 const r=await remove(u,{userId:bystander.id});assert.equal(r.status,200);assert.equal(r.body.accountStatus,'DELETED');assert.deepEqual(footprint(u.id),empty);assert.deepEqual(footprint(bystander.id),before);
}
// Exact linked provider proof, state/nonce checks, mismatch never links/creates/switches account.
const owner=await oauthLogin('apple','legacy-apple','legacy@example.test',null);
db.raw.prepare("UPDATE users SET credential_origin='UNKNOWN',email_verified_at=NULL WHERE id=?").run(owner.id);
assert.equal((await info(owner)).requiresPassword,false);const countBefore=db.rows('SELECT COUNT(*) AS n FROM users')[0].n;
const mismatch=await appleReauth(owner.token,'wrong-sub','wrong@example.test','wrong-refresh');assert.equal(mismatch.location.searchParams.get('auth_error'),'OAUTH_REAUTH_MISMATCH');assert.equal(db.rows('SELECT COUNT(*) AS n FROM users')[0].n,countBefore);
const good=await appleReauth(owner.token,'legacy-apple','legacy@example.test','legacy-refresh');const providerProof=new URLSearchParams(good.location.hash.slice(1)).get('proof');assert.ok(providerProof);assert.equal(good.location.searchParams.get('code'),null);
const providerDelete=await call('/api/auth/delete',deleteRequest(owner.token,{confirm:'DELETE',proof:providerProof,method:'DELETE_NOW'}));assert.equal(providerDelete.status,200);assert.deepEqual(footprint(owner.id),empty);
// Provider dependency preflight never knowingly schedules missing/corrupt/unreadable Apple material.
for(const mode of ['missing','corrupt','rotated','config']){
 const u=await oauthLogin('apple','prerequisite-'+mode,mode+'-prerequisite@example.test','original-'+mode);await seed(u,'prerequisite-'+mode);const p=await proof(u);
 if(mode==='missing')db.raw.prepare("UPDATE oauth_accounts SET refresh_token_ciphertext=NULL WHERE user_id=?").run(u.id);
 if(mode==='corrupt')db.raw.prepare("UPDATE oauth_accounts SET refresh_token_ciphertext='v1.invalid.invalid' WHERE user_id=?").run(u.id);
 const e=mode==='rotated'?{...env,APPLE_OAUTH_PRIVATE_KEY:'changed-key'}:mode==='config'?{...env,APPLE_OAUTH_TEAM_ID:''}:env;
 assert.equal((await(await call('/api/auth/delete',authed(u.token),e)).json()).appleReauthRequired,true);
 const before=JSON.stringify(Object.fromEntries([...USER_TABLES.map(table=>[table,db.rows(`SELECT * FROM ${table} WHERE user_id=?`,u.id)]),['users',db.rows('SELECT * FROM users WHERE id=?',u.id)]])),revokes=net.revokes.length;
 db.resetMetrics();const blocked=await call('/api/auth/delete',deleteRequest(u.token,{proof:p,confirm:'DELETE'}),e);assert.equal(blocked.status,mode==='config'?503:409);assert.equal((await blocked.json()).code,mode==='config'?'APPLE_REVOKE_UNAVAILABLE':'APPLE_REAUTH_REQUIRED');assert.equal(db.metrics.writes,0);assert.equal(net.revokes.length,revokes);assert.equal(JSON.stringify(Object.fromEntries([...USER_TABLES.map(table=>[table,db.rows(`SELECT * FROM ${table} WHERE user_id=?`,u.id)]),['users',db.rows('SELECT * FROM users WHERE id=?',u.id)]])),before);
 const reauth=await appleReauth(u.token,'prerequisite-'+mode,mode+'-prerequisite@example.test','fresh-'+mode);assert.ok(new URLSearchParams(reauth.location.hash.slice(1)).get('proof'));
 const scheduled=await call('/api/auth/delete',deleteRequest(u.token,{proof:p,confirm:'DELETE'}));assert.equal(scheduled.status,200);assert.equal(net.revokes.length,revokes,'no revoke at scheduling');assert.ok(db.rows('SELECT refresh_token_ciphertext FROM oauth_accounts WHERE user_id=?',u.id)[0].refresh_token_ciphertext);
 db.raw.prepare('UPDATE users SET purge_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),u.id);
 if(mode==='config'){net.revokeMode='server';await purgeDueAccounts(env);assert.equal(db.rows('SELECT account_status,purge_error FROM users WHERE id=?',u.id)[0].account_status,'PURGING');assert.ok(db.rows('SELECT purge_retry_at FROM users WHERE id=?',u.id)[0].purge_retry_at);net.revokeMode='ok';db.raw.prepare('UPDATE users SET purge_retry_at=NULL WHERE id=?').run(u.id);}
 await purgeDueAccounts(env);assert.deepEqual(footprint(u.id),empty,'deadline revoke and complete cleanup');
}
// External failure blocks final success and preserves personal rows in PURGING. Scoped OAuth recovery allows retry.
for(const mode of ['network','server','invalid_client','invalid_grant']){
 const u=await oauthLogin('apple','failure-'+mode,mode+'@example.test','refresh-'+mode);await seed(u,'failure-'+mode);net.revokeMode=mode;
 const r=await remove(u);assert.notEqual(r.status,200);assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',u.id)[0].account_status,'PURGING');assert.equal(footprint(u.id).user_data,1);assert.equal(footprint(u.id).auth_sessions,0);
 net.revokeMode='ok';const rec=await oauthLogin('apple','failure-'+mode,mode==='invalid_grant'?null:mode+'@example.test','refresh-'+mode);
 const scoped=await(await call('/api/auth/account/status',authed(rec.token))).json();assert.equal(scoped.user.id,u.id);assert.deepEqual(scoped.providers,['apple']);assert.equal(scoped.ownershipVerificationRequired,true);assert.equal((await call('/api/auth/account/purge-now',deleteRequest(rec.token,{confirm:'DELETE'}))).status,401,'provider login alone cannot finalize without new ticket proof');
 // helper returns recovery auth below; explicit purge retries same owner and leaves no data.
 assert.equal((await appleReauth(rec.token,'failure-'+mode,mode+'@example.test','refresh-'+mode)).location.searchParams.get('reauth'),'ok');
 const result=await call('/api/auth/account/purge-now',deleteRequest(rec.token,{confirm:'DELETE'}));assert.equal(result.status,200);assert.deepEqual(footprint(u.id),empty);
}
// Partial cleanup schema is rejected before state/external mutation. SQL exceptions rollback full cleanup.
for(const table of ['sync_mutation_receipts','personal_restore_records','ai_import_consents']){
 const local=createD1({foreignKeys:false}),e={...env,DB:local};const id='partial-'+table,now=new Date().toISOString(),token='fixture-session-'+table,p='P'.repeat(43);
 local.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at,credential_origin)VALUES(?,?,?,? ,?,'PASSWORD')").run(id,id+'@example.test','hash','salt',now);
 local.raw.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at)VALUES(?,?,?,?,?)').run('s',id,await tokenDigest(token),now,new Date(Date.now()+600000).toISOString());
 local.raw.prepare("INSERT INTO account_lifecycle_credentials(id,user_id,token_hash,session_hash,purpose,created_at,expires_at)VALUES('p',?,?,?,'DELETE_PROOF',?,?)").run(id,await tokenDigest(p),await tokenDigest(token),now,new Date(Date.now()+600000).toISOString());
 local.exec(`DROP TABLE ${table}`);const revokes=net.revokes.length;local.resetMetrics();const response=await call('/api/auth/delete',deleteRequest(token,{confirm:'DELETE',proof:p,method:'DELETE_NOW'}),e);assert.equal(response.status,503);assert.equal(local.metrics.writes,0);assert.equal(net.revokes.length,revokes);assert.equal(local.rows('SELECT account_status FROM users')[0].account_status,'ACTIVE');
}
// Legacy soft-delete maintenance is explicit only; pending accounts have no deleted_at and survive this script.
const fs=await import('node:fs');const maintenance=fs.readFileSync(new URL('./maintenance/purge-soft-deleted-accounts.sql',import.meta.url),'utf8');
const pendingUser=await register('pending-maintenance@example.test');const pendingProof=await proof(pendingUser);assert.equal((await call('/api/auth/delete',deleteRequest(pendingUser.token,{proof:pendingProof,confirm:'DELETE'}))).status,200);db.exec(maintenance);assert.equal(db.rows('SELECT account_status FROM users WHERE id=?',pendingUser.id)[0].account_status,'PENDING_DELETION');
assert.deepEqual(footprint(bystander.id),before);
globalThis.fetch=realFetch;
console.log(`Account deletion PASS FK=${foreignKeys}: all related tables, password/Google/Apple routes, encrypted token binding, fresh linked proof/mismatch, upstream retry, preflight partial schema, explicit legacy maintenance.`);
if(foreignKeys)execFileSync(process.execPath,[fileURLToPath(import.meta.url)],{stdio:'inherit',env:{...process.env,D1_FOREIGN_KEYS:'off'}});
