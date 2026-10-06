import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { providerEmailTrusted, providerEmailVerified } from '../worker/account-api.js';
import { createD1 } from './lib/d1-sqlite.mjs';

// Issue #12: OAuth identity → Reptrio account linking on real SQLite with the repository migrations, through the real
// OAuth start → callback → mobile exchange path, with locally signed ID tokens (and forged / wrong ones). The identity
// key is provider + sub; an email links to an existing account only when the provider verified it (Google:
// email_verified === true; Apple: "true" / true) AND the account's email was proven by the verified provider identity
// that created it. Otherwise sign-in fails closed with no link and no duplicate account. Covers Google and Apple
// separately, token validation (signature, iss, aud, exp, nonce, replay), request-body emails, cross-account takeover
// attempts followed by account deletion, and the #6 Apple re-authorization binding.
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

const db = createD1();
const env = { DB: db, ASSETS: { fetch: async () => new Response('ok') }, GOOGLE_OAUTH_CLIENT_ID: 'google-client', GOOGLE_OAUTH_CLIENT_SECRET: 's', APPLE_OAUTH_CLIENT_ID: 'com.reptrio.signin', APPLE_OAUTH_TEAM_ID: 'TEAM123456', APPLE_OAUTH_KEY_ID: 'KEY1234567', APPLE_OAUTH_PRIVATE_KEY: applePrivateKey };
const call = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, { waitUntil() {} });
const authed = (token, init = {}) => ({ ...init, headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
const count = (sql, ...values) => db.rows(sql, ...values)[0].n;
const userCount = () => count('SELECT COUNT(*) AS n FROM users');

// One sign-in. Returns { id, token } on success or { error } with the auth_error code. `body` adds raw callback fields.
async function signIn(provider, { sub, email, verified, hd = undefined, override = null, forge = false, body = {}, nonce = null, replay = null }) {
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
  const exchange = await call('/api/auth/oauth/mobile/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ code: location.searchParams.get('code') }) });
  assert.equal(exchange.status, 201);
  const result = await exchange.json();
  return { id: result.user.id, token: result.sessionToken, email: result.user.email, cookies, state };
}
const register = async (email, password = 'password123') => (await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ email, password }) })).json().then(b => ({ id: b.user.id, token: b.sessionToken }));
const LINK_ERROR = 'OAUTH_ACCOUNT_LINK_REQUIRES_VERIFICATION';

// ---- providerEmailVerified: provider-specific semantics (token claims only).
assert.deepEqual([true, 'true', false, 'false', undefined, 1, 'TRUE'].map(value => providerEmailVerified('google', { email_verified: value })), [true, false, false, false, false, false, false], 'Google: boolean true only');
assert.deepEqual([true, 'true', false, 'false', undefined, 1].map(value => providerEmailVerified('apple', { email_verified: value })), [true, true, false, false, false, false], 'Apple: "true" or true');
assert.equal(providerEmailVerified('other', { email_verified: true }), false);
// providerEmailTrusted: Google is authoritative only for @gmail.com, or a verified Workspace account whose hd is the
// email's domain; Apple: verified.
assert.deepEqual([
  [{ email_verified: true }, 'a@gmail.com'],
  [{ email_verified: true, hd: 'startup.io' }, 'a@startup.io'],
  [{ email_verified: true, hd: 'STARTUP.IO' }, 'a@startup.io'],
  [{ email_verified: true }, 'a@startup.io'],
  [{ email_verified: true, hd: 'other.io' }, 'a@startup.io'],
  [{ email_verified: true, hd: '' }, 'a@startup.io'],
  [{ email_verified: true, hd: 'io' }, 'a@startup.io'],
  [{ email_verified: true, hd: 'up.io' }, 'a@startup.io'],
  [{ email_verified: false }, 'a@gmail.com'],
  [{ email_verified: 'true', hd: 'startup.io' }, 'a@startup.io'],
].map(([claims, email]) => providerEmailTrusted('google', claims, email)), [true, true, true, false, false, false, false, false, false, false]);
assert.deepEqual([providerEmailTrusted('apple', { email_verified: 'true' }, 'x@startup.io'), providerEmailTrusted('apple', { email_verified: 'false' }, 'x@icloud.com')], [true, false]);

// ======== Google ========
{
  // G1: a new verified identity creates an account; the same provider + sub signs in to it.
  const first = await signIn('google', { sub: 'g-1', email: 'g1@example.test', verified: true });
  assert.ok(first.id);
  assert.equal((await signIn('google', { sub: 'g-1', email: 'g1@example.test', verified: true })).id, first.id, 'G1: provider + sub → same account');
  // G2: same sub, changed email (even unverified now) → the same account; the email never re-routes it.
  const decoy = await register('g1-new@example.test');
  const moved = await signIn('google', { sub: 'g-1', email: 'g1-new@example.test', verified: false });
  assert.equal(moved.id, first.id, 'G2: sub wins over the new email');
  assert.notEqual(moved.id, decoy.id);
  // G3a: new sub + existing email + verified, account proven by a verified provider identity → linked.
  const appleMade = await signIn('apple', { sub: 'a-proven', email: 'proven@example.test', verified: 'true' });
  const linked = await signIn('google', { sub: 'g-proven', email: 'proven@example.test', verified: true, hd: 'example.test' });
  assert.equal(linked.id, appleMade.id, 'G3a: an authoritative Google email (Workspace hd) links to a provider-proven account');
  // G3c (HIGH: stale company email): a consumer Google account verified for victim@startup.io (no hd), a mismatched hd,
  // or an empty hd is not authoritative → no link into the victim's Apple-created account, no session, no deletion.
  const company = await signIn('apple', { sub: 'a-company', email: 'victim@startup.io', verified: 'true' });
  for (const [label, hd] of [['no hd', undefined], ['other domain', 'other.io'], ['empty hd', '']]) {
    const attempt = await signIn('google', { sub: `g-stale-${label}`, email: 'victim@startup.io', verified: true, hd });
    assert.equal(attempt.error, LINK_ERROR, `G3c ${label}`);
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ?", company.id), 1, 'still only the Apple link');
  // The company's real Workspace identity (hd = startup.io) and a @gmail.com identity are authoritative.
  assert.equal((await signIn('google', { sub: 'g-workspace', email: 'victim@startup.io', verified: true, hd: 'startup.io' })).id, company.id, 'G3c Workspace');
  const gmailOwner = await signIn('apple', { sub: 'a-gmail', email: 'someone@gmail.com', verified: 'true' });
  assert.equal((await signIn('google', { sub: 'g-gmail', email: 'someone@gmail.com', verified: true })).id, gmailOwner.id, 'G3c gmail');
  // Reverse: an account created by a verified but NOT authoritative Google identity is not proven, so the real
  // owner's later Apple sign-in is not linked into it (it would hand them an account someone else controls).
  const squat = await signIn('google', { sub: 'g-squat', email: 'owner@corp.example', verified: true });
  assert.ok(squat.id, 'creation needs only email_verified');
  assert.equal((await signIn('apple', { sub: 'a-real-owner', email: 'owner@corp.example', verified: 'true' })).error, LINK_ERROR, 'reverse takeover blocked');
  assert.equal(count("SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ?", appleMade.id), 2);
  // G3b: new sub + existing PASSWORD account email + verified → fail closed (password emails were never proven).
  const passwordUser = await register('password-owner@example.test');
  const before = userCount();
  const blocked = await signIn('google', { sub: 'g-pw', email: 'password-owner@example.test', verified: true });
  assert.equal(blocked.error, LINK_ERROR, 'G3b');
  assert.equal(userCount(), before, 'no duplicate account');
  assert.equal(count("SELECT COUNT(*) AS n FROM oauth_accounts WHERE provider_subject = 'g-pw'"), 0, 'no link');
  // G4 / G5: email_verified false / missing / wrong type → no link to an existing account, no new account either.
  for (const [label, verified] of [['false', false], ['missing', undefined], ['string "true"', 'true'], ['number 1', 1]]) {
    assert.equal((await signIn('google', { sub: `g-x-${label}`, email: 'proven@example.test', verified })).error, LINK_ERROR, `G4/5 link: ${label}`);
    assert.equal((await signIn('google', { sub: `g-y-${label}`, email: `fresh-${label.replace(/\W/g, '')}@example.test`, verified })).error, 'OAUTH_EMAIL_UNVERIFIED', `G4/5 create: ${label}`);
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM oauth_accounts WHERE provider_subject LIKE 'g-x-%' OR provider_subject LIKE 'g-y-%'"), 0);
  // G6: an email / user id / provider in the request is ignored; only the verified token decides.
  const spoof = await signIn('google', { sub: 'g-spoof', email: 'spoofer@example.test', verified: true, body: { email: 'proven@example.test', user_id: appleMade.id, provider: 'apple', email_verified: 'true' } });
  assert.notEqual(spoof.id, appleMade.id, 'G6: request-body email / user id cannot link');
  assert.equal(spoof.email, 'spoofer@example.test');
  // G7–G10: token validation failures create and link nothing.
  const total = userCount();
  for (const [label, options, code] of [
    ['wrong audience', { override: c => ({ ...c, aud: 'someone-else' }) }, 'OAUTH_AUDIENCE_INVALID'],
    ['wrong issuer', { override: c => ({ ...c, iss: 'https://evil.example' }) }, 'OAUTH_ISSUER_INVALID'],
    ['expired', { override: c => ({ ...c, exp: Math.floor(Date.now() / 1000) - 10 }) }, 'OAUTH_TOKEN_EXPIRED'],
    ['forged signature', { forge: true }, 'OAUTH_SIGNATURE_INVALID'],
    ['missing sub', { override: c => ({ ...c, sub: undefined }) }, 'OAUTH_SUBJECT_MISSING'],
  ]) assert.equal((await signIn('google', { sub: 'g-proven', email: 'proven@example.test', verified: true, ...options })).error, code, `Google ${label}`);
  assert.equal(userCount(), total);
}

// ======== Apple ========
{
  // A1 / A2: Apple sub is the key; a relay ↔ real email change keeps the same account.
  const first = await signIn('apple', { sub: 'a-1', email: 'abc@privaterelay.appleid.com', verified: 'true' });
  assert.equal((await signIn('apple', { sub: 'a-1', email: 'abc@privaterelay.appleid.com', verified: true })).id, first.id, 'A1');
  assert.equal((await signIn('apple', { sub: 'a-1', email: 'real-person@example.test', verified: 'true' })).id, first.id, 'A2: sub wins over an email change');
  // A3: a different Apple sub with the same email: unverified → rejected; verified but a password account → rejected;
  // verified and provider-proven → linked (policy).
  const owner = await signIn('apple', { sub: 'a-owner', email: 'apple-owner@example.test', verified: 'true' });
  assert.equal((await signIn('apple', { sub: 'a-intruder', email: 'apple-owner@example.test', verified: 'false' })).error, LINK_ERROR, 'A3 unverified');
  assert.equal((await signIn('apple', { sub: 'a-intruder', email: 'apple-owner@example.test', verified: undefined })).error, LINK_ERROR, 'A3 missing claim');
  await register('apple-pw@example.test');
  assert.equal((await signIn('apple', { sub: 'a-pw', email: 'apple-pw@example.test', verified: 'true' })).error, LINK_ERROR, 'A3 password account');
  assert.equal((await signIn('apple', { sub: 'a-second', email: 'apple-owner@example.test', verified: 'true' })).id, owner.id, 'A3 verified + proven');
  // A4–A8: token validation.
  for (const [label, options, code] of [
    ['wrong issuer', { override: c => ({ ...c, iss: 'https://accounts.google.com' }) }, 'OAUTH_ISSUER_INVALID'],
    ['wrong audience', { override: c => ({ ...c, aud: 'com.other.app' }) }, 'OAUTH_AUDIENCE_INVALID'],
    ['expired', { override: c => ({ ...c, exp: 1 }) }, 'OAUTH_TOKEN_EXPIRED'],
    ['invalid signature', { forge: true }, 'OAUTH_SIGNATURE_INVALID'],
    ['nonce mismatch', { nonce: 'not-the-session-nonce' }, 'OAUTH_NONCE_INVALID'],
    ['nonce missing', { override: c => ({ ...c, nonce: undefined }) }, 'OAUTH_NONCE_INVALID'],
  ]) assert.equal((await signIn('apple', { sub: 'a-owner', email: 'apple-owner@example.test', verified: 'true', ...options })).error, code, `Apple ${label}`);
  // Replay: a callback replayed with another browser's state cookie fails the state check.
  const victimFlow = await signIn('apple', { sub: 'a-owner', email: 'apple-owner@example.test', verified: 'true' });
  assert.equal((await signIn('apple', { sub: 'a-owner', email: 'apple-owner@example.test', verified: 'true', replay: { state: victimFlow.state, cookies: ['aks_oauth_state=attacker-state', 'aks_oauth_nonce=x', 'aks_oauth_client=mobile', 'aks_oauth_redirect=reptrio://auth'] } })).error, 'OAUTH_STATE_INVALID', 'replay rejected');
  // A9: Apple's raw `user` form field (name / email, client-supplied) is never trusted over the verified token.
  const raw = await signIn('apple', { sub: 'a-raw', email: 'raw-token@privaterelay.appleid.com', verified: 'true', body: { user: JSON.stringify({ email: 'apple-owner@example.test', name: { firstName: 'X' } }) } });
  assert.notEqual(raw.id, owner.id, 'A9: raw callback email ignored');
  assert.equal(raw.email, 'raw-token@privaterelay.appleid.com');
  // A10 (#6): Apple re-authorization for deletion only accepts the Apple ID linked to the signed-in account.
  const ticket = (await (await call('/api/auth/reauth/apple', authed(owner.token, { method: 'POST', body: '{}' }))).json()).ticket;
  const start = await call(`/api/auth/oauth/apple/start?client=mobile&redirect_uri=${encodeURIComponent('reptrio://auth')}&reauth=${ticket}`);
  const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]);
  Object.assign(net, { nonce: cookies.find(v => v.startsWith('aks_oauth_nonce=')).split('=')[1], subject: 'a-raw', email: 'raw-token@privaterelay.appleid.com', verified: 'true' });
  const reauth = await call('/api/auth/oauth/apple/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.join('; ') }, body: new URLSearchParams({ code: 'c', state: cookies.find(v => v.startsWith('aks_oauth_state=')).split('=')[1] }) });
  assert.equal(new URL(reauth.headers.get('Location')).searchParams.get('auth_error'), 'APPLE_REAUTH_MISMATCH', 'A10: a different Apple sub is rejected');
}

// ======== Cross-account takeover, then account deletion ========
{
  // Victim A: an OAuth-created account (deletable without a password since #6) and a password account.
  const victim = await signIn('google', { sub: 'g-victim', email: 'victim@example.test', verified: true });
  const victimPw = await register('victim-pw@example.test', 'victim-pass-1');
  const usersBefore = userCount();
  // Attacker B presents the victim's email from another identity: unverified, or verified-but-password-account,
  // or through Apple — none links, none gets a session for A.
  for (const [provider, email, verified] of [['google', 'victim@example.test', false], ['google', 'victim@example.test', undefined], ['apple', 'victim@example.test', 'false'], ['google', 'victim-pw@example.test', true], ['apple', 'victim-pw@example.test', 'true']]) {
    const attempt = await signIn(provider, { sub: `attacker-${provider}-${email}-${verified}`, email, verified });
    assert.equal(attempt.error, LINK_ERROR, `${provider} ${email} ${verified}`);
    assert.equal(attempt.token, undefined, 'no session');
  }
  assert.equal(userCount(), usersBefore, 'no duplicate accounts');
  assert.equal(count("SELECT COUNT(*) AS n FROM oauth_accounts WHERE provider_subject LIKE 'attacker-%'"), 0, 'no provider links');
  // Without a session for A the deletion endpoint is unreachable; A's data and sessions are intact.
  assert.equal((await call('/api/auth/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE', userId: victim.id }) })).status, 401);
  assert.equal((await call('/api/me', authed(victim.token))).status, 200);
  assert.equal((await call('/api/me', authed(victimPw.token))).status, 200);
  assert.equal(count('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?)', victim.id, victimPw.id), 2);
  // The attacker's own verified identity (own email) gets its own account, and deleting it touches only that one.
  const attacker = await signIn('google', { sub: 'g-attacker-own', email: 'attacker@example.test', verified: true });
  assert.notEqual(attacker.id, victim.id);
  assert.equal((await call('/api/auth/delete', authed(attacker.token, { method: 'POST', body: JSON.stringify({ confirm: 'DELETE', userId: victim.id }) }))).status, 200);
  assert.equal(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', victim.id), 1, 'victim survives');
  assert.equal(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', attacker.id), 0);
}

// ======== Proof of the account's email (HIGH 2 / MEDIUM 3) ========
{
  const link = (sub, email) => signIn('google', { sub, email, verified: true, hd: email.split('@')[1] });
  // Legacy creating link (NULL, before migration 0006) → not proven; after its owner signs in again → proven.
  const legacy = await signIn('apple', { sub: 'a-legacy', email: 'legacy@site.example', verified: 'true' });
  db.raw.prepare("UPDATE oauth_accounts SET email_trusted = NULL WHERE provider_subject = 'a-legacy'").run();
  assert.equal((await link('g-legacy-1', 'legacy@site.example')).error, LINK_ERROR, 'legacy NULL → not proven');
  assert.equal((await signIn('apple', { sub: 'a-legacy', email: 'legacy@site.example', verified: 'true' })).id, legacy.id);
  assert.equal((await link('g-legacy-2', 'legacy@site.example')).id, legacy.id, 'owner sign-in refreshes the proof');
  // The creating identity later signs in unverified → the proof is withdrawn.
  const downgraded = await signIn('apple', { sub: 'a-down', email: 'down@site.example', verified: 'true' });
  await signIn('apple', { sub: 'a-down', email: 'down@site.example', verified: 'false' });
  assert.equal((await link('g-down', 'down@site.example')).error, LINK_ERROR, 'downgraded creating identity → not proven');
  assert.ok(downgraded.id);
  // A trusted link that did NOT create the account (legacy password account + later link) proves nothing.
  const pw = await register('pw-linked@site.example');
  const later = new Date(Date.now() + 5000).toISOString();
  db.raw.prepare("INSERT INTO oauth_accounts (provider, provider_subject, user_id, email, email_trusted, created_at, last_login_at) VALUES ('apple', 'a-later', ?, 'pw-linked@site.example', 1, ?, ?)").run(pw.id, later, later);
  assert.equal((await link('g-pw-later', 'pw-linked@site.example')).error, LINK_ERROR, 'non-creating trusted link → not proven');
  // The creating identity's provider email changed: the account's old address is no longer proven by it.
  const moved = await signIn('apple', { sub: 'a-moved', email: 'old-address@site.example', verified: 'true' });
  assert.equal((await signIn('apple', { sub: 'a-moved', email: 'new-address@site.example', verified: 'true' })).id, moved.id);
  assert.equal((await link('g-recycled', 'old-address@site.example')).error, LINK_ERROR, 'recycled old address cannot link');
}

// ======== Atomicity: no half user, no user without its provider, no link to a wrong account ========
{
  db.setFailOn(/^INSERT INTO oauth_accounts/);
  const failed = await signIn('google', { sub: 'g-atomic', email: 'atomic@example.test', verified: true });
  db.setFailOn(null);
  assert.ok(failed.error);
  assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE email = 'atomic@example.test'"), 0, 'no user without its provider link');
  // Every link created in this test points at an account whose creating identity proved the email, or at the account
  // of the same provider + sub.
  const orphanLinks = count('SELECT COUNT(*) AS n FROM oauth_accounts o LEFT JOIN users u ON u.id = o.user_id WHERE u.id IS NULL');
  assert.equal(orphanLinks, 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM oauth_accounts WHERE email_trusted IS NULL'), 0, 'new links record whether the email is trusted');
}

console.log('OAuth linking (#12): provider + sub is the key (Google / Apple), verified email required to link (Google boolean true; Apple "true" / true) and only into provider-proven accounts, password accounts fail closed, unverified new accounts refused, token iss / aud / exp / signature / nonce / replay rejected, request-body and Apple raw user emails ignored, no takeover or cross-account deletion, Apple re-authorization bound, atomic creation.');
