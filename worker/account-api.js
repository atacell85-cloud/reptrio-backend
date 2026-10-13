import { activeAccountDB, lifecycleReady, handleLifecycleRequest, issueRecovery, createDeleteProof, recoveryOwner } from './account-lifecycle.js';
import { personalRestoreRequest } from './personal-restore-api.js';
import { aiConsentDeletionTables } from './ai-import-consent.js';
import { recordPage, recordMutation } from './record-sync-transport.js';
import { recordPull, recordPush, recordCapabilities, storageCleanupMode, PERSONAL_RESTORE_TABLES } from './record-sync-storage.js';
const encoder = new TextEncoder();
const SESSION_DAYS = 30;
const OAUTH_STATE_COOKIE = 'aks_oauth_state';
const OAUTH_NONCE_COOKIE = 'aks_oauth_nonce';
const OAUTH_CLIENT_COOKIE = 'aks_oauth_client';
const OAUTH_REDIRECT_COOKIE = 'aks_oauth_redirect';
const OAUTH_REAUTH_COOKIE = 'aks_oauth_reauth';
const REAUTH_TICKET_MINUTES = 10;
const MOBILE_OAUTH_CODE_MINUTES = 5;
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const PROVIDER_TIMEOUT_MS = 10_000;
// Cloudflare Workers caps WebCrypto PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

export async function handleAccountRequest(request, env, pathname) {
  const lifecycle=await handleLifecycleRequest(request,env,pathname);if(lifecycle)return lifecycle;
  if (pathname === '/api/auth/providers') return authProviders(request, env);
  if (pathname === '/api/auth/oauth/mobile/exchange') return mobileOAuthExchange(request, env);
  const oauthMatch = pathname.match(/^\/api\/auth\/oauth\/(google|apple)\/(start|callback)$/);
  if (oauthMatch) return oauth(request, env, oauthMatch[1], oauthMatch[2]);
  if (pathname === '/api/auth/register') return register(request, env);
  if (pathname === '/api/auth/login') return login(request, env);
  if (pathname === '/api/auth/logout') return logout(request, env);
  if (/^\/api\/auth\/reauth\/(apple|google)$/.test(pathname)) return createAppleReauthTicket(request, env,pathname.endsWith('google')?'google':'apple');
  if (pathname === '/api/auth/delete') return request.method === 'GET' ? deletionInfo(request, env) : deleteAccount(request, env);
  if (pathname === '/api/me') return me(request, env);
  if (pathname === '/api/sync/pull') return pull(request, env);
  if (pathname === '/api/sync/push') return push(request, env);
  const personal=pathname.match(/^\/api\/(backup\/restore|sync\/records)\/operations(?:\/([^/]+)(?:\/(chunks|finalize|preview|commit|receipt|cancel|undo-preview|undo))?)?$/);
  if(personal)return personalOperations(request,env,personal);
  if (pathname === '/api/sync/records') return records(request,env);
  if (pathname === '/api/sync/records/mutations') return mutations(request,env);
  if (pathname === '/api/sync/capabilities') return capabilities(request, env);
  return null;
}

async function authProviders(request, env) {
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
  return json({
    providers: {
      google: oauthConfig(env, 'google').ready,
      apple: oauthConfig(env, 'apple').ready,
    },
  });
}

async function oauth(request, env, provider, action) {
  if (action === 'start') return oauthStart(request, env, provider);
  return oauthCallback(request, env, provider);
}

async function oauthStart(request, env, provider) {
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
  const config = oauthConfig(env, provider);
  if (!config.ready) return oauthErrorRedirect(request, 'OAUTH_PROVIDER_NOT_CONFIGURED');
  const url = new URL(request.url);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const mobile = url.searchParams.get('client') === 'mobile';
  const mobileRedirect = mobileRedirectUri(url.searchParams.get('redirect_uri'));
  const redirectUri = oauthRedirectUri(request, provider);
  const destination = new URL(config.authorizationUrl);
  destination.searchParams.set('client_id', config.clientId);
  destination.searchParams.set('redirect_uri', redirectUri);
  destination.searchParams.set('response_type', 'code');
  destination.searchParams.set('scope', config.scope);
  destination.searchParams.set('state', state);
  destination.searchParams.set('nonce', nonce);
  if (provider === 'apple') destination.searchParams.set('response_mode', 'form_post');
  const headers = new Headers({ Location: destination.toString() });
  headers.append('Set-Cookie', shortCookie(OAUTH_STATE_COOKIE, state));
  headers.append('Set-Cookie', shortCookie(OAUTH_NONCE_COOKIE, nonce));
  if (mobile) headers.append('Set-Cookie', shortCookie(OAUTH_CLIENT_COOKIE, 'mobile'));
  if (mobile && mobileRedirect) headers.append('Set-Cookie', shortCookie(OAUTH_REDIRECT_COOKIE, mobileRedirect));
  const reauthTicket = mobile ? String(url.searchParams.get('reauth') || '').trim() : '';
  // Every start sets or clears the re-authorization cookie, so a cancelled re-authorization can never turn a later
  // normal sign-in on the same browser into a re-authorization.
  headers.append('Set-Cookie', reauthTicket && /^[A-Za-z0-9_-]{20,100}$/.test(reauthTicket) ? shortCookie(OAUTH_REAUTH_COOKIE, reauthTicket) : clearNamedCookie(OAUTH_REAUTH_COOKIE));
  headers.append('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

async function oauthCallback(request, env, provider) {
  if (request.method !== 'GET' && request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'GET, POST' });
  const values = request.method === 'POST' ? await request.formData().then(form => Object.fromEntries(form.entries())).catch(() => ({})) : Object.fromEntries(new URL(request.url).searchParams.entries());
  const expectedState = cookie(request, OAUTH_STATE_COOKIE);
  const expectedNonce = cookie(request, OAUTH_NONCE_COOKIE);
  const mobile = cookie(request, OAUTH_CLIENT_COOKIE) === 'mobile';
  const mobileRedirect = mobileRedirectUri(cookie(request, OAUTH_REDIRECT_COOKIE));
  const reauthTicket = cookie(request, OAUTH_REAUTH_COOKIE);
  const clearHeaders = [clearNamedCookie(OAUTH_STATE_COOKIE), clearNamedCookie(OAUTH_NONCE_COOKIE), clearNamedCookie(OAUTH_CLIENT_COOKIE), clearNamedCookie(OAUTH_REDIRECT_COOKIE), clearNamedCookie(OAUTH_REAUTH_COOKIE)];
  if (!values.code || !values.state || !expectedState || !constantEqual(String(values.state), expectedState)) return oauthErrorRedirect(request, 'OAUTH_STATE_INVALID', clearHeaders, mobileRedirect);
  const config = oauthConfig(env, provider);
  if (!config.ready) return oauthErrorRedirect(request, 'OAUTH_PROVIDER_NOT_CONFIGURED', clearHeaders, mobileRedirect);
  try {
    const token = await exchangeOAuthCode(request, config, provider, String(values.code));
    const claims = await decodeAndVerifyIdToken(token.id_token, config);
    validateIdTokenClaims(claims, config, expectedNonce);
    if (reauthTicket && mobile && mobileRedirect) return completeAppleReauth(request, env, config, reauthTicket, String(claims.sub), token.refresh_token, mobileRedirect, clearHeaders,provider);
    const email = normalizeEmail(claims.email);
    const user = await upsertOAuthUser(env, provider, String(claims.sub), email, providerEmailVerified(provider, claims), providerEmailTrusted(provider, claims, email));
    if (provider === 'apple') await storeAppleRefreshToken(env, config, String(claims.sub), token.refresh_token);
    if(user.account_status&&user.account_status!=='ACTIVE'&&!(mobile&&mobileRedirect))throw coded('ACCOUNT_RECOVERY_MOBILE_REQUIRED');
    if (mobile && mobileRedirect) return issueMobileOAuthCode(env, user.id, mobileRedirect, clearHeaders);
    return issueSession(env, user.id, user.email, 303, { Location: new URL('/', request.url).toString(), 'Set-Cookie': clearHeaders });
  } catch (error) {
    return oauthErrorRedirect(request, error.code || 'OAUTH_FAILED', clearHeaders, mobileRedirect);
  }
}

async function mobileOAuthExchange(request, env) {
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  if (!mobileClient(request)) return error('MOBILE_CLIENT_REQUIRED', 403);
  const { code } = await body(request);
  const codeText = String(code || '').trim();
  if (!codeText) return error('OAUTH_CODE_INVALID', 400);
  const hash = await tokenDigest(codeText);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(`SELECT mobile_oauth_codes.id, mobile_oauth_codes.user_id, users.email, users.*
    FROM mobile_oauth_codes
    JOIN users ON users.id = mobile_oauth_codes.user_id
    WHERE mobile_oauth_codes.code_hash = ?
      AND mobile_oauth_codes.expires_at > ?
      AND mobile_oauth_codes.used_at IS NULL
      AND users.deleted_at IS NULL`).bind(hash, now).first();
  if (!row) return error('OAUTH_CODE_INVALID', 401);
  const consumed=await env.DB.prepare('UPDATE mobile_oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at>?').bind(now,hash,now).run();
  if(consumed.meta.changes!==1)return error('OAUTH_CODE_INVALID',401);
  if(row.account_status&&row.account_status!=='ACTIVE')return issueRecovery(env,row.user_id,{freshOwnership:false});
  return issueSession(env, row.user_id, row.email, 201, { 'X-Reptrio-Client': 'mobile' });
}

async function exchangeOAuthCode(request, config, provider, code) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: provider === 'apple' ? await appleClientSecret(config) : config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: oauthRedirectUri(request, provider)
  });
  const response = await fetch(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id_token) throw coded(mapOAuthTokenError(payload.error));
  return payload;
}

function validateIdTokenClaims(claims, config, expectedNonce) {
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.issuer) throw coded('OAUTH_ISSUER_INVALID');
  if (claims.aud !== config.clientId) throw coded('OAUTH_AUDIENCE_INVALID');
  if (Number(claims.exp || 0) <= now) throw coded('OAUTH_TOKEN_EXPIRED');
  if (!expectedNonce || !claims.nonce || !constantEqual(String(claims.nonce), expectedNonce)) throw coded('OAUTH_NONCE_INVALID');
  if (!claims.sub) throw coded('OAUTH_SUBJECT_MISSING');
}

// Whether the provider asserts the ID token's email as verified, from the signature-verified token only (never the
// callback body). Google: `email_verified` is a boolean and must be exactly true. Apple: the claim is "true" or true
// (Apple may report false, e.g. for Apple at Work & School accounts).
export function providerEmailVerified(provider, claims) {
  if (provider === 'google') return claims.email_verified === true;
  if (provider === 'apple') return claims.email_verified === true || claims.email_verified === 'true';
  return false;
}

// Whether the email is trusted enough to link this identity to an EXISTING account. Google documents that it is
// authoritative for an email only for @gmail.com addresses, or when email_verified is true and `hd` (Workspace hosted
// domain) is set — here it must also be the email's domain. Otherwise a once-verified address (e.g. a former
// employee's company email kept on a consumer Google account) proves nothing about its current owner. Apple: its
// verified email (accepted per the product decision; Private Relay addresses are unique per app).
export function providerEmailTrusted(provider, claims, email) {
  if (!providerEmailVerified(provider, claims)) return false;
  if (provider === 'apple') return true;
  const domain = String(email || '').split('@')[1] || '';
  return domain === 'gmail.com' || (typeof claims.hd === 'string' && claims.hd.length > 0 && claims.hd.toLowerCase() === domain);
}

// OAuth identity → Reptrio account (issue #12). The identity key is provider + `sub`, never the email.
// 1. A linked provider + sub signs in to its account (even when the provider email changed).
// 2. Not linked, and an account with this email exists: link only when this identity's email is trusted (see
//    `providerEmailTrusted`) AND the account's email was itself proven by the trusted provider identity that created it. A password account's email
//    was never verified (registration does not prove ownership), so linking it by email could hand someone else's
//    pre-registered account to the email owner or vice versa. Otherwise fail closed — no link, no duplicate account.
// 3. No account: create one only for a verified email (an unverified one could squat the address); the user and its
//    first link are written atomically.
async function upsertOAuthUser(env, provider, subject, email, emailVerified, emailTrusted) {
  const now = new Date().toISOString();
  const trusted = emailTrusted ? 1 : 0;
  const linked = await env.DB.prepare('SELECT users.* FROM oauth_accounts JOIN users ON users.id = oauth_accounts.user_id WHERE oauth_accounts.provider = ? AND oauth_accounts.provider_subject = ? AND users.deleted_at IS NULL').bind(provider, subject).first();
  if (linked) {
    if(linked.account_status&&linked.account_status!=='ACTIVE')return linked;
    if(!email){await env.DB.prepare('UPDATE oauth_accounts SET last_login_at=? WHERE provider=? AND provider_subject=?').bind(now,provider,subject).run();return linked;}
    await env.DB.prepare('UPDATE oauth_accounts SET email = ?, email_trusted = ?, last_login_at = ? WHERE provider = ? AND provider_subject = ?').bind(email, trusted, now, provider, subject).run();
    return linked;
  }
  if(!email)throw coded('OAUTH_EMAIL_MISSING');
  const link = userId => env.DB.prepare('INSERT INTO oauth_accounts (provider, provider_subject, user_id, email, email_trusted, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(provider, subject, userId, email, trusted, now, now);
  const user = await env.DB.prepare('SELECT id, email, created_at FROM users WHERE email = ? AND deleted_at IS NULL').bind(email).first();
  if (user) {
    if (!emailTrusted || !(await emailProvenByProvider(env, user))) throw coded('OAUTH_ACCOUNT_LINK_REQUIRES_VERIFICATION');
    await link(user.id).run();
    return { id: user.id, email: user.email };
  }
  if (!emailVerified) throw coded('OAUTH_EMAIL_UNVERIFIED');
  // New account provenance and first provider identity are committed atomically; legacy rows remain UNKNOWN.
  const id = crypto.randomUUID();
  const salt = randomToken(16);
  const passwordHash = await passwordDigest(randomToken(32), salt);
  await env.DB.batch([
    await newUserInsert(env, id, email, passwordHash, salt, now,provider.toUpperCase()),
    link(id),
  ]);
  return { id, email };
}

// The account was created by a provider identity whose email is trusted and is still the account's email: its creating
// link carries the account's creation time, email_trusted = 1 as of its latest sign-in, and the same email as the
// account (a provider email change leaves the old address unproven). Password accounts and legacy rows (NULL) are not.
async function emailProvenByProvider(env,user){
 const columns=(await env.DB.prepare('PRAGMA table_info(users)').all()).results;
 if(!columns.some(c=>c.name==='credential_origin'))return false;
 const owner=await env.DB.prepare("SELECT credential_origin,email_verified_at,account_status FROM users WHERE id=?").bind(user.id).first();
 if(!owner||owner.account_status!=='ACTIVE'||!owner.email_verified_at||!['GOOGLE','APPLE'].includes(owner.credential_origin))return false;
 return Boolean(await env.DB.prepare('SELECT 1 AS proven FROM oauth_accounts WHERE user_id=? AND provider=? AND email_trusted=1 AND lower(email)=lower(?) LIMIT 1').bind(user.id,owner.credential_origin.toLowerCase(),user.email).first());
}

async function register(request, env) {
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  const { email, password } = await body(request);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return error('AUTH_INVALID_EMAIL', 400);
  if (!validPassword(password)) return error('AUTH_PASSWORD_TOO_SHORT', 400);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').bind(normalizedEmail).first();
  if (exists) return error('AUTH_EMAIL_IN_USE', 409);
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const salt = randomToken(16); const passwordHash = await passwordDigest(password, salt);
  await (await newUserInsert(env, id, normalizedEmail, passwordHash, salt, now)).run();
  return issueSession(env, id, normalizedEmail, 201, mobileClient(request) ? { 'X-Reptrio-Client': 'mobile' } : {});
}

async function login(request, env) {
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  const { email, password } = await body(request); const normalizedEmail = normalizeEmail(email);
  const user = normalizedEmail && await env.DB.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').bind(normalizedEmail).first();
  if (!user || !validPassword(password) || !constantEqual(await passwordDigest(password, user.password_salt), user.password_hash)) return error('AUTH_INVALID_CREDENTIALS', 401);
  if(user.account_status&&user.account_status!=='ACTIVE')return issueRecovery(env,user.id);
  return issueSession(env, user.id, user.email, 201, mobileClient(request) ? { 'X-Reptrio-Client': 'mobile' } : {});
}

async function logout(request, env) {
  if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'POST' });
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  const token = sessionToken(request);
  if(token){const hash=await tokenDigest(token);await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(hash).run();
    const lifecycle=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_lifecycle_credentials'").all()).results||[];
    if(lifecycle.length)await env.DB.batch([env.DB.prepare('DELETE FROM account_lifecycle_credentials WHERE session_hash=? OR token_hash=?').bind(hash,hash),env.DB.prepare('DELETE FROM oauth_reauth_tickets WHERE session_hash=?').bind(hash)]);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

async function me(request, env) {
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
  const user = await currentUser(request, env);
  return user ? json({ user: await publicUser(env, user.id, user.email) }) : error('AUTH_REQUIRED', 401);
}

async function pull(request, env) {
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
  const user = await currentUser(request, env); if (!user) return error('AUTH_REQUIRED', 401);
  return recordPull(env, user.id);
}

async function capabilities(request, env) {
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
  const user = await currentUser(request, env); if (!user) return error('AUTH_REQUIRED', 401);
  return recordCapabilities(env, user.id);
}

async function records(request,env) {
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED',405,{Allow:'GET'});
  const user=await currentUser(request,env); if (!user) return error('AUTH_REQUIRED',401);
  return recordPage(request,env,user.id);
}
async function mutations(request,env) {
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID',403);
  const user=await currentUser(request,env); if (!user) return error('AUTH_REQUIRED',401);
  return recordMutation(request,env,user.id);
}

async function push(request, env) {
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  const user = await currentUser(request, env); if (!user) return error('AUTH_REQUIRED', 401);
  return recordPush(request, env, user.id);
}

// ---- Apple re-authorization for account deletion (legacy Apple users without a stored token).
// The signed-in app asks for a single-use ticket bound to its account, opens Apple sign-in with it, and the callback
// only stores the Apple token when that Apple ID is already linked to the same account. It never creates, links or
// switches accounts and issues no session, so another Apple ID cannot redirect the deletion to a different account.
async function createAppleReauthTicket(request,env,provider='apple'){
 if(!isJsonPost(request))return methodOrTypeError(request);if(!sameOrigin(request))return error('AUTH_ORIGIN_INVALID',403);
 await lifecycleReady(env.DB);
 if(env.ACCOUNT_LIFECYCLE_LIMITER){try{const r=await env.ACCOUNT_LIFECYCLE_LIMITER.limit({key:'provider:'+provider+':'+(request.headers.get('cf-connecting-ip')||'unknown')});if(r?.success===false)return error('ACCOUNT_LIFECYCLE_RATE_LIMITED',429);}catch{return error('ACCOUNT_LIFECYCLE_RATE_LIMITED',429);}}
 const user=await currentUser(request,env)||await recoveryOwner(request,env);if(!user)return error('AUTH_REQUIRED',401);
 const linked=await env.DB.prepare('SELECT provider_subject FROM oauth_accounts WHERE user_id=? AND provider=?').bind(user.id,provider).first();
 if(!linked)return error('OAUTH_REAUTH_NOT_LINKED',409);
 const ticket=randomToken(32),stamp=new Date();
 await env.DB.prepare('INSERT INTO oauth_reauth_tickets(id,user_id,ticket_hash,created_at,expires_at,provider,session_hash)VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),user.id,await tokenDigest(ticket),stamp.toISOString(),new Date(stamp.getTime()+600000).toISOString(),provider,await tokenDigest(sessionToken(request))).run();return json({ticket,provider});
}
async function completeAppleReauth(request,env,config,ticket,subject,refreshToken,mobileRedirect,cookies,provider='apple'){
 const now=new Date().toISOString(),hash=await tokenDigest(ticket);
 const row=await env.DB.prepare('SELECT * FROM oauth_reauth_tickets WHERE ticket_hash=? AND provider=? AND expires_at>? AND used_at IS NULL').bind(hash,provider,now).first();
 if(!row)return oauthErrorRedirect(request,'OAUTH_REAUTH_INVALID',cookies,mobileRedirect);
 const linked=await env.DB.prepare('SELECT user_id FROM oauth_accounts WHERE provider=? AND provider_subject=?').bind(provider,subject).first();
 if(!linked||linked.user_id!==row.user_id)return oauthErrorRedirect(request,'OAUTH_REAUTH_MISMATCH',cookies,mobileRedirect);
 const consumed=await env.DB.prepare('UPDATE oauth_reauth_tickets SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').bind(now,row.id,now).run();if(consumed.meta.changes!==1)return oauthErrorRedirect(request,'OAUTH_REAUTH_INVALID',cookies,mobileRedirect);
 const owner=await env.DB.prepare('SELECT account_status FROM users WHERE id=? AND deleted_at IS NULL').bind(row.user_id).first();if(!owner)return oauthErrorRedirect(request,'AUTH_REQUIRED',cookies,mobileRedirect);
 if(provider==='apple'){
  if(!refreshToken)return oauthErrorRedirect(request,'APPLE_REAUTH_REQUIRED',cookies,mobileRedirect);
  await storeAppleRefreshToken(env,config,subject,refreshToken);
 }
 const destination=new URL(mobileRedirect);
 if(owner.account_status==='ACTIVE'){
  // A live original session remains required, not just possession of a detached provider ticket.
  const valid=await env.DB.prepare('SELECT id FROM auth_sessions WHERE user_id=? AND token_hash=? AND expires_at>?').bind(row.user_id,row.session_hash,now).first();
  if(!valid)return oauthErrorRedirect(request,'AUTH_REQUIRED',cookies,mobileRedirect);
  destination.hash=`proof=${await createDeleteProof(env,row.user_id,row.session_hash)}`;
 }else{
  const valid=await env.DB.prepare("SELECT id FROM account_lifecycle_credentials WHERE user_id=? AND token_hash=? AND purpose='RECOVERY' AND expires_at>? AND used_at IS NULL").bind(row.user_id,row.session_hash,now).first();
  if(!valid)return oauthErrorRedirect(request,'AUTH_REQUIRED',cookies,mobileRedirect);
  await env.DB.prepare("UPDATE account_lifecycle_credentials SET ownership_verified_at=? WHERE id=? AND purpose='RECOVERY' AND used_at IS NULL AND expires_at>?").bind(now,valid.id,now).run();
  destination.searchParams.set('reauth','ok');
  // Missing-token retry resumes the same PURGING state; it never reactivates or extends the deadline.
  await env.DB.prepare("UPDATE users SET purge_retry_at=NULL WHERE id=? AND account_status='PURGING'").bind(row.user_id).run();
 }
 return new Response(null,{status:303,headers:{Location:destination.toString(),'Cache-Control':'no-store','Set-Cookie':cookies.join(', ')}});
}

// ---- Account deletion (issue #6; App Review Guideline 5.1.1(v)).
// The session identifies the account; nothing in the body can name another user. A user whose password was chosen
// at registration confirms it; a user created by Google / Apple sign-in never knew their generated password and is
// authenticated by the session alone. Linked Sign in with Apple authorizations are revoked at Apple first; if that is
// not possible nothing is deleted. Then every account-linked row is removed in one atomic D1 batch.
async function deletionInfo(request, env) {
  const user = await currentUser(request, env); if (!user) return error('AUTH_REQUIRED', 401);
  const context = await deletionContext(env, user.id);
  if (!context) return error('AUTH_REQUIRED', 401);
  const appleConfig = oauthConfig(env, 'apple');
  const appleTokens = await Promise.all(context.apple.map(row => openProviderToken(appleConfig, 'apple', row.provider_subject, row.refresh_token_ciphertext)));
  return json({
    requiresPassword: false,
    verification: 'EMAIL_LINK_OR_LINKED_PROVIDER',
    defaultMethod: 'DELETE_AFTER_30_DAYS',
    contractVersion: 2,
    providers: context.providers,
    appleReauthRequired: context.apple.length>0&&(!appleConfig.ready||appleTokens.some(token => !token)),
  });
}

async function deleteAccount(request,env){return error('ACCOUNT_LIFECYCLE_UNAVAILABLE',503);}

export async function purgeAccountData(env,userId,{preflight=false,lease}={}){
 const context=await deletionContext(env,userId);if(!context)throw coded('AUTH_REQUIRED');
 // One bounded current snapshot feeds existing schema validators; never cache readiness across requests/effects.
 const schemaNames=[...ACCOUNT_TABLES,...PERSONAL_RESTORE_TABLES,'sync_mutation_receipts','ai_import_consents','ai_import_consent_events','account_lifecycle_work','account_lifecycle_credentials','personal_restore_record_target','personal_restore_journal_target'];
 const schemaRows=(await env.DB.prepare(`SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') AND name IN (${schemaNames.map(()=>'?').join(',')})`).bind(...schemaNames).all()).results||[];
 const cleanupMode=await storageCleanupMode(env.DB,userId,schemaRows),consentTables=await aiConsentDeletionTables(env,schemaRows);
 const lifecycle=schemaRows.some(row=>row.type==='table'&&row.name==='account_lifecycle_credentials')?['account_lifecycle_work','account_lifecycle_credentials']:[];
 const tables=[...consentTables,...(cleanupMode==='legacy'?LEGACY_ACCOUNT_TABLES:cleanupMode==='personal'?[...PERSONAL_RESTORE_TABLES,'sync_mutation_receipts',...ACCOUNT_TABLES]:cleanupMode==='receipts'?['sync_mutation_receipts',...ACCOUNT_TABLES]:ACCOUNT_TABLES),...lifecycle];
 // Check every cleanup table/owner column before external side effects, including legacy tables.
 for(const table of tables){const row=schemaRows.find(row=>row.type==='table'&&row.name===table);if(!row?.sql||!/(?:\(|,)\s*["`\[]?user_id["`\]]?\s+(?:TEXT|INTEGER|BLOB|REAL|NUMERIC)\b/i.test(row.sql))throw Object.assign(coded('ACCOUNT_CLEANUP_SCHEMA_UNSUPPORTED'),{status:503});}
 if(preflight)return;
 const work=(await env.DB.prepare("SELECT id,state,response_id FROM account_lifecycle_work WHERE user_id=? AND state<>'RESOLVED'").bind(userId).all()).results||[];
 if(work.some(row=>row.state==='RUNNING'||row.state==='UNKNOWN'))throw Object.assign(coded('ACCOUNT_PURGE_UPSTREAM_UNRESOLVED'),{status:503});
 for(const row of work){
  if(!row.response_id||!env.OPENAI_API_KEY)throw coded('OPENAI_CLEANUP_UNAVAILABLE');
  let response;try{response=await fetch(`${OPENAI_RESPONSES_URL}/${encodeURIComponent(row.response_id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},signal:AbortSignal.timeout(PROVIDER_TIMEOUT_MS)});}catch{throw coded('OPENAI_CLEANUP_FAILED');}
  if(!response.ok&&response.status!==404)throw coded('OPENAI_CLEANUP_FAILED');
  await env.DB.prepare("UPDATE account_lifecycle_work SET state='RESOLVED',last_error=NULL WHERE id=? AND user_id=? AND state='RETURNED'").bind(row.id,userId).run();
 }
 const config=oauthConfig(env,'apple');
 for(const row of context.apple){
  if(!config.ready)throw Object.assign(coded('APPLE_REVOKE_UNAVAILABLE'),{status:503});
  const token=await openProviderToken(config,'apple',row.provider_subject,row.refresh_token_ciphertext);
  if(!token)throw Object.assign(coded('APPLE_REAUTH_REQUIRED'),{status:409});
  const result=await revokeAppleToken(config,token);
  if(result!=='revoked')throw Object.assign(coded(result==='invalid_grant'?'APPLE_REAUTH_REQUIRED':'APPLE_REVOKE_FAILED'),{status:502});
 }
 await deleteStoredImportResponses(env,userId);
 const gate="EXISTS(SELECT 1 FROM users WHERE id=? AND account_status='PURGING' AND purge_lease=? AND purge_lease_until>? AND NOT EXISTS(SELECT 1 FROM account_lifecycle_work WHERE user_id=users.id AND state<>'RESOLVED'))",stamp=new Date().toISOString();
 const result=await env.DB.batch(tables.map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE user_id=? AND ${gate}`).bind(userId,userId,lease,stamp)).concat(env.DB.prepare(`DELETE FROM users WHERE id=? AND account_status='PURGING' AND purge_lease=? AND purge_lease_until>? AND NOT EXISTS(SELECT 1 FROM account_lifecycle_work WHERE user_id=users.id AND state<>'RESOLVED')`).bind(userId,lease,stamp)));
 if(result.at(-1).meta.changes!==1)throw Object.assign(coded('ACCOUNT_PURGE_LEASE_LOST'),{status:409});
}

// Every table with a user_id column (migrations 0001–0008). `users` is deleted last, in the same batch.
const LEGACY_ACCOUNT_TABLES = ['import_jobs', 'mobile_oauth_codes', 'oauth_reauth_tickets', 'oauth_accounts', 'auth_sessions', 'user_data', 'programs', 'workout_sessions', 'workout_sets', 'user_settings', 'sync_metadata', 'password_reset_tokens'];
const ACCOUNT_TABLES = ['sync_records','sync_account_state',...LEGACY_ACCOUNT_TABLES];

export async function deletionContext(env, userId) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!user) return null;
  const linked = (await env.DB.prepare('SELECT provider, provider_subject, created_at, refresh_token_ciphertext FROM oauth_accounts WHERE user_id = ? ORDER BY created_at').bind(userId).all()).results || [];
  // Credential provenance is explicit; legacy identity timestamps never classify a credential.
  const generatedPassword = ['APPLE','GOOGLE'].includes(user.credential_origin);
  return {
    requiresPassword: !generatedPassword,
    passwordHash: user.password_hash,
    passwordSalt: user.password_salt,
    providers: Array.from(new Set(linked.map(row => row.provider))),
    apple: linked.filter(row => row.provider === 'apple'),
  };
}

// Apple's revoke endpoint returns 200 when the token was revoked or was already invalid.
async function revokeAppleToken(config, refreshToken) {
  try {
    const form = new URLSearchParams({ client_id: config.clientId, client_secret: await appleClientSecret(config), token: refreshToken, token_type_hint: 'refresh_token' });
    const response = await fetch(APPLE_REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (response.ok) return 'revoked';
    const payload = await response.json().catch(() => ({}));
    return payload.error === 'invalid_grant' ? 'invalid_grant' : `APPLE_${payload.error || response.status}`;
  } catch {
    return 'APPLE_UNREACHABLE';
  }
}

async function deleteStoredImportResponses(env,userId){
 const rows=(await env.DB.prepare('SELECT DISTINCT openai_response_id FROM import_jobs WHERE user_id=? AND openai_response_id IS NOT NULL').bind(userId).all()).results||[];
 if(rows.length&&!env.OPENAI_API_KEY)throw coded('OPENAI_CLEANUP_UNAVAILABLE');
 for(const row of rows){
  let response;try{response=await fetch(`${OPENAI_RESPONSES_URL}/${encodeURIComponent(row.openai_response_id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},signal:AbortSignal.timeout(PROVIDER_TIMEOUT_MS)});}catch{throw coded('OPENAI_CLEANUP_FAILED');}
  if(!response.ok&&response.status!==404)throw coded('OPENAI_CLEANUP_FAILED');
 }
}

// ---- Provider refresh tokens at rest: AES-GCM with a key derived (HKDF-SHA-256) from the Sign in with Apple private
// key, bound to provider + subject. No new secret; rotating the Apple key makes old tokens unreadable, which is
// handled like a missing token (the user re-authorizes with Apple before deletion).
async function storeAppleRefreshToken(env, config, subject, refreshToken) {
  if (!refreshToken) return;
  try {
    const sealed = await sealProviderToken(config, 'apple', subject, String(refreshToken));
    await env.DB.prepare('UPDATE oauth_accounts SET refresh_token_ciphertext = ?, refresh_token_updated_at = ? WHERE provider = ? AND provider_subject = ?').bind(sealed, new Date().toISOString(), 'apple', subject).run();
  } catch (cause) {
    // Sign-in must not fail because the token could not be kept; deletion will ask for Apple re-authorization.
    console.warn(JSON.stringify({ event: 'apple_refresh_token_store_failed', message: String(cause?.message || cause) }));
  }
}

async function providerTokenKey(config) {
  // The decoded key bytes, not the PEM text: re-pasting the same key with other line breaks keeps tokens readable.
  const material = await crypto.subtle.importKey('raw', pemToArrayBuffer(config.privateKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('reptrio-oauth-token-v1'), info: encoder.encode('apple-refresh-token') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealProviderToken(config, provider, subject, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${provider}:${subject}`) }, await providerTokenKey(config), encoder.encode(token));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function openProviderToken(config, provider, subject, sealed) {
  const [version, iv, data] = String(sealed || '').split('.');
  if (version !== 'v1' || !iv || !data || !config.privateKey) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(`${provider}:${subject}`) }, await providerTokenKey(config), fromBase64Url(data));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// Auth-only capability probe: an absent column is rechecked after rollout. Database errors propagate.
async function hasOnboardingEligibility(env) {
  const { results } = await env.DB.prepare('PRAGMA table_info(users)').all();
  return results.some(column => column.name === 'onboarding_eligible');
}

async function newUserInsert(env, id, email, passwordHash, salt, now,origin='PASSWORD') {
  const cols=(await env.DB.prepare('PRAGMA table_info(users)').all()).results;
  if(cols.some(c=>c.name==='credential_origin'))return env.DB.prepare(`INSERT INTO users(id,email,password_hash,password_salt,created_at,credential_origin,onboarding_eligible,email_verified_at)VALUES(?,?,?,?,?,?,1,?)`).bind(id,email,passwordHash,salt,now,origin,origin==='PASSWORD'?null:now);
  const eligible = await hasOnboardingEligibility(env);
  return env.DB.prepare(eligible
    ? 'INSERT INTO users (id, email, password_hash, password_salt, created_at, onboarding_eligible) VALUES (?, ?, ?, ?, ?, 1)'
    : 'INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, email, passwordHash, salt, now);
}

async function publicUser(env, id, email) {
  let onboardingEligible = false;
  if (await hasOnboardingEligibility(env)) {
    const row = await env.DB.prepare('SELECT onboarding_eligible FROM users WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    onboardingEligible = row?.onboarding_eligible === 1;
  }
  return { id, email, onboardingEligible };
}

export async function issueSession(env, id, email, status = 201, extraHeaders = {}) {
  const token = randomToken(32); const now = new Date(); const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  const db=await activeAccountDB(env.DB);
  const created=await db.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) SELECT ?,id,?,?,? FROM users WHERE id=? AND deleted_at IS NULL').bind(crypto.randomUUID(),await tokenDigest(token),now.toISOString(),expires.toISOString(),id).run();
  if(created.meta.changes!==1)return error('AUTH_REQUIRED',401);
  const mobile = extraHeaders['X-Reptrio-Client'] === 'mobile';
  const publicHeaders = { ...extraHeaders };
  delete publicHeaders['X-Reptrio-Client'];
  return json({ user: await publicUser(env, id, email), ...(mobile ? { sessionToken: token, expiresAt: expires.toISOString() } : {}) }, status, { ...publicHeaders, 'Set-Cookie': [sessionCookie(token, expires), ...asArray(publicHeaders['Set-Cookie'])] });
}

async function issueMobileOAuthCode(env, userId, redirectUri, cookies = []) {
  const code = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + MOBILE_OAUTH_CODE_MINUTES * 60000);
  await env.DB.prepare('INSERT INTO mobile_oauth_codes (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), userId, await tokenDigest(code), now.toISOString(), expires.toISOString()).run();
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  const headers = new Headers({ Location: url.toString(), 'Cache-Control': 'no-store' });
  cookies.forEach(value => headers.append('Set-Cookie', value));
  return new Response(null, { status: 303, headers });
}

export async function currentUser(request, env) {
  const token = sessionToken(request); if (!token) return null;
  const db=await activeAccountDB(env.DB);
  const row = await db.prepare('SELECT users.id, users.email FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ? AND users.deleted_at IS NULL').bind(await tokenDigest(token), new Date().toISOString()).first();
  return row || null;
}

export function isJsonPost(request) { return request.method === 'POST' && request.headers.get('content-type')?.toLowerCase().startsWith('application/json'); }
export function sameOrigin(request) { const origin = request.headers.get('origin'); return !origin || origin === new URL(request.url).origin; }
function mobileClient(request) { return request.headers.get('x-reptrio-client') === 'mobile'; }
export function methodOrTypeError(request) { return request.method !== 'POST' ? error('METHOD_NOT_ALLOWED', 405, { Allow: 'POST' }) : error('UNSUPPORTED_CONTENT_TYPE', 415); }
export async function body(request) { try { return await request.json(); } catch { return {}; } }
export function normalizeEmail(value) { const email = String(value || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null; }
export function validPassword(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 200; }
export async function passwordDigest(password, salt) { const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations: PBKDF2_ITERATIONS }, key, 256); return base64Url(new Uint8Array(bits)); }
export async function tokenDigest(token) { const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token)); return base64Url(new Uint8Array(digest)); }
export function randomToken(length) { const bytes = crypto.getRandomValues(new Uint8Array(length)); return base64Url(bytes); }
function base64Url(bytes) { let text = ''; bytes.forEach(byte => { text += String.fromCharCode(byte); }); return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function fromBase64Url(value) { const text = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='); const binary = atob(text); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
function constantEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let result = 0; for (let index = 0; index < a.length; index += 1) result |= a.charCodeAt(index) ^ b.charCodeAt(index); return result === 0; }
function cookie(request, name) { return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || null; }
function bearer(request) { const value = request.headers.get('authorization') || ''; const match = value.match(/^Bearer\s+(.+)$/i); return match ? match[1].trim() : null; }
export function sessionToken(request) { return bearer(request) || cookie(request, 'aks_session'); }
function sessionCookie(token, expires) { return `aks_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=${expires.toUTCString()}`; }
function clearCookie() { return 'aks_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'; }
function shortCookie(name, value) { return `${name}=${value}; Path=/api/auth/oauth/; HttpOnly; Secure; SameSite=None; Max-Age=600`; }
function clearNamedCookie(name) { return `${name}=; Path=/api/auth/oauth/; HttpOnly; Secure; SameSite=None; Max-Age=0`; }
export function json(value, status = 200, headers = {}) {
  const responseHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  Object.entries(headers).forEach(([key, value]) => {
    asArray(value).forEach(item => responseHeaders.append(key, item));
  });
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}
export function error(code, status, headers) { return json({ code }, status, headers); }
function oauthErrorRedirect(request, code, cookies = [], mobileRedirect = null) {
  const url = new URL(mobileRedirect || '/', request.url);
  url.searchParams.set('auth_error', code);
  const headers = new Headers({ Location: url.toString(), 'Cache-Control': 'no-store' });
  cookies.forEach(value => headers.append('Set-Cookie', value));
  return new Response(null, { status: 303, headers });
}
function oauthRedirectUri(request, provider) { return new URL(`/api/auth/oauth/${provider}/callback`, request.url).toString(); }
function mobileRedirectUri(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'reptrio:' ? url.toString() : null;
  } catch {
    return null;
  }
}
export function oauthConfig(env, provider) {
  if (provider === 'google') return {
    provider,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: 'https://accounts.google.com',
    scope: 'openid email profile',
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    ready: Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET)
  };
  return {
    provider,
    authorizationUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuer: 'https://appleid.apple.com',
    scope: 'openid email',
    clientId: env.APPLE_OAUTH_CLIENT_ID,
    teamId: env.APPLE_OAUTH_TEAM_ID,
    keyId: env.APPLE_OAUTH_KEY_ID,
    privateKey: env.APPLE_OAUTH_PRIVATE_KEY,
    ready: Boolean(env.APPLE_OAUTH_CLIENT_ID && env.APPLE_OAUTH_TEAM_ID && env.APPLE_OAUTH_KEY_ID && env.APPLE_OAUTH_PRIVATE_KEY)
  };
}
async function appleClientSecret(config) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
  const payload = { iss: config.teamId, iat: now, exp: now + 3600, aud: 'https://appleid.apple.com', sub: config.clientId };
  const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(config.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(input)));
  return `${input}.${base64Url(signature)}`;
}
function decodeJwt(token) {
  const [, payload] = String(token || '').split('.');
  if (!payload) throw coded('OAUTH_TOKEN_INVALID');
  try { return JSON.parse(new TextDecoder().decode(fromBase64Url(payload))); }
  catch { throw coded('OAUTH_TOKEN_INVALID'); }
}
async function decodeAndVerifyIdToken(token, config) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw coded('OAUTH_TOKEN_INVALID');
  const [headerPart, payloadPart, signaturePart] = parts;
  let header;
  try { header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerPart))); }
  catch { throw coded('OAUTH_TOKEN_INVALID'); }
  if (header.alg !== 'RS256' || !header.kid) throw coded('OAUTH_TOKEN_INVALID');
  const response = await fetch(config.jwksUrl, { headers: { Accept: 'application/json' } });
  const jwks = await response.json().catch(() => ({}));
  const jwk = Array.isArray(jwks.keys) && jwks.keys.find(key => key.kid === header.kid && key.kty === 'RSA');
  if (!response.ok || !jwk) throw coded('OAUTH_KEY_NOT_FOUND');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`));
  if (!valid) throw coded('OAUTH_SIGNATURE_INVALID');
  return decodeJwt(token);
}
function pemToArrayBuffer(pem) {
  const clean = String(pem).replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  return fromBase64Url(clean.replaceAll('+', '-').replaceAll('/', '_'));
}
function base64UrlJson(value) { return base64Url(encoder.encode(JSON.stringify(value))); }
function asArray(value) { return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []; }
function mapOAuthTokenError(code) { return code === 'invalid_client' ? 'OAUTH_CLIENT_INVALID' : code === 'invalid_grant' ? 'OAUTH_CODE_INVALID' : 'OAUTH_TOKEN_EXCHANGE_FAILED'; }
function coded(code) { return Object.assign(new Error(code), { code }); }

async function personalOperations(request,env,match){
 const purpose=match[1]==='backup/restore'?'RESTORE':'SYNC',id=match[2],action=id?match[3]:'start';
 if(!action||id&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)||purpose==='SYNC'&&['preview','undo-preview','undo'].includes(action))return error('RESTORE_ROUTE_INVALID',404);
 if(action==='receipt'){if(request.method!=='GET')return error('METHOD_NOT_ALLOWED',405,{Allow:'GET'});}
 else {if(!isJsonPost(request))return methodOrTypeError(request);if(!sameOrigin(request))return error('AUTH_ORIGIN_INVALID',403);}
 const user=await currentUser(request,env);if(!user)return error('AUTH_REQUIRED',401);
 return personalRestoreRequest(request,env,user.id,purpose,id,action);
}

// Submission-only dependency preflight. No revocation here: pending must retain usable material for the deadline.
// The encrypted subject/material snapshot is repeated inside the transition CAS, closing concurrent provider-link
// and key-material changes between this verification and the state change.
export async function applePurgePrerequisite(env,userId){
 const rows=(await env.DB.prepare("SELECT provider_subject,refresh_token_ciphertext FROM oauth_accounts WHERE user_id=? AND provider='apple' ORDER BY provider_subject").bind(userId).all()).results||[];
 const config=oauthConfig(env,'apple');if(rows.length&&!config.ready)throw Object.assign(coded('APPLE_REVOKE_UNAVAILABLE'),{status:503});
 for(const row of rows)if(!(await openProviderToken(config,'apple',row.provider_subject,row.refresh_token_ciphertext)))throw Object.assign(coded('APPLE_REAUTH_REQUIRED'),{status:409});
 return JSON.stringify(rows.map(row=>({provider_subject:row.provider_subject,refresh_token_ciphertext:row.refresh_token_ciphertext})));
}
