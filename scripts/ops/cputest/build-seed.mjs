// Build 44 Cloudflare CPU test (runbook §4b): builds the seed for the ISOLATED test database `reptrio-cputest` (never the
// production `a2-workout-pilot`). Runs the real Worker locally on SQLite with the repository migrations, creates fake
// accounts through the real API (register, record push), makes them due for purge, adds a maintenance backlog, and
// writes data-only INSERTs to .tmp-cputest/seed.sql. A throwaway P-256 key (not an Apple credential; Apple rejects it
// with invalid_client) is written to .tmp-cputest/apple-test-key.p8 so the Apple step signs a real client-secret JWT
// and decrypts a sealed refresh token. No network access; nothing remote is touched.
// Usage: node scripts/ops/cputest/build-seed.mjs [--small]   (then follow runbook §5a/§5c). --small keeps the same code
// paths with less data (shared account-wide D1 Free write quota).
import { mkdirSync, writeFileSync } from 'node:fs';
import worker from '../../../worker/index.js';
import { createD1 } from '../../lib/d1-sqlite.mjs';
import { sealProviderToken, oauthConfig } from '../../../worker/account-api.js';

const OUT = new URL('../../../.tmp-cputest/', import.meta.url);
const SMALL = process.argv.includes('--small');
const size = (full, small) => SMALL ? small : full;
mkdirSync(OUT, { recursive: true });
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64');
const APPLE_KEY = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
const APPLE = { APPLE_OAUTH_CLIENT_ID: 'com.reptrio.cputest', APPLE_OAUTH_TEAM_ID: 'CPUTEST000', APPLE_OAUTH_KEY_ID: 'CPUTEST000', APPLE_OAUTH_PRIVATE_KEY: APPLE_KEY };
globalThis.fetch = async url => { throw new Error('seed builder makes no network calls: ' + url); };

const db = createD1();
const env = { DB: db, ...APPLE, ASSETS: { fetch: async () => new Response('') } };
const call = (path, token, payload) => worker.fetch(new Request('https://api.reptrio.com' + path, { method: 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify(payload) }), env, { waitUntil() {} });
const now = new Date().toISOString(), past = new Date(Date.now() - 86400000).toISOString();
const sessions = n => Array.from({ length: n }, (_, s) => ({ id: 'cpu-s' + s, title: 'S' + s, startedAt: past, sets: Object.fromEntries(Array.from({ length: 3 }, (_, e) => ['ex' + e, Object.fromEntries(Array.from({ length: 5 }, (_, k) => ['set' + k, { exerciseId: 'ex' + e, setNumber: k + 1, weight: '80', reps: '8', completed: true }]))])) }));

async function account(tag, { provider = 'email', sets = 0, stored = 0, returned = 0 }) {
  const r = await call('/api/auth/register', null, { email: `${tag}@cputest.invalid`, password: 'cputest-password-not-secret' });
  if (r.status !== 201) throw new Error(`register ${tag}: ${r.status}`);
  const u = await r.json(), id = u.user.id;
  if (sets) { const p = await call('/api/sync/push', u.sessionToken, { data: { schemaVersion: 8, programs: [{ id: 'p1', name: 'P', days: [] }], sessions: sessions(Math.ceil(sets / 15)) }, syncVersion: 0 }); if (p.status !== 200) throw new Error(`push ${tag}: ${p.status} ${await p.text()}`); }
  if (provider === 'apple') {
    const sub = 'apple-' + tag;
    db.raw.prepare('INSERT INTO oauth_accounts(provider,provider_subject,user_id,email,created_at,last_login_at) VALUES (?,?,?,?,?,?)').run('apple', sub, id, `${tag}@cputest.invalid`, now, now);
    db.raw.prepare('UPDATE oauth_accounts SET refresh_token_ciphertext=? WHERE provider=? AND provider_subject=?').run(await sealProviderToken(oauthConfig(env, 'apple'), 'apple', sub, 'cputest-refresh-' + tag), 'apple', sub);
    db.raw.prepare("UPDATE users SET credential_origin='APPLE' WHERE id=?").run(id);
  }
  // Fake response ids: with a real OPENAI_API_KEY each DELETE answers 404 (already absent) = confirmed, so all 40 run.
  for (let i = 0; i < stored; i++) {
    db.raw.prepare("INSERT INTO import_jobs(id,user_id,status,source_json,normalized_document_json,attempts,created_at,updated_at,openai_response_id) VALUES (?,?,'done','{}','{}',1,?,?,?)").run(`${tag}-j${i}`, id, now, now, `resp_cputest_${tag}_${i}`);
    db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id) VALUES (?,?,'RESOLVED',?,?,?)").run(`${tag}-w${i}`, id, now, now, `resp_cputest_${tag}_${i}`);
  }
  // Ledger rows already RETURNED (adopted earlier): exercises upstream steps without the adoption batch.
  for (let i = 0; i < returned; i++) db.raw.prepare("INSERT INTO account_lifecycle_work(id,user_id,state,created_at,expires_at,response_id,import_job_id) VALUES (?,?,'RETURNED',?,?,?,?)").run(`${tag}-r${i}`, id, now, now, `resp_cputest_${tag}_r${i}`, `${tag}-jr${i}`);
  return id;
}

// A: heaviest final erase without external calls (record-sync data). B: upstream steps from 60 stored ids (adoption
// first). B2: upstream steps from 30 already-adopted ledger rows. C: Apple revoke (JWT sign + token decrypt + 1 fetch).
// D: idle bystander that must survive.
const ids = {
  finalErase: await account('cpu-final', { sets: size(300, 150) }),
  upstream: await account('cpu-upstream', { sets: 30, stored: size(60, 30) }),
  upstreamLedger: await account('cpu-ledger', { sets: 30, returned: size(30, 20) }),
  apple: await account('cpu-apple', { provider: 'apple', sets: 30 }),
  bystander: await account('cpu-bystander', { sets: 30 }),
};
for (const id of [ids.finalErase, ids.upstream, ids.upstreamLedger, ids.apple]) db.raw.prepare("UPDATE users SET account_status='PENDING_DELETION',purge_at=? WHERE id=?").run(past, id);

// 15-minute maintenance backlog: expired receipts and abandoned restores with payload (bounded by the maintenance cap).
db.raw.exec('BEGIN');
const receipt = db.raw.prepare("INSERT INTO sync_mutation_receipts VALUES(?,?,'h','p',0,1,'{}',?,?)");
for (let i = 0; i < size(1000, 300); i++) receipt.run(ids.bystander, 'cpu-rcpt-' + i, past, past);
const op = db.raw.prepare("INSERT INTO personal_restore_operations(user_id,operation_id,purpose,source_namespace,archive_retry_hash,local_binding,data_schema_version,expected_chunks,expected_counts_json,base_revision,state,expires_at,created_at,updated_at) VALUES (?,?,'RESTORE','n','h','b',8,1,'{}',0,'EXPIRED',?,?,?)");
const root = db.raw.prepare("INSERT INTO personal_restore_roots(user_id,operation_id,root_id,root_kind,source_tuple,source_ordinal,portable_hash,counts_json) VALUES (?,?,0,'session','t',0,'h','{}')");
const record = db.raw.prepare("INSERT INTO personal_restore_records(user_id,operation_id,root_id,item_ordinal,kind,record_key,ordinal,address_json,payload_json,source_tuple,portable_hash) VALUES (?,?,0,?,'set',?,?,'{}','{}',?,'h')");
for (let o = 0; o < size(50, 15); o++) { op.run(ids.bystander, 'cpu-op' + o, past, past, past); root.run(ids.bystander, 'cpu-op' + o); for (let r = 0; r < 20; r++) record.run(ids.bystander, 'cpu-op' + o, r, 'k' + r, r, 't' + r); }
db.raw.exec('COMMIT');

// Data-only INSERTs in creation order (parents first), excluding the migration ledger and SQLite internals.
const quote = v => v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const lines = [];
let total = 0;
for (const { name } of db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'d1_migrations' ORDER BY rowid")) {
  const rows = db.rows(`SELECT * FROM "${name}"`); total += rows.length;
  for (const row of rows) lines.push(`INSERT INTO "${name}"(${Object.keys(row).map(c => `"${c}"`).join(',')}) VALUES (${Object.values(row).map(quote).join(',')});`);
}
writeFileSync(new URL('seed.sql', OUT), lines.join('\n') + '\n');
writeFileSync(new URL('apple-test-key.p8', OUT), APPLE_KEY + '\n', { mode: 0o600 });
writeFileSync(new URL('accounts.json', OUT), JSON.stringify(ids, null, 1) + '\n');
console.log(JSON.stringify({ seedRows: total, statements: lines.length, accounts: ids, out: OUT.pathname }, null, 1));
