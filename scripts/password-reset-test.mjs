import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { tokenDigest } from '../worker/account-api.js';
import { sendTransactionalEmail } from '../worker/transactional-email.js';
import { createD1 } from './lib/d1-sqlite.mjs';

// Build 43 G — password reset on real SQLite with the repository migrations and a mocked ZeptoMail API. Covers:
// enumeration safety (status / body / headers / timing), the token never stored or logged in plaintext, single use,
// expiry boundary, wrong / malformed tokens, deleted and nonexistent accounts, prior-link revocation and the silent
// per-account throttle, the IP rate limiter, the password policy (without consuming the link), atomic consume +
// password change + session invalidation, OAuth-only accounts (no link, parity with account deletion), the provider
// adapter request, and the HTTPS reset page.
const ORIGIN = 'https://api.reptrio.test';
const LINK_ORIGIN = 'https://api.reptrio.com';
const API_KEY = 'zepto-test-key-DO-NOT-LOG';
const ZEPTO_URL = 'https://cpaas.zoho.eu/v1.1/email';

// ---- Captured logs (must never contain secrets, tokens, digests, emails or links).
const logs = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => { logs.push(args.map(String).join(' ')); };

// ---- ZeptoMail mock.
const mail = { sent: [], delayMs: 0, status: 200, fail: false };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== ZEPTO_URL) throw new Error(`Unexpected network call in test: ${url}`);
  if (mail.delayMs) await new Promise(resolve => setTimeout(resolve, mail.delayMs));
  if (mail.fail) throw new TypeError('fetch failed');
  mail.sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) });
  return new Response(JSON.stringify({ data: [], message: 'OK', request_id: 'r' }), { status: mail.status });
};

const db = createD1();
const limiter = { allow: true, keys: [] };
const env = {
  DB: db,
  ASSETS: { fetch: async () => new Response('asset') },
  ZEPTOMAIL_API_KEY: API_KEY,
  PASSWORD_RESET_LIMITER: { limit: async ({ key }) => { limiter.keys.push(key); return { success: limiter.allow }; } },
};
let pending = [];
const ctx = { waitUntil: promise => { pending.push(promise); } };
const settle = async () => { const tasks = pending; pending = []; await Promise.all(tasks); };
const call = (path, init = {}, overrideEnv = env) => worker.fetch(new Request(`${ORIGIN}${path}`, init), overrideEnv, ctx);
const post = (path, payload, headers = {}) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile', ...headers }, body: JSON.stringify(payload) });
const forgot = (email, headers) => post('/api/auth/password/forgot', { email }, headers);
const reset = (token, password) => post('/api/auth/password/reset', { token, password });
const login = async (email, password) => (await post('/api/auth/login', { email, password })).status;
const me = async token => (await call('/api/me', { headers: { Authorization: `Bearer ${token}` } })).status;
const tokenFrom = sent => { const match = /#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(sent.body.textbody); assert.ok(match, 'mail carries a link token'); return match[1]; };
const tokenRows = userId => db.rows('SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at', userId);
const ageTokens = (userId, ms) => db.rows('SELECT id, created_at FROM password_reset_tokens WHERE user_id = ?', userId).forEach(row => db.raw.prepare('UPDATE password_reset_tokens SET created_at = ? WHERE id = ?').run(new Date(Date.parse(row.created_at) - ms).toISOString(), row.id));

async function register(email, password = 'password123') {
  const response = await post('/api/auth/register', { email, password });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { id: body.user.id, email, token: body.sessionToken };
}
// The shape `upsertOAuthUser` writes: the user and its first provider link share created_at (generated password).
async function oauthUser(provider, email) {
  const id = crypto.randomUUID();
  const now = new Date(Date.now() - 1000).toISOString();
  db.raw.prepare('INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email, 'generated', 'c2FsdA', now);
  db.raw.prepare('INSERT INTO oauth_accounts (provider, provider_subject, user_id, email, email_trusted, created_at, last_login_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(provider, `${provider}-${id}`, id, email, now, now);
  return { id, email, token: await session(id) };
}
async function session(userId) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const now = new Date();
  db.raw.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), userId, await tokenDigest(token), now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  return token;
}
async function requestLink(user) {
  mail.sent = [];
  const response = await forgot(user.email);
  assert.equal(response.status, 202);
  await settle();
  assert.equal(mail.sent.length, 1, `one mail for ${user.email}`);
  return tokenFrom(mail.sent[0]);
}
const clearThrottle = user => ageTokens(user.id, 2 * 3_600_000);

const alice = await register('alice@example.test');
const bob = await register('bob@example.test');
const google = await oauthUser('google', 'g-only@example.test');
const apple = await oauthUser('apple', 'a-only@privaterelay.appleid.com');
const mixed = await register('mixed@example.test');
db.raw.prepare("INSERT INTO oauth_accounts (provider, provider_subject, user_id, email, email_trusted, created_at, last_login_at) VALUES ('google', 'g-mixed', ?, ?, 1, ?, ?)").run(mixed.id, mixed.email, new Date(Date.now() + 5000).toISOString(), new Date().toISOString());
const deleted = await register('deleted@example.test');
db.raw.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), deleted.id);

// ---- 1. Enumeration safety: identical status, body and headers for every account state; the response never waits
// for the account lookup or the mail send.
{
  const shape = async email => {
    const response = await forgot(email);
    const headers = [...response.headers.entries()].filter(([name]) => name !== 'date');
    return { status: response.status, body: await response.text(), headers };
  };
  const reference = await shape('nobody@example.test');
  assert.deepEqual(reference.status, 202);
  assert.deepEqual(JSON.parse(reference.body), { ok: true });
  for (const email of [alice.email, 'ALICE@Example.test ', google.email, apple.email, deleted.email, mixed.email]) assert.deepEqual(await shape(email), reference, `same response for ${email}`);
  await settle();
  clearThrottle(alice); clearThrottle(mixed);

  // The response resolves before the (slow) mail is sent — proof the send is not on the request path.
  mail.delayMs = 400; mail.sent = [];
  let mailDone = false;
  const started = Date.now();
  const response = await forgot(alice.email);
  const elapsed = Date.now() - started;
  const tasks = pending.splice(0);
  Promise.all(tasks).then(() => { mailDone = true; });
  assert.equal(response.status, 202);
  assert.equal(mailDone, false, 'response returned before the mail send finished');
  assert.ok(elapsed < 200, `response not delayed by the mail send (${elapsed} ms)`);
  await Promise.all(tasks);
  mail.delayMs = 0;
  clearThrottle(alice);

  // Timing: median latency for an existing vs a nonexistent account differs by less than a tolerance.
  const median = async email => {
    const samples = [];
    for (let index = 0; index < 15; index += 1) {
      const begin = performance.now();
      await forgot(email);
      samples.push(performance.now() - begin);
      await settle();
      clearThrottle(alice);
    }
    return samples.sort((a, b) => a - b)[7];
  };
  mail.delayMs = 50;
  const existing = await median(alice.email);
  const missing = await median('ghost@example.test');
  mail.delayMs = 0;
  assert.ok(Math.abs(existing - missing) < 25, `timing within tolerance (existing ${existing.toFixed(1)} ms, missing ${missing.toFixed(1)} ms)`);
}

// ---- 2. Mail request through the provider adapter; link origin fixed (not from Host); token stored only as digest.
{
  clearThrottle(alice);
  mail.sent = [];
  const response = await call('/api/auth/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' }, body: JSON.stringify({ email: alice.email }) });
  assert.equal(response.status, 202);
  await settle();
  assert.equal(mail.sent.length, 1);
  const [sent] = mail.sent;
  assert.equal(sent.url, ZEPTO_URL);
  assert.equal(sent.headers.authorization, `Zoho-enczapikey ${API_KEY}`);
  assert.deepEqual(sent.body.from, { address: 'no-reply@mail.reptrio.com', name: 'Reptrio' });
  assert.deepEqual(sent.body.to, [{ email_address: { address: alice.email } }]);
  assert.equal(sent.body.track_clicks, false);
  assert.equal(sent.body.track_opens, false);
  const token = tokenFrom(sent);
  assert.ok(sent.body.textbody.includes(`${LINK_ORIGIN}/reset-password#token=${token}`), 'link on the fixed HTTPS origin, token in the fragment');
  assert.ok(sent.body.htmlbody.includes(`${LINK_ORIGIN}/reset-password#token=${token}`));
  assert.ok(!JSON.stringify(sent.body).includes('evil.example'));
  const rows = tokenRows(alice.id);
  const active = rows.filter(row => !row.used_at && !row.revoked_at);
  assert.equal(active.length, 1, 'exactly one active link');
  assert.equal(active[0].token_hash, await tokenDigest(token));
  assert.notEqual(active[0].token_hash, token);
  const expiresIn = Date.parse(active[0].expires_at) - Date.parse(active[0].created_at);
  assert.equal(expiresIn, 30 * 60_000, '30 minute lifetime');
  const dump = JSON.stringify(db.rows("SELECT name FROM sqlite_master WHERE type = 'table'").flatMap(({ name }) => db.rows(`SELECT * FROM ${name}`)));
  assert.ok(!dump.includes(token), 'the plaintext token is nowhere in the database');

  // Adapter: a key stored with its prefix is used as is; missing key / network failure never throw.
  const prefixed = [];
  await sendTransactionalEmail({ ZEPTOMAIL_API_KEY: ` Zoho-enczapikey ${API_KEY} ` }, { to: 'x@example.test', subject: 's', text: 't', html: 'h' }, async (url, init) => { prefixed.push(new Headers(init.headers).get('authorization')); return new Response('{}'); });
  assert.deepEqual(prefixed, [`Zoho-enczapikey ${API_KEY}`]);
  assert.deepEqual(await sendTransactionalEmail({}, { to: 'x@example.test', subject: 's', text: 't', html: 'h' }), { ok: false, status: 'not_configured' });
  assert.deepEqual(await sendTransactionalEmail(env, { to: 'x@example.test', subject: 's', text: 't', html: 'h' }, async () => { throw new TypeError('down'); }), { ok: false, status: 'unreachable' });
  assert.deepEqual(await sendTransactionalEmail(env, { to: 'x@example.test', subject: 's', text: 't', html: 'h' }, async () => new Response('{}', { status: 401 })), { ok: false, status: 401 });
}

// ---- 3. Wrong, malformed, missing tokens → one generic error; the password is checked first and never consumes.
{
  clearThrottle(alice);
  const token = await requestLink(alice);
  const generic = { status: 400, body: { code: 'PASSWORD_RESET_INVALID' } };
  const attempt = async (value, password = 'newpassword1') => { const response = await reset(value, password); return { status: response.status, body: await response.json() }; };
  for (const bad of ['A'.repeat(43), token.slice(0, 42), `${token}x`, `${token.slice(0, 42)}+`, `${token.slice(0, 42)}=`, '', null, undefined, 42, ['x'], { token }, `${token.slice(0, 20)}%2F${token.slice(23)}`]) assert.deepEqual(await attempt(bad), generic, `generic error for ${JSON.stringify(bad)}`);
  for (const short of ['', 'seven77', 'x'.repeat(201), 12345678, null]) assert.deepEqual(await attempt(token, short), { status: 400, body: { code: 'AUTH_PASSWORD_TOO_SHORT' } });
  assert.equal(tokenRows(alice.id).filter(row => row.used_at).length, 0, 'rejected passwords did not consume the link');
  assert.equal(await login(alice.email, 'password123'), 201, 'old password still valid');

  // Non-JSON / wrong method / cross-origin.
  assert.equal((await call('/api/auth/password/reset')).status, 405);
  assert.equal((await call('/api/auth/password/forgot', { method: 'POST', body: 'email=a' })).status, 415);
  assert.equal((await post('/api/auth/password/reset', { token, password: 'newpassword1' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await forgot('not-an-email')).status, 400);
}

// ---- 4. Success: password replaced with a fresh salt (same PBKDF2 scheme), every session and pending mobile code
// voided, other links revoked, token consumed once; other users untouched; a "password changed" notice is sent.
{
  clearThrottle(alice);
  const before = db.rows('SELECT password_hash, password_salt FROM users WHERE id = ?', alice.id)[0];
  const webSession = await session(alice.id);
  const bobSession = await session(bob.id);
  db.raw.prepare('INSERT INTO mobile_oauth_codes (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('pending-code', alice.id, await tokenDigest('pending-mobile-code'), new Date().toISOString(), new Date(Date.now() + 300_000).toISOString());
  const token = await requestLink(alice);
  assert.equal(await me(alice.token), 200);
  mail.sent = [];
  const response = await reset(token, 'brand-new-pass');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  await settle();
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].body.subject, 'Reptrio şifren değiştirildi');
  assert.ok(!/token=/.test(mail.sent[0].body.textbody), 'the notice carries no link');
  const after = db.rows('SELECT password_hash, password_salt FROM users WHERE id = ?', alice.id)[0];
  assert.notEqual(after.password_hash, before.password_hash);
  assert.notEqual(after.password_salt, before.password_salt);
  assert.equal(await login(alice.email, 'password123'), 401, 'old password rejected');
  assert.equal(await me(alice.token), 401, 'mobile bearer session invalidated');
  assert.equal(await me(webSession), 401, 'web session invalidated');
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', alice.id)[0].n, 0);
  const exchange = await post('/api/auth/oauth/mobile/exchange', { code: 'pending-mobile-code' });
  assert.equal(exchange.status, 401, 'a pending mobile OAuth code can no longer become a session');
  assert.equal(await me(bobSession), 200, 'another user keeps their session');
  assert.equal(await me(bob.token), 200);
  assert.equal(await login(alice.email, 'brand-new-pass'), 201, 'new password works through the normal login');

  // Single use.
  assert.deepEqual(await (await reset(token, 'another-pass-1')).json(), { code: 'PASSWORD_RESET_INVALID' });
  assert.equal(await login(alice.email, 'brand-new-pass'), 201);
  const rows = tokenRows(alice.id);
  assert.equal(rows.filter(row => row.used_at).length, 1);
  assert.ok(rows.every(row => row.used_at || row.revoked_at), 'no active link left after a reset');
}

// ---- 5. Concurrent double submit: exactly one success.
{
  clearThrottle(bob);
  const token = await requestLink(bob);
  const results = await Promise.all([reset(token, 'parallel-one-1'), reset(token, 'parallel-two-2'), reset(token, 'parallel-three')]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 400, 400]);
  await settle();
  const winners = (await Promise.all(['parallel-one-1', 'parallel-two-2', 'parallel-three'].map(password => login(bob.email, password)))).filter(status => status === 201);
  assert.equal(winners.length, 1, 'exactly one new password is in effect');
}

// ---- 6. Expiry boundary: expires_at == now is invalid; expires_at a moment ahead is valid.
{
  clearThrottle(bob);
  const token = await requestLink(bob);
  const [row] = tokenRows(bob.id).filter(item => !item.used_at && !item.revoked_at);
  db.raw.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), row.id);
  assert.deepEqual(await (await reset(token, 'expired-pass-1')).json(), { code: 'PASSWORD_RESET_INVALID' });
  db.raw.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() + 2000).toISOString(), row.id);
  assert.equal((await reset(token, 'in-time-pass-1')).status, 200);
  await settle();
  assert.equal(await login(bob.email, 'in-time-pass-1'), 201);
}

// ---- 7. Multiple requests: a new link revokes the previous one; the per-account throttle is silent (same 202, no
// new link, no mail) under 60 s and from the 4th request in an hour.
{
  clearThrottle(bob);
  const first = await requestLink(bob);
  ageTokens(bob.id, 61_000);
  const second = await requestLink(bob);
  assert.notEqual(first, second);
  assert.deepEqual(await (await reset(first, 'from-first-11')).json(), { code: 'PASSWORD_RESET_INVALID' }, 'the earlier link is revoked');

  mail.sent = [];
  const tooSoon = await forgot(bob.email);
  assert.equal(tooSoon.status, 202);
  await settle();
  assert.equal(mail.sent.length, 0, 'second request within 60 s sends nothing');
  ageTokens(bob.id, 61_000);
  const third = await requestLink(bob);
  ageTokens(bob.id, 61_000);
  mail.sent = [];
  assert.equal((await forgot(bob.email)).status, 202);
  await settle();
  assert.equal(mail.sent.length, 0, 'fourth request within the hour sends nothing');
  assert.equal(tokenRows(bob.id).filter(row => !row.used_at && !row.revoked_at && Date.parse(row.expires_at) > Date.now()).length, 1);
  assert.equal((await reset(third, 'from-third-111')).status, 200, 'the newest link still works');
  await settle();

  // Parallel requests cannot bypass the per-account throttle: the check is part of the insert transaction.
  clearThrottle(bob);
  mail.sent = [];
  const burst = await Promise.all(Array.from({ length: 10 }, () => forgot(bob.email)));
  assert.ok(burst.every(response => response.status === 202));
  await settle();
  assert.equal(mail.sent.length, 1, 'ten parallel requests send exactly one mail');
  assert.equal(tokenRows(bob.id).filter(row => Date.parse(row.created_at) > Date.now() - 60_000).length, 1, 'and write exactly one link');

  // Issuing a link for one user never revokes or prunes another user's rows.
  const aliceActive = 'E'.repeat(43);
  db.raw.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('alice-active', alice.id, await tokenDigest(aliceActive), new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() + 600_000).toISOString());
  db.raw.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('alice-old', alice.id, 'alice-old-hash', new Date(Date.now() - 30 * 3_600_000).toISOString(), new Date(Date.now() - 29 * 3_600_000).toISOString());
  clearThrottle(bob);
  await requestLink(bob);
  assert.equal(db.rows("SELECT revoked_at FROM password_reset_tokens WHERE id = 'alice-active'")[0].revoked_at, null, "another user's active link is not revoked");
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM password_reset_tokens WHERE id = 'alice-old'")[0].n, 1, "another user's old rows are not pruned");
  db.raw.prepare("DELETE FROM password_reset_tokens WHERE id IN ('alice-active', 'alice-old')").run();

  // Rows older than a day are removed on the next issue.
  clearThrottle(bob);
  ageTokens(bob.id, 25 * 3_600_000);
  const oldCount = tokenRows(bob.id).length;
  await requestLink(bob);
  assert.ok(oldCount > 1 && tokenRows(bob.id).length === 1, 'old link rows are pruned');
}

// ---- 8. IP rate limiter: 429 regardless of the account, keyed per action + client IP; no mail.
{
  limiter.allow = false; mail.sent = [];
  for (const email of [bob.email, 'nobody@example.test']) {
    const response = await forgot(email, { 'CF-Connecting-IP': '203.0.113.9' });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { code: 'PASSWORD_RESET_RATE_LIMITED' });
  }
  assert.equal((await reset('A'.repeat(43), 'whatever-123')).status, 429);
  await settle();
  assert.equal(mail.sent.length, 0);
  limiter.allow = true;
  assert.ok(limiter.keys.includes('forgot:203.0.113.9') && limiter.keys.some(key => key.startsWith('reset:')));
}

// ---- 9. Deleted / nonexistent / OAuth-only accounts: no link, no mail. A mixed account (own password + later link)
// is eligible. Eligibility agrees with account deletion's requiresPassword.
{
  mail.sent = [];
  for (const email of ['nobody@example.test', deleted.email, google.email, apple.email]) assert.equal((await forgot(email)).status, 202);
  await settle();
  assert.equal(mail.sent.length, 0);
  for (const user of [deleted, google, apple]) assert.equal(tokenRows(user.id).length, 0, `no link for ${user.email}`);
  clearThrottle(mixed);
  const mixedToken = await requestLink(mixed);
  assert.equal(mail.sent[0].body.to[0].email_address.address, mixed.email);

  // A link issued before the account became deleted (or turned out OAuth-only) is refused.
  db.raw.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), mixed.id);
  assert.deepEqual(await (await reset(mixedToken, 'mixed-new-pass')).json(), { code: 'PASSWORD_RESET_INVALID' });
  db.raw.prepare('UPDATE users SET deleted_at = NULL WHERE id = ?').run(mixed.id);
  const forged = 'B'.repeat(43);
  db.raw.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('forged', google.id, await tokenDigest(forged), new Date().toISOString(), new Date(Date.now() + 600_000).toISOString());
  assert.deepEqual(await (await reset(forged, 'oauth-new-pass')).json(), { code: 'PASSWORD_RESET_INVALID' }, 'an OAuth-only account never gets a local password');
  assert.equal(db.rows('SELECT password_hash FROM users WHERE id = ?', google.id)[0].password_hash, 'generated');

  const requiresPassword = async user => (await (await call('/api/auth/delete', { headers: { Authorization: `Bearer ${await session(user.id)}` } })).json()).requiresPassword;
  for (const [user, eligible] of [[bob, true], [mixed, true], [google, false], [apple, false]]) assert.equal(await requiresPassword(user), eligible, `eligibility parity for ${user.email}`);
}

// ---- 10. Atomicity: a failure inside the batch rolls back the password change and keeps the link unused.
{
  clearThrottle(mixed);
  const token = await requestLink(mixed);
  const sessionToken = await session(mixed.id);
  db.setFailOn(/DELETE FROM auth_sessions/);
  const response = await reset(token, 'atomic-pass-12');
  db.setFailOn(null);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: 'PASSWORD_RESET_FAILED' });
  assert.equal(await login(mixed.email, 'password123'), 201, 'password unchanged');
  assert.equal(await me(sessionToken), 200, 'sessions unchanged');
  assert.equal(tokenRows(mixed.id).filter(row => row.used_at).length, 0, 'link not consumed');
  assert.equal((await reset(token, 'atomic-pass-12')).status, 200, 'the same link works once the failure is gone');
  await settle();
}

// ---- 10b. Race: the link becomes invalid between the read and the batch (revoked by a newer request or consumed by
// a parallel reset). Every statement of the batch is guarded, so nothing changes: password, sessions, codes.
{
  clearThrottle(mixed);
  const token = await requestLink(mixed);
  const sessionToken = await session(mixed.id);
  db.raw.prepare('INSERT INTO mobile_oauth_codes (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('race-code', mixed.id, 'race-code-hash', new Date().toISOString(), new Date(Date.now() + 300_000).toISOString());
  const racingDb = { ...db, prepare: db.prepare, batch: async statements => { db.raw.prepare('UPDATE password_reset_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND used_at IS NULL').run(new Date().toISOString(), mixed.id); return db.batch(statements); } };
  const response = await worker.fetch(new Request(`${ORIGIN}/api/auth/password/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: 'racing-pass-12' }) }), { ...env, DB: racingDb }, ctx);
  assert.deepEqual({ status: response.status, body: await response.json() }, { status: 400, body: { code: 'PASSWORD_RESET_INVALID' } });
  await settle();
  assert.equal(await login(mixed.email, 'atomic-pass-12'), 201, 'password unchanged');
  assert.equal(await me(sessionToken), 200, 'sessions unchanged');
  assert.equal(db.rows("SELECT used_at FROM mobile_oauth_codes WHERE id = 'race-code'")[0].used_at, null, 'pending code unchanged');
  assert.equal(tokenRows(mixed.id).filter(row => row.used_at && row.revoked_at).length, 0);

  // Same, when the ACCOUNT changes state between the read and the batch (deleted, or turns out provider-created):
  // nothing is committed — not even the session delete or the token consume.
  for (const change of ['deleted', 'provider-created']) {
    clearThrottle(mixed);
    const raceToken = await requestLink(mixed);
    const raceSession = await session(mixed.id);
    const before = db.rows('SELECT password_hash, created_at FROM users WHERE id = ?', mixed.id)[0];
    let undo;
    const changingDb = { ...db, prepare: db.prepare, batch: async statements => {
      if (change === 'deleted') { db.raw.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), mixed.id); undo = () => db.raw.prepare('UPDATE users SET deleted_at = NULL WHERE id = ?').run(mixed.id); }
      else { db.raw.prepare("INSERT INTO oauth_accounts (provider, provider_subject, user_id, email, email_trusted, created_at, last_login_at) VALUES ('apple', 'race-apple', ?, ?, 1, ?, ?)").run(mixed.id, mixed.email, before.created_at, before.created_at); undo = () => db.raw.prepare("DELETE FROM oauth_accounts WHERE provider_subject = 'race-apple'").run(); }
      return db.batch(statements);
    } };
    const raced = await worker.fetch(new Request(`${ORIGIN}/api/auth/password/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raceToken, password: 'racing-pass-34' }) }), { ...env, DB: changingDb }, ctx);
    undo();
    assert.equal(raced.status, 400, change);
    assert.equal(db.rows('SELECT password_hash FROM users WHERE id = ?', mixed.id)[0].password_hash, before.password_hash, `${change}: password unchanged`);
    assert.equal(await me(raceSession), 200, `${change}: sessions unchanged`);
    assert.equal(db.rows('SELECT used_at FROM password_reset_tokens WHERE token_hash = ?', await tokenDigest(raceToken))[0].used_at, null, `${change}: link not consumed`);
  }
}

// ---- 10c. A successful reset revokes every other active link of the user (defence beyond the one-active-link rule).
{
  clearThrottle(mixed);
  const token = await requestLink(mixed);
  const extra = 'C'.repeat(43);
  db.raw.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('extra-active', mixed.id, await tokenDigest(extra), new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() + 600_000).toISOString());
  const bobActive = 'D'.repeat(43);
  db.raw.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('bob-active', bob.id, await tokenDigest(bobActive), new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() + 600_000).toISOString());
  assert.equal((await reset(token, 'mixed-final-12')).status, 200);
  await settle();
  assert.ok(db.rows("SELECT revoked_at FROM password_reset_tokens WHERE id = 'extra-active'")[0].revoked_at, 'other link of the same user revoked');
  assert.deepEqual(await (await reset(extra, 'mixed-extra-12')).json(), { code: 'PASSWORD_RESET_INVALID' });
  assert.equal(db.rows("SELECT revoked_at FROM password_reset_tokens WHERE id = 'bob-active'")[0].revoked_at, null, "another user's link untouched");
  db.raw.prepare("DELETE FROM password_reset_tokens WHERE id = 'bob-active'").run();
}

// ---- 11. A provider failure / missing key keeps the response unchanged and is logged without details.
{
  clearThrottle(bob);
  mail.fail = true;
  assert.equal((await forgot(bob.email)).status, 202);
  await settle();
  mail.fail = false;
  clearThrottle(bob);
  mail.sent = [];
  assert.equal((await call('/api/auth/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: bob.email }) }, { ...env, ZEPTOMAIL_API_KEY: undefined })).status, 202);
  await settle();
  assert.equal(mail.sent.length, 0);
  assert.ok(logs.some(line => line.includes('password_reset_mail_failed') && line.includes('unreachable')));
  assert.ok(logs.some(line => line.includes('password_reset_mail_failed') && line.includes('not_configured')));
}

// ---- 12. Without ctx.waitUntil the work is awaited inline (no lost mail).
{
  clearThrottle(bob);
  mail.sent = [];
  const response = await worker.fetch(new Request(`${ORIGIN}/api/auth/password/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: bob.email }) }), env, undefined);
  assert.equal(response.status, 202);
  assert.equal(mail.sent.length, 1);
}

// ---- 13. Reset page: strict headers, no token in server HTML, fragment-only handling, app handoff, same-origin form.
{
  const page = await call('/reset-password?token=should-not-echo');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const csp = page.headers.get('content-security-policy');
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
  assert.ok(nonce && csp.includes("default-src 'none'") && csp.includes("connect-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("form-action 'none'"));
  assert.ok(!html.includes('should-not-echo'), 'query is never reflected');
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`));
  assert.ok(!/<[a-z]+[^>]*\sstyle="/i.test(html), 'no inline style attributes (CSP)');
  assert.ok(html.includes("/^#token=([A-Za-z0-9_-]{43})$/") && html.includes('history.replaceState') && html.includes("'reptrio://reset-password?token=' + token") && html.includes("fetch('/api/auth/password/reset'"));
  const nonce2 = /'nonce-([A-Za-z0-9_-]+)'/.exec((await call('/reset-password')).headers.get('content-security-policy'))[1];
  assert.notEqual(nonce, nonce2, 'fresh nonce per response');
  assert.equal((await call('/reset-password', { method: 'POST' })).status, 405);
  assert.equal((await call('/api/auth/password/unknown')).status, 200, 'unknown paths fall through to the existing routing');
}

// ---- 14. Nothing sensitive in logs: no token, digest, email, link, key or password.
{
  // A database error message (it can quote SQL and values) is never logged, only its class name.
  const secrets = [API_KEY, 'reset-password#', 'token=', 'D1_INJECTED_FAILURE', 'DELETE FROM', ...['alice', 'bob', 'mixed', 'g-only', 'a-only', 'deleted', 'nobody'].map(name => `${name}@`), 'brand-new-pass', 'password123'];
  for (const row of db.rows('SELECT token_hash FROM password_reset_tokens')) secrets.push(row.token_hash);
  for (const line of logs) for (const secret of secrets) assert.ok(!line.includes(secret), `log line leaks ${secret}: ${line}`);
  assert.ok(logs.some(line => line.includes('password_reset_completed')));
}

globalThis.fetch = realFetch;
Object.assign(console, original);
console.log('Password reset: enumeration-safe 202 (body, headers, timing; work after the response), token only as SHA-256 digest (never in DB/logs), 30 min single use incl. concurrent submit, expiry boundary, wrong/malformed tokens generic, password policy checked before consuming, atomic password change + session / mobile code / other-link invalidation with rollback, prior-link revocation and silent per-account throttle, IP rate limit, deleted / nonexistent / OAuth-only accounts get nothing (parity with account deletion), ZeptoMail EU adapter (no tracking, key never logged), fixed link origin, strict reset page.');
