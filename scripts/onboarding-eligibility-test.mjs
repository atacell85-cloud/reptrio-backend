import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { currentUser } from '../worker/account-api.js';
import { createD1 } from './lib/d1-sqlite.mjs';

// Routed auth contract on the real SQLite D1 adapter; provider tokens are signed locally.
const ORIGIN = 'https://a2.example';
const encoder = new TextEncoder();
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const jsonB64 = value => b64url(encoder.encode(JSON.stringify(value)));
const rsaParams = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const rsa = await crypto.subtle.generateKey(rsaParams, true, ['sign', 'verify']);
const attackerKey = await crypto.subtle.generateKey(rsaParams, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', rsa.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64');
const applePrivateKey = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
async function sign(claims, key = rsa.privateKey) {
  const input = `${jsonB64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })}.${jsonB64(claims)}`;
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input))))}`;
}

// Provider network mock. `net.override` adjusts the claims; `net.forge` signs with a key Google / Apple never published.
const net = { nonce: null, subject: null, email: null, verified: undefined, hd: undefined, override: null, forge: false };
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const ok = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (target === 'https://www.googleapis.com/oauth2/v3/certs' || target === 'https://appleid.apple.com/auth/keys') return ok({ keys: [jwk] });
  if (target === 'https://oauth2.googleapis.com/token' || target === 'https://appleid.apple.com/auth/token') {
    const apple = target.includes('apple');
    const now = Math.floor(Date.now() / 1000);
    let claims = { iss: apple ? 'https://appleid.apple.com' : 'https://accounts.google.com', aud: apple ? 'com.reptrio.signin' : 'google-client', exp: now + 600, iat: now, sub: net.subject, email: net.email, nonce: net.nonce };
    if (net.verified !== undefined) claims.email_verified = net.verified;
    if (net.hd !== undefined) claims.hd = net.hd;
    if (net.override) claims = net.override(claims);
    return ok({ id_token: await sign(claims, net.forge ? attackerKey.privateKey : rsa.privateKey), access_token: 'a', token_type: 'bearer', ...(apple ? { refresh_token: `refresh-${net.subject}` } : {}) });
  }
  if (target === 'https://appleid.apple.com/auth/revoke') return new Response(null, { status: 200 });
  throw new Error(`Unexpected network call: ${target}`);
};

let db = createD1({ migrationsUpTo: '0010_personal_restore.sql' });
const env = { DB: db, ASSETS: { fetch: async () => new Response('ok') }, GOOGLE_OAUTH_CLIENT_ID: 'google-client', GOOGLE_OAUTH_CLIENT_SECRET: 's', APPLE_OAUTH_CLIENT_ID: 'com.reptrio.signin', APPLE_OAUTH_TEAM_ID: 'TEAM123456', APPLE_OAUTH_KEY_ID: 'KEY1234567', APPLE_OAUTH_PRIVATE_KEY: applePrivateKey };
const call = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, { waitUntil() {} });
const authed = (token, init = {}) => ({ ...init, headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
const count = (sql, ...values) => db.rows(sql, ...values)[0].n;
const userCount = () => count('SELECT COUNT(*) AS n FROM users');

// One sign-in. Returns { id, token } on success or { error } with the auth_error code. `body` adds raw callback fields.
async function signIn(provider, { sub, email, verified, hd = undefined, override = null, forge = false, body = {}, nonce = null, replay = null, interrupt = false }) {
  const start = await call(`/api/auth/oauth/${provider}/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}`);
  const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]);
  const state = cookies.find(value => value.startsWith('aks_oauth_state=')).split('=')[1];
  net.nonce = nonce ?? cookies.find(value => value.startsWith('aks_oauth_nonce=')).split('=')[1];
  Object.assign(net, { subject: sub, email, verified, hd, override, forge });
  const cookieHeader = (replay?.cookies || cookies).join('; ');
  const params = { code: 'provider-code', state: replay?.state || state, ...body };
  const callback = provider === 'apple'
    ? await call('/api/auth/oauth/apple/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader }, body: new URLSearchParams(params) })
    : await call(`/api/auth/oauth/google/callback?${new URLSearchParams(params)}`, { headers: { Cookie: cookieHeader } });
  Object.assign(net, { override: null, forge: false });
  const location = new URL(callback.headers.get('Location'));
  if (location.searchParams.get('auth_error')) return { error: location.searchParams.get('auth_error'), cookies, state };
  if (interrupt) return { code: location.searchParams.get('code') };
  const exchange = await call('/api/auth/oauth/mobile/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ code: location.searchParams.get('code') }) });
  if (exchange.status !== 201) return { exchangeStatus: exchange.status }; 
  const result = await exchange.json();
  return { ...result.user, token: result.sessionToken, cookies, state }; 
}
const register = async (email, password = 'password123') => (await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ email, password }) })).json().then(b => ({ id: b.user.id, token: b.sessionToken }));
const post = (path, value) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify(value) });
const info = async token => {
  const response = await call('/api/me', authed(token));
  assert.equal(response.status, 200);
  return (await response.json()).user;
};
const login = async (email, extra = {}) => {
  const response = await post('/api/auth/login', { email, password: 'password123', ...extra });
  assert.equal(response.status, 201);
  return response.json();
};
// Same binding before/after migration proves absent capability is never permanently cached.
const oldEmail = await register('old-email@example.test');
assert.equal((await info(oldEmail.token)).onboardingEligible, false);
const oldGoogle = await signIn('google', { sub: 'old-google', email: 'old-google@gmail.com', verified: true });
const oldApple = await signIn('apple', { sub: 'old-apple', email: 'old-apple@example.test', verified: 'true' });
assert.equal(oldGoogle.onboardingEligible, false);
assert.equal(oldApple.onboardingEligible, false);
const { readFileSync } = await import('node:fs');
db.raw.exec(readFileSync(new URL('../migrations/0011_onboarding_eligibility.sql', import.meta.url), 'utf8'));
assert.ok(db.rows('SELECT onboarding_eligible FROM users').every(row => row.onboarding_eligible === 0));
for (const account of [oldEmail, oldGoogle, oldApple]) assert.equal((await info(account.token)).onboardingEligible, false);
assert.equal((await login('old-email@example.test', { onboardingEligible: true })).user.onboardingEligible, false);
assert.equal((await signIn('google', { sub: 'old-google', email: 'old-google@gmail.com', verified: true })).onboardingEligible, false);
assert.equal((await signIn('apple', { sub: 'old-apple', email: 'old-apple@example.test', verified: 'true' })).onboardingEligible, false);
assert.equal((await signIn('apple', { sub: 'new-link', email: 'old-google@gmail.com', verified: 'true' })).onboardingEligible, false);
const fresh = await post('/api/auth/register', { email: 'fresh@example.test', password: 'password123', onboardingEligible: false });
assert.equal(fresh.status, 201);
const freshBody = await fresh.json();
assert.equal(freshBody.user.onboardingEligible, true);
assert.equal((await info(freshBody.sessionToken)).onboardingEligible, true);
assert.equal((await login('fresh@example.test')).user.onboardingEligible, true);
assert.equal((await info(oldEmail.token)).id, oldEmail.id);
assert.equal((await info(oldEmail.token)).onboardingEligible, false, 'wrong account cannot inherit fresh eligibility');
assert.deepEqual({ ...await currentUser(new Request(`${ORIGIN}/api/me`, authed(freshBody.sessionToken)), env) }, { id: freshBody.user.id, email: freshBody.user.email }, 'private auth remains unchanged');
for (const provider of ['google', 'apple']) {
  const args = { sub: `new-${provider}`, email: `new-${provider}@gmail.com`, verified: provider === 'apple' ? 'true' : true };
  const created = await signIn(provider, args);
  assert.equal(created.onboardingEligible, true);
  assert.equal((await info(created.token)).onboardingEligible, true);
  assert.equal((await signIn(provider, args)).onboardingEligible, true);
  const interrupted = await signIn(provider, { ...args, sub: `lost-${provider}`, email: `lost-${provider}@gmail.com`, interrupt: true });
  assert.ok(interrupted.code);
  const recovered = await signIn(provider, { ...args, sub: `lost-${provider}`, email: `lost-${provider}@gmail.com` });
  assert.equal((await info(recovered.token)).onboardingEligible, true, 'unreceived callback/exchange does not lose durable eligibility');
  const exchange = await post('/api/auth/oauth/mobile/exchange', { code: interrupted.code });
  assert.equal(exchange.status, 201);
  const exchanged = await exchange.json();
  assert.equal(exchanged.user.onboardingEligible, true);
  assert.equal((await info(exchanged.sessionToken)).onboardingEligible, true, 'lost exchange response recoverable via server read');
  assert.equal((await post('/api/auth/oauth/mobile/exchange', { code: interrupted.code })).status, 401, 'single use retained');
  const expired = await signIn(provider, { ...args, sub: `expired-${provider}`, email: `expired-${provider}@gmail.com`, interrupt: true });
  db.raw.exec("UPDATE mobile_oauth_codes SET expires_at = '2000-01-01'");
  assert.equal((await post('/api/auth/oauth/mobile/exchange', { code: expired.code })).status, 401);
}
assert.equal((await post('/api/auth/oauth/mobile/exchange', { code: 'malformed', onboardingEligible: true })).status, 401);
assert.equal((await call('/api/me', authed('wrong-token'))).status, 401);
// Neither probe errors nor flag read errors may be interpreted as an old schema.
for (const pattern of [/^PRAGMA table_info/, /^SELECT onboarding_eligible/]) {
  db.setFailOn(pattern);
  await assert.rejects(() => info(freshBody.sessionToken), /D1_INJECTED_FAILURE/);
  db.setFailOn(null);
}
console.log('Onboarding eligibility PASS: real SQLite migration defaults, email/Google/Apple INSERT only, existing link/login, server /me ownership, interrupted callback/exchange, absent schema then migration, replay/expiry/malformed codes, unchanged private auth, propagated database failures.');
db.raw.close();
