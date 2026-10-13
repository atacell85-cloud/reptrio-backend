import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createD1 } from './lib/d1-sqlite.mjs';
import { AI_IMPORT_POLICY_VERSION } from '../worker/ai-import-consent.js';

// End-to-end routes and actual D1-style SQL, not a mocked Boolean checkbox.
const ORIGIN = 'https://a2.example';
const net = { count: 0 };
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url) === 'https://api.openai.com/v1/responses' && options.method === 'POST') {
    net.count++;
    return new Response(JSON.stringify({ error: { message: 'mock upstream failure' } }), { status: 503 });
  }
  throw new Error('Unexpected network in AI consent test: ' + String(url));
};

const db = createD1();
const messages = [];
const env = {
  DB: db, OPENAI_API_KEY: 'mock', OPENAI_IMPORT_MAX_RETRIES: '0',
  IMPORT_QUEUE: { send: async message => messages.push(message) },
  ASSETS: { fetch: async () => new Response('ok') },
};
const call = (path, options = {}, override = env) => worker.fetch(new Request(ORIGIN + path, options), override, { waitUntil() {} });
const auth = (token, method = 'GET', payload, options = {}) => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...options },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});
const data = (id = 'data-1') => ({
  importId: id, normalizedDocument: { fileName: 'routine.pdf', fileType: 'pdf',
    language: 'tr', blocks: [{ type: 'paragraph', text: 'Squat 3x10' }] },
});
const consent = (action, policyVersion = AI_IMPORT_POLICY_VERSION) => ({ action, policyVersion });
const register = async (email, dbEnv = env) => {
  const response = await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' },
    body: JSON.stringify({ email, password: 'password123' }) }, dbEnv);
  assert.equal(response.status, 201);
  const json = await response.json();
  return { id: json.user.id, token: json.sessionToken };
};
try {
  assert.equal((await call('/api/privacy/ai-import')).status, 401, 'consent read must be authenticated');
  assert.equal((await call('/api/privacy/ai-import/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(consent('grant')) })).status, 401);
  const alice = await register('ai-alice@example.test');
  const bob = await register('ai-bob@example.test');
  const status = async token => (await (await call('/api/privacy/ai-import', auth(token))).json());
  const put = (token, action, version) => call('/api/privacy/ai-import/consent', auth(token, 'POST', consent(action, version)));
  assert.deepEqual(await status(alice.token), { policyVersion: AI_IMPORT_POLICY_VERSION, granted: false });
  assert.equal((await call('/api/import/parse', auth(alice.token, 'POST', data()))).status, 403, 'legacy parser MUST be gated');
  assert.equal((await call('/api/import/parse', auth('', 'POST', data()))).status, 401);
  assert.equal((await call('/api/import/jobs', auth(alice.token, 'POST', data()))).status, 403);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM import_jobs')[0].n, 0);
  assert.equal(net.count, 0, 'no OpenAI egress without grant');
  assert.equal((await put(alice.token, 'grant', 'old-policy')).status, 400);
  assert.equal((await put(alice.token, 'allow')).status, 400);
  assert.equal((await call('/api/privacy/ai-import/consent', auth(alice.token, 'POST', consent('grant'), { Origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await put(alice.token, 'grant')).status, 200);
  assert.equal((await status(alice.token)).granted, true);
  assert.equal((await status(bob.token)).granted, false);
  assert.equal((await call('/api/import/jobs', auth(bob.token, 'POST', data('bob-job')))).status, 403, 'other account cannot borrow grant');
  const created = await call('/api/import/jobs', auth(alice.token, 'POST', data('shared-job')));
  assert.equal(created.status, 202);
  assert.deepEqual(messages.at(-1), { jobId: 'shared-job', userId: alice.id });
  assert.equal(net.count, 0, 'enqueue does not itself access OpenAI');
  assert.equal((await put(alice.token, 'revoke')).status, 200);
  assert.equal((await status(alice.token)).granted, false);
  assert.equal(db.rows('SELECT status FROM import_jobs WHERE id = ?', 'shared-job')[0].status, 'failed', 'revoke atomically disables queued job');
  let acked = 0;
  await worker.queue({ messages: [{ body: messages.at(-1), ack() { acked++; } }] }, env);
  assert.equal(acked, 1);
  assert.equal(net.count, 0, 'late worker must not call OpenAI after revoke');
  assert.equal((await call('/api/import/jobs/shared-job/retry', auth(alice.token, 'POST'))).status, 403);
  assert.equal((await call('/api/import/parse', auth(alice.token, 'POST', data()))).status, 403);
  assert.equal((await put(alice.token, 'grant')).status, 200);
  // A stale queue delivery from before revocation must not restart merely because the account regranted.
  await worker.queue({ messages: [{ body: messages.at(-1), ack() {} }] }, env);
  assert.equal(net.count, 0, 'previously revoked jobs require an explicit retry after regrant');
  assert.equal((await call('/api/import/jobs/shared-job/retry', auth(alice.token, 'POST'))).status, 202);
  await worker.queue({ messages: [{ body: messages.at(-1), ack() {} }] }, env);
  assert.equal(net.count, 1, 'fresh grant allows authorized worker to call OpenAI');
  // Old queue events without owner ID are ignored, even if a shared import ID exists.
  await worker.queue({ messages: [{ body: { jobId: 'shared-job' }, ack() {} }] }, env);
  assert.equal(net.count, 1);
  const parsed = await call('/api/import/parse', auth(alice.token, 'POST', data()));
  assert.notEqual(parsed.status, 403, 'legacy parser is gated but usable by a granted user');
  assert.equal(net.count, 2);
  assert.equal((await put(alice.token, 'revoke')).status, 200);
  const audit = db.rows('SELECT action, policy_version FROM ai_import_consent_events WHERE user_id = ? ORDER BY created_at, rowid', alice.id);
  assert.deepEqual(audit.map(x => x.action), ['grant','revoke','grant','revoke']);
  assert.ok(audit.every(x => x.policy_version === AI_IMPORT_POLICY_VERSION));
  assert.equal((await status(alice.token)).granted, false);
  // Previous app migrations: readable OFF status, but no grant and no OpenAI egress.
  const older = { ...env, DB: createD1({ migrationsUpTo: '0011_onboarding_eligibility.sql' }) };
  const legacy = await register('ai-legacy@example.test', older);
  assert.equal((await (await call('/api/privacy/ai-import', auth(legacy.token), older)).json()).granted, false);
  assert.equal((await call('/api/privacy/ai-import/consent', auth(legacy.token, 'POST', consent('grant')), older)).status, 503);
  assert.equal((await call('/api/import/jobs', auth(legacy.token, 'POST', data('legacy')), older)).status, 403);
  assert.equal(net.count, 2);

  // Actual deletion path with foreign_keys OFF: consent+audit must not remain orphaned.
  const noFk = createD1({ foreignKeys: false });
  const deletionEnv = { ...env, DB: noFk };
  const ex = await register('ai-remove@example.test', deletionEnv);
  assert.equal((await call('/api/privacy/ai-import/consent', auth(ex.token, 'POST', consent('grant')), deletionEnv)).status, 200);
  const deleted = await call('/api/auth/delete', auth(ex.token, 'POST', { confirm: 'DELETE', password: 'password123' }), deletionEnv);
  assert.equal(deleted.status, 200, 'account deletion succeeds with AI consent tables installed');
  assert.equal(noFk.rows('SELECT COUNT(*) AS n FROM ai_import_consents WHERE user_id = ?', ex.id)[0].n, 0);
  assert.equal(noFk.rows('SELECT COUNT(*) AS n FROM ai_import_consent_events WHERE user_id = ?', ex.id)[0].n, 0);
  console.log('B44 AI consent: authenticated default-OFF, versioned grant/revoke, legacy parse+jobs+retry+queue gate, account isolation, worker ownership, old schema deny, FK-OFF deletion PASS.');
} finally { globalThis.fetch = oldFetch; }
