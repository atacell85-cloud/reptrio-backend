import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { openProviderToken } from '../worker/account-api.js';
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
const net = { nonce: null, subject: null, email: null, appleRefreshToken: null, revokeMode: 'ok', revokes: [], openaiDeletes: [], openaiRequests: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
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
  DB: db,
  ASSETS: { fetch: async () => new Response('ok') },
  GOOGLE_OAUTH_CLIENT_ID: 'google-client', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  APPLE_OAUTH_CLIENT_ID: 'com.reptrio.signin', APPLE_OAUTH_TEAM_ID: 'TEAM123456', APPLE_OAUTH_KEY_ID: 'KEY1234567', APPLE_OAUTH_PRIVATE_KEY: applePrivateKey,
  OPENAI_API_KEY: 'test-openai-key',
};
const call = (path, init = {}, overrideEnv = env) => worker.fetch(new Request(`${ORIGIN}${path}`, init), overrideEnv, { waitUntil() {} });
const authed = (token, init = {}) => ({ ...init, headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
const deleteRequest = (token, payload) => authed(token, { method: 'POST', body: JSON.stringify(payload) });
const USER_TABLES = ['import_jobs', 'mobile_oauth_codes', 'oauth_reauth_tickets', 'oauth_accounts', 'auth_sessions', 'user_data', 'programs', 'workout_sessions', 'workout_sets', 'user_settings', 'sync_metadata'];
const footprint = userId => Object.fromEntries([...USER_TABLES.map(table => [table, db.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId)[0].n]), ['users', db.rows('SELECT COUNT(*) AS n FROM users WHERE id = ?', userId)[0].n]]);
const empty = Object.fromEntries([...USER_TABLES, 'users'].map(table => [table, 0]));

async function register(email, password = 'password123') {
  const response = await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { id: body.user.id, token: body.sessionToken, email };
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
  return { id: body.user.id, token: body.sessionToken, email };
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
// an import job with an OpenAI response id, and an unused mobile OAuth code.
async function seed(user, tag) {
  const data = { programs: [{ id: `p-${tag}` }], sessions: [{ id: `s-${tag}`, sets: { e1: { 1: { weight: '50', reps: '5', completed: true } } } }], settings: { profile: { displayName: tag, avatarDataUrl: 'data:image/jpeg;base64,AAAA' } } };
  const push = await call('/api/sync/push', authed(user.token, { method: 'POST', body: JSON.stringify({ data, syncVersion: 0 }) }));
  assert.equal(push.status, 200);
  const now = new Date().toISOString();
  db.raw.prepare("INSERT INTO import_jobs (id, user_id, status, source_json, normalized_document_json, openai_response_id, created_at, updated_at) VALUES (?, ?, 'done', '{}', '{}', ?, ?, ?)").run(`job-${tag}`, user.id, `resp_${tag}`, now, now);
  db.raw.prepare('INSERT INTO mobile_oauth_codes (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(`code-${tag}`, user.id, `hash-${tag}`, now, now);
}

const info = async token => { const response = await call('/api/auth/delete', authed(token)); return { status: response.status, body: await response.json() }; };
const remove = async (token, payload = { confirm: 'DELETE' }) => { const response = await call('/api/auth/delete', deleteRequest(token, payload)); return { status: response.status, body: await response.json(), cookie: response.headers.get('Set-Cookie') }; };
const me = async token => (await call('/api/me', authed(token))).status;

// A bystander account that must survive every deletion below.
const bystander = await register('bystander@example.test');
await seed(bystander, 'bystander');
const bystanderFootprint = footprint(bystander.id);

// ---- 1. Email / password: the real password is still required.
{
  const user = await register('email@example.test', 'correct-horse-1');
  await seed(user, 'email');
  assert.deepEqual((await info(user.token)).body, { requiresPassword: true, providers: [], appleReauthRequired: false });
  assert.deepEqual(await remove(user.token, { confirm: 'DELETE', password: 'wrong-password' }).then(r => [r.status, r.body.code]), [401, 'AUTH_INVALID_CREDENTIALS']);
  assert.deepEqual(await remove(user.token, { confirm: 'DELETE' }).then(r => [r.status, r.body.code]), [401, 'AUTH_INVALID_CREDENTIALS'], 'no password → rejected');
  assert.notDeepEqual(footprint(user.id), empty, 'a rejected request deletes nothing');
  const done = await remove(user.token, { confirm: 'DELETE', password: 'correct-horse-1' });
  assert.equal(done.status, 200);
  assert.match(done.cookie, /aks_session=;.*Max-Age=0/);
  assert.deepEqual(footprint(user.id), empty, 'every linked row and the user row are gone');
  assert.equal(await me(user.token), 401, 'the session no longer authenticates');
  const login = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'email@example.test', password: 'correct-horse-1' }) });
  assert.equal(login.status, 401, 'cannot log in after deletion');
  assert.deepEqual(net.openaiDeletes, ['resp_email'], 'stored OpenAI import response deleted');
}

// ---- 2. Google: no password; the generated password is never asked for.
{
  const user = await oauthLogin('google', 'google-sub-1', 'google@example.test');
  await seed(user, 'google');
  assert.deepEqual((await info(user.token)).body, { requiresPassword: false, providers: ['google'], appleReauthRequired: false });
  const done = await remove(user.token);
  assert.equal(done.status, 200);
  assert.deepEqual(footprint(user.id), empty);
  assert.equal(net.revokes.length, 0, 'no Apple call for a Google account');
  // Signing in with Google again creates a fresh, empty account (nothing was retained).
  const again = await oauthLogin('google', 'google-sub-1', 'google@example.test');
  assert.notEqual(again.id, user.id);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM user_data WHERE user_id = ?', again.id)[0].n, 0);
  assert.equal((await remove(again.token)).status, 200);
}

// ---- 3. Apple: refresh token stored encrypted at sign-in, revoked at Apple on deletion.
{
  const user = await oauthLogin('apple', 'apple-sub-1', 'relay@privaterelay.appleid.com', 'apple-refresh-1');
  await seed(user, 'apple');
  const [row] = db.rows("SELECT refresh_token_ciphertext AS sealed FROM oauth_accounts WHERE provider = 'apple' AND provider_subject = 'apple-sub-1'");
  assert.ok(row.sealed.startsWith('v1.') && !row.sealed.includes('apple-refresh-1'), 'token stored encrypted, never in plain text');
  const appleConfig = { privateKey: applePrivateKey };
  assert.equal(await openProviderToken(appleConfig, 'apple', 'apple-sub-1', row.sealed), 'apple-refresh-1');
  assert.equal(await openProviderToken(appleConfig, 'apple', 'other-sub', row.sealed), null, 'ciphertext bound to its subject');
  assert.equal(await openProviderToken({ privateKey: 'another key' }, 'apple', 'apple-sub-1', row.sealed), null, 'another key cannot open it');
  assert.deepEqual((await info(user.token)).body, { requiresPassword: false, providers: ['apple'], appleReauthRequired: false });
  net.revokes = [];
  const done = await remove(user.token);
  assert.equal(done.status, 200);
  assert.equal(net.revokes.length, 1);
  const revoke = net.revokes[0];
  assert.deepEqual([revoke.client_id, revoke.token, revoke.token_type_hint], ['com.reptrio.signin', 'apple-refresh-1', 'refresh_token']);
  const [header, payload] = revoke.client_secret.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url').toString()));
  assert.deepEqual([header.alg, header.kid, payload.iss, payload.sub, payload.aud], ['ES256', 'KEY1234567', 'TEAM123456', 'com.reptrio.signin', 'https://appleid.apple.com']);
  assert.deepEqual(footprint(user.id), empty);
}

// ---- 4. Unauthenticated / unconfirmed / wrong method.
{
  assert.equal((await call('/api/auth/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })).status, 401);
  assert.equal((await call('/api/auth/delete', { headers: {} })).status, 401, 'info requires a session');
  const user = await register('confirm@example.test');
  assert.deepEqual(await remove(user.token, { password: 'password123' }).then(r => [r.status, r.body.code]), [400, 'ACCOUNT_DELETE_CONFIRMATION_REQUIRED']);
  assert.equal((await call('/api/auth/delete', authed(user.token, { method: 'PUT', body: '{}' }))).status, 405);
  assert.equal((await call('/api/auth/delete', { ...deleteRequest(user.token, { confirm: 'DELETE', password: 'password123' }), headers: { ...deleteRequest(user.token, {}).headers, Origin: 'https://evil.example' } })).status, 403, 'cross-origin rejected');
  assert.equal((await remove(user.token, { confirm: 'DELETE', password: 'password123' })).status, 200);
}

// ---- 5. Another user's id in the body is ignored: only the session's own account is deleted.
{
  const attacker = await oauthLogin('google', 'google-sub-attacker', 'attacker@example.test');
  const done = await remove(attacker.token, { confirm: 'DELETE', userId: bystander.id, user_id: bystander.id, id: bystander.id });
  assert.equal(done.status, 200);
  assert.deepEqual(footprint(attacker.id), empty);
  assert.deepEqual(footprint(bystander.id), bystanderFootprint, 'the bystander is untouched');
  assert.equal(await me(bystander.token), 200);
}

// ---- 6. A password account that already has a Google link (legacy data, linked by email before issue #12) keeps its
// password requirement. Since #12 such a link is no longer created at sign-in, so the row is seeded directly.
{
  const user = await register('linked@example.test', 'linked-pass-1');
  const later = new Date(Date.now() + 1000).toISOString();
  db.raw.prepare("INSERT INTO oauth_accounts (provider, provider_subject, user_id, email, created_at, last_login_at) VALUES ('google', 'google-sub-linked', ?, 'linked@example.test', ?, ?)").run(user.id, later, later);
  const linked = await oauthLogin('google', 'google-sub-linked', 'linked@example.test');
  assert.equal(linked.id, user.id, 'the existing provider + sub link signs in');
  assert.deepEqual((await info(linked.token)).body, { requiresPassword: true, providers: ['google'], appleReauthRequired: false });
  assert.equal((await remove(linked.token)).status, 401);
  assert.equal((await remove(linked.token, { confirm: 'DELETE', password: 'linked-pass-1' })).status, 200);
  assert.deepEqual(footprint(user.id), empty);
}

// ---- 7/8. Apple revoke failures: nothing is deleted; invalid_grant / missing token → Apple re-authorization.
{
  const user = await oauthLogin('apple', 'apple-sub-2', 'apple2@example.test', 'apple-refresh-2');
  await seed(user, 'apple2');
  const before = footprint(user.id);
  for (const [mode, status, code] of [['server', 502, 'APPLE_REVOKE_FAILED'], ['invalid_client', 502, 'APPLE_REVOKE_FAILED'], ['network', 502, 'APPLE_REVOKE_FAILED'], ['invalid_grant', 409, 'APPLE_REAUTH_REQUIRED']]) {
    net.revokeMode = mode;
    assert.deepEqual(await remove(user.token).then(r => [r.status, r.body.code]), [status, code], mode);
    assert.deepEqual(footprint(user.id), before, `${mode}: nothing deleted`);
    assert.equal(await me(user.token), 200, `${mode}: still signed in`);
  }
  net.revokeMode = 'ok';
  // Apple not configured on the server: cannot revoke → refuse.
  const unconfigured = { ...env, APPLE_OAUTH_PRIVATE_KEY: '' };
  assert.deepEqual(await call('/api/auth/delete', deleteRequest(user.token, { confirm: 'DELETE' }), unconfigured).then(async r => [r.status, (await r.json()).code]), [503, 'APPLE_REVOKE_UNAVAILABLE']);
  assert.deepEqual(footprint(user.id), before);
  // Legacy Apple user (signed in before tokens were stored): re-authorize with Apple, bound to this account, then delete.
  db.raw.prepare("UPDATE oauth_accounts SET refresh_token_ciphertext = NULL WHERE provider_subject = 'apple-sub-2'").run();
  assert.equal((await info(user.token)).body.appleReauthRequired, true);
  assert.deepEqual(await remove(user.token).then(r => [r.status, r.body.code]), [409, 'APPLE_REAUTH_REQUIRED']);
  assert.deepEqual(footprint(user.id).users, 1);
  const usersBefore = db.rows('SELECT COUNT(*) AS n FROM users')[0].n;
  // A different Apple ID cannot satisfy the re-authorization: no account created, linked or switched, no session.
  const other = await appleReauth(user.token, 'apple-sub-OTHER', 'other@privaterelay.appleid.com', 'apple-refresh-other');
  assert.equal(other.location.searchParams.get('auth_error'), 'APPLE_REAUTH_MISMATCH');
  assert.equal(other.location.searchParams.get('code'), null, 'no session code issued');
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM users')[0].n, usersBefore, 'no account created');
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM oauth_accounts WHERE provider_subject = 'apple-sub-OTHER'")[0].n, 0, 'nothing linked');
  assert.equal((await info(user.token)).body.appleReauthRequired, true, 'still no token for this account');
  // An Apple ID linked to ANOTHER account is rejected too, and that account's stored token is left untouched.
  const victim = await oauthLogin('apple', 'apple-sub-VICTIM', 'victim@privaterelay.appleid.com', 'apple-refresh-victim');
  const victimSealed = db.rows("SELECT refresh_token_ciphertext AS s FROM oauth_accounts WHERE provider_subject = 'apple-sub-VICTIM'")[0].s;
  const cross = await appleReauth(user.token, 'apple-sub-VICTIM', 'victim@privaterelay.appleid.com', 'apple-refresh-attacker');
  assert.equal(cross.location.searchParams.get('auth_error'), 'APPLE_REAUTH_MISMATCH');
  assert.equal(db.rows("SELECT refresh_token_ciphertext AS s FROM oauth_accounts WHERE provider_subject = 'apple-sub-VICTIM'")[0].s, victimSealed, "the other account's token is unchanged");
  assert.equal((await info(user.token)).body.appleReauthRequired, true);
  assert.equal((await remove(victim.token)).status, 200);
  // Defense in depth: ticket needs same origin; an expired ticket and a malformed one are rejected; a matching Apple ID
  // without a refresh token is rejected (not a silent loop).
  assert.equal((await call('/api/auth/reauth/apple', { ...authed(user.token, { method: 'POST', body: '{}' }), headers: { ...authed(user.token).headers, Origin: 'https://evil.example' } })).status, 403);
  const expired = await (await call('/api/auth/reauth/apple', authed(user.token, { method: 'POST', body: '{}' }))).json();
  db.raw.prepare("UPDATE oauth_reauth_tickets SET expires_at = '2000-01-01T00:00:00.000Z' WHERE rowid = (SELECT MAX(rowid) FROM oauth_reauth_tickets)").run(); // only this ticket
  assert.equal((await appleReauth(user.token, 'apple-sub-2', 'apple2@example.test', 'x', expired.ticket)).location.searchParams.get('auth_error'), 'APPLE_REAUTH_INVALID', 'expired ticket rejected');
  const malformedStart = await call(`/api/auth/oauth/apple/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}&reauth=${encodeURIComponent('bad ticket;')}`);
  assert.ok(malformedStart.headers.getSetCookie().some(value => value.startsWith('aks_oauth_reauth=;') && value.includes('Max-Age=0')), 'malformed ticket not stored (cookie cleared)');
  assert.equal((await appleReauth(user.token, 'apple-sub-2', 'apple2@example.test', null)).location.searchParams.get('auth_error'), 'APPLE_REAUTH_INVALID', 'no refresh token → error, not a silent loop');
  assert.equal((await info(user.token)).body.appleReauthRequired, true);
  // The ticket is single use and must be valid.
  assert.equal((await appleReauth(user.token, 'apple-sub-2', 'apple2@example.test', 'x', other.ticket)).location.searchParams.get('auth_error'), 'APPLE_REAUTH_INVALID', 'used ticket rejected');
  assert.equal((await appleReauth(user.token, 'apple-sub-2', 'apple2@example.test', 'x', 'forged-ticket-value-000000000000')).location.searchParams.get('auth_error'), 'APPLE_REAUTH_INVALID', 'unknown ticket rejected');
  assert.equal((await call('/api/auth/reauth/apple', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'ticket needs a session');
  // The linked Apple ID: token stored for this account; no new session; the old session stays valid.
  const sessionsBefore = db.rows('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', user.id)[0].n;
  const same = await appleReauth(user.token, 'apple-sub-2', 'apple2@example.test', 'apple-refresh-2b');
  assert.equal(same.location.searchParams.get('reauth'), 'ok');
  assert.equal(same.location.searchParams.get('code'), null, 'no session code issued');
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', user.id)[0].n, sessionsBefore, 'no new session');
  assert.equal((await info(user.token)).body.appleReauthRequired, false);
  net.revokes = [];
  assert.equal((await remove(user.token)).status, 200);
  assert.equal(net.revokes[0].token, 'apple-refresh-2b');
  assert.deepEqual(footprint(user.id), empty);
  // A cancelled re-authorization (start, no callback) must not affect a later normal Apple login in the same browser:
  // the next start clears the re-authorization cookie.
  {
    const login = await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ email: 'jar@example.test', password: 'password123' }) });
    const jarUser = await login.json();
    const ticket = (await (await call('/api/auth/reauth/apple', authed(jarUser.sessionToken, { method: 'POST', body: '{}' }))).json()).ticket;
    const jar = new Map();
    const remember = response => response.headers.getSetCookie().forEach(value => { const [pair] = value.split(';'); const [name, ...rest] = pair.split('='); if (/Max-Age=0/.test(value)) jar.delete(name); else jar.set(name, rest.join('=')); });
    const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    remember(await call(`/api/auth/oauth/apple/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}&reauth=${ticket}`));
    assert.ok(jar.has('aks_oauth_reauth'), 'premise: re-authorization cookie set, then the sheet is cancelled');
    const start = await call(`/api/auth/oauth/apple/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}`, { headers: { Cookie: cookieHeader() } });
    remember(start);
    assert.ok(!jar.has('aks_oauth_reauth'), 'normal start clears it');
    net.nonce = jar.get('aks_oauth_nonce'); net.subject = 'apple-sub-jar'; net.email = 'jar-apple@example.test'; net.appleRefreshToken = 'apple-refresh-jar';
    const callback = await call('/api/auth/oauth/apple/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() }, body: new URLSearchParams({ code: 'provider-code', state: jar.get('aks_oauth_state') }) });
    const location = new URL(callback.headers.get('Location'));
    assert.ok(location.searchParams.get('code') && !location.searchParams.get('auth_error'), `normal Apple login completes: ${location}`);
  }
  // A second delete with the old session is rejected (the account and its sessions are gone).
  assert.equal((await remove(user.token)).status, 401);
}

// ---- 8b. A new OAuth user and its first link are written atomically: a failing link leaves no orphan user.
{
  db.setFailOn(/^INSERT INTO oauth_accounts/);
  const start = await call(`/api/auth/oauth/google/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}`);
  const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]);
  net.nonce = cookies.find(value => value.startsWith('aks_oauth_nonce=')).split('=')[1]; net.subject = 'google-sub-orphan'; net.email = 'orphan@example.test';
  const state = cookies.find(value => value.startsWith('aks_oauth_state=')).split('=')[1];
  const callback = await call(`/api/auth/oauth/google/callback?code=c&state=${state}`, { headers: { Cookie: cookies.join('; ') } });
  db.setFailOn(null);
  assert.ok(new URL(callback.headers.get('Location')).searchParams.get('auth_error'), 'sign-in fails');
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM users WHERE email = 'orphan@example.test'")[0].n, 0, 'no orphan user without its link');
}

// ---- 9. Database failure mid-batch: the batch is atomic, nothing is half-deleted, the user can retry.
{
  const user = await oauthLogin('google', 'google-sub-partial', 'partial@example.test');
  await seed(user, 'partial');
  const before = footprint(user.id);
  db.setFailOn(/^DELETE FROM users WHERE id/);
  assert.deepEqual(await remove(user.token).then(r => [r.status, r.body.code]), [500, 'ACCOUNT_DELETE_FAILED']);
  assert.deepEqual(footprint(user.id), before, 'rolled back: every row still present');
  assert.equal(await me(user.token), 200);
  db.setFailOn(null);
  assert.equal((await remove(user.token)).status, 200, 'retry succeeds');
  assert.deepEqual(footprint(user.id), empty);
}

// ---- 10. The maintenance script (not a migration) purges accounts that were only soft-deleted by the old flow; active accounts stay.
{
  const legacy = createD1();
  const now = '2026-09-01T00:00:00.000Z';
  for (const [id, deleted] of [['gone', now], ['kept', null]]) {
    legacy.raw.prepare('INSERT INTO users (id, email, password_hash, password_salt, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, `${id}@example.test`, 'h', 's', now, deleted);
    legacy.raw.prepare("INSERT INTO oauth_accounts (provider, provider_subject, user_id, email, created_at, last_login_at) VALUES ('google', ?, ?, ?, ?, ?)").run(`sub-${id}`, id, `${id}@example.test`, now, now);
    legacy.raw.prepare("INSERT INTO import_jobs (id, user_id, status, source_json, normalized_document_json, created_at, updated_at) VALUES (?, ?, 'done', '{}', '{}', ?, ?)").run(`job-${id}`, id, now, now);
    legacy.raw.prepare('INSERT INTO user_data (user_id, payload_json, updated_at) VALUES (?, ?, ?)').run(id, '{}', now);
  }
  const fs = await import('node:fs');
  assert.ok(!fs.readdirSync(new URL('../migrations/', import.meta.url)).some(file => /purge/i.test(file)), 'the irreversible purge is not an automatic migration');
  legacy.exec(fs.readFileSync(new URL('./maintenance/purge-soft-deleted-accounts.sql', import.meta.url), 'utf8'));
  const count = (table, column, id) => legacy.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, id)[0].n;
  assert.deepEqual(['users:id', 'oauth_accounts:user_id', 'import_jobs:user_id', 'user_data:user_id'].map(spec => { const [table, column] = spec.split(':'); return [count(table, column, 'gone'), count(table, column, 'kept')]; }), [[0, 1], [0, 1], [0, 1], [0, 1]]);
}

// ---- 11. Web Apple sign-in (cookie session, no mobile client) also stores the token; IVs are random; a re-pasted
// PEM with other line breaks still opens stored tokens; synchronous OpenAI import requests are not stored.
{
  const start = await call('/api/auth/oauth/apple/start');
  const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]);
  const state = cookies.find(value => value.startsWith('aks_oauth_state=')).split('=')[1];
  net.nonce = cookies.find(value => value.startsWith('aks_oauth_nonce=')).split('=')[1];
  net.subject = 'apple-sub-web'; net.email = 'web@example.test'; net.appleRefreshToken = 'apple-refresh-web';
  const callback = await call('/api/auth/oauth/apple/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.join('; ') }, body: new URLSearchParams({ code: 'provider-code', state }) });
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('Location')).pathname, '/');
  const [row] = db.rows("SELECT refresh_token_ciphertext AS sealed FROM oauth_accounts WHERE provider_subject = 'apple-sub-web'");
  assert.equal(await openProviderToken({ privateKey: applePrivateKey }, 'apple', 'apple-sub-web', row.sealed), 'apple-refresh-web', 'web sign-in stores the token');
  const repasted = applePrivateKey.replace(/\n/g, '\r\n').replace('-----END', '\n-----END');
  assert.equal(await openProviderToken({ privateKey: repasted }, 'apple', 'apple-sub-web', row.sealed), 'apple-refresh-web', 're-pasted PEM opens the token');
  const { sealProviderToken } = await import('../worker/account-api.js');
  const [a, b] = [await sealProviderToken({ privateKey: applePrivateKey }, 'apple', 's', 't'), await sealProviderToken({ privateKey: applePrivateKey }, 'apple', 's', 't')];
  assert.notEqual(a.split('.')[1], b.split('.')[1], 'random IV per seal');
  const parse = await call('/api/import/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: 'imp-1', normalizedDocument: { blocks: [{ type: 'paragraph', text: 'Squat 3x5' }] } }) });
  assert.notEqual(parse.status, 200);
  assert.ok(net.openaiRequests.length >= 1 && net.openaiRequests.every(request => request.store === false && request.background === false), 'synchronous import requests are not stored at OpenAI');
}

assert.deepEqual(footprint(bystander.id), bystanderFootprint, 'the bystander survived every deletion');
globalThis.fetch = realFetch;
if (foreignKeys) execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, D1_FOREIGN_KEYS: 'off' }, stdio: ['ignore', 'ignore', 'inherit'] });
console.log('Account deletion (foreign keys on and off): email/password (password kept), Google and Apple (no generated password), Apple refresh token encrypted at rest and revoked (form + ES256 client secret), revoke failures and legacy Apple re-authorization delete nothing, no cross-account deletion, every user table emptied atomically with rollback on failure, OpenAI import responses deleted, login impossible afterwards, legacy soft-delete purge migration.');
