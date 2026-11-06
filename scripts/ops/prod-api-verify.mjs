#!/usr/bin/env node
// Reptrio production API verification with two permanent test accounts (Build 52+).
//
//   node scripts/ops/prod-api-verify.mjs verify                 # every build: no prompts, no account creation
//   node scripts/ops/prod-api-verify.mjs setup-reset --account A # one time: set a known password via the official reset mail
//   node scripts/ops/prod-api-verify.mjs setup-register --account B  # one time: create B, then the same reset step
//
// Secrets: passwords are read from the macOS Keychain (`security`, service from the accounts file, account = email) and the
// session token stays in memory. Nothing secret is printed or written. The report holds statuses and error codes only.
// Safety: base URL is production or a loopback dev Worker; every authenticated step checks /api/me against the pinned userId;
// account A is the only one that ever receives a personal card; B is never sent a card and writes with data level 1 only.
// Test cards are removed through the official sync path (tombstone, then release from the array); accounts are kept.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const ACCOUNTS_FILE = resolve(args.accounts || join(HERE, 'prod-api-test-accounts.json'));
const config = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
const BASE = String(args.base || config.baseUrl).replace(/\/$/, '');
const PRODUCTION = BASE === 'https://api.reptrio.com';
if (!PRODUCTION && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) die(`refused base URL ${BASE} (production or loopback only)`);
const CARD_PREFIX = 'Reptrio API test';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
let results_block = () => {};
const devStore = new Map();   // loopback dev Worker only: stands in for the Keychain


// ---------- verification ----------
async function verify() {
  const results = []; const startedAt = new Date().toISOString();
  const check = (id, step, res, expected, ok, note = '') => {
    results.push({ id, step, method: res?.method, path: res?.path, expected, status: res?.status ?? null, code: res?.body?.code ?? null, result: ok ? 'PASS' : 'FAIL', note, at: res?.at || new Date().toISOString() });
    log(`${ok ? 'PASS' : 'FAIL'} ${id} ${step} -> ${res?.status ?? '-'} ${res?.body?.code ?? ''} ${note}`);
    return ok;
  };
  const block = results_block = (id, step, why) => { results.push({ id, step, expected: '-', status: null, code: null, result: 'BLOCKED', note: why, at: new Date().toISOString() }); log(`BLOCKED ${id} ${step}: ${why}`); };
  const sessions = []; let a1 = null; let liveCardId = null;
  try {
    // 0. Unauthenticated contract (no writes).
    const fake = randomBytes(32).toString('base64url').slice(0, 43);
    for (const [id, method, path, extra, exp, code] of [
      ['U1', 'GET', '/api/health', {}, 200], ['U2', 'GET', '/api/auth/providers', {}, 200],
      ['U3', 'GET', '/api/sync/capabilities', {}, 401, 'AUTH_REQUIRED'], ['U4', 'GET', '/api/sync/capabilities', { token: fake }, 401, 'AUTH_REQUIRED'],
      ['U5', 'GET', '/api/sync/pull', {}, 401, 'AUTH_REQUIRED'], ['U6', 'POST', '/api/sync/push', { json: {} }, 401, 'AUTH_REQUIRED'],
      ['U7', 'POST', '/api/sync/push', { json: {}, headers: { Origin: 'https://evil.example' } }, 403, 'AUTH_ORIGIN_INVALID'],
      ['U8', 'POST', '/api/sync/push', { raw: '{}', headers: { 'Content-Type': 'text/plain' } }, 415, 'UNSUPPORTED_CONTENT_TYPE'],
      ['U9', 'POST', '/api/backup/restore/operations', { json: {} }, 401, 'AUTH_REQUIRED'],
      ['U10', 'GET', '/api/auth/delete', {}, 401, 'AUTH_REQUIRED'],
      ['U11', 'GET', '/api/sync/push', {}, 405, 'METHOD_NOT_ALLOWED'],
    ]) { const r = await http(method, path, extra); check(id, 'unauthenticated contract', r, `${exp}${code ? ' ' + code : ''}`, r.status === exp && (!code || r.body?.code === code)); }

    // 1. Sign in A (two client sessions) and B; every session is pinned to the expected user id.
    a1 = await signIn('A', check, 'A1'); if (!a1) throw stop('A sign-in failed');
    sessions.push(a1);
    const a2 = await signIn('A', check, 'A2'); if (a2) sessions.push(a2);
    const b = config.accounts.B.userId ? await signIn('B', check, 'B1') : null; if (b) sessions.push(b);
    if (!config.accounts.B.userId) block('B1', 'sign in B', 'B is not set up yet (run setup-register --account B)');

    // 2. Capabilities (authenticated).
    const cap = await http('GET', '/api/sync/capabilities', { token: a1.token });
    const versions = cap.body?.personalBackupVersions;
    check('C1', 'capabilities A', cap, '200 personalExercises=1, personalBackupVersions [1,2,3]', cap.status === 200 && cap.body?.personalExercises === 1 && JSON.stringify(versions) === '[1,2,3]' && cap.body?.writable === true, `versions=${JSON.stringify(versions)}`);

    // 3. Card CRUD on A.
    let pulled = await pull(a1, 2); check('S1', 'pull A (level 2)', pulled, '200', pulled.status === 200);
    if (pulled.status !== 200) throw stop('A pull failed');
    let cards = cardsOf(pulled);
    const foreign = cards.filter(card => !String(card?.name || '').startsWith(CARD_PREFIX));
    if (foreign.length) throw stop(`A holds ${foreign.length} non-test card(s); refusing to modify`);
    // Leftover test cards from an interrupted run: tombstone + release them first (official sync path).
    if (cards.length) { await cleanup(a1, check, 'P0'); pulled = await pull(a1, 2); cards = cardsOf(pulled); }

    const now = new Date().toISOString(); liveCardId = `custom:card:${randomUUID()}`;
    const card = { id: liveCardId, v: 1, name: `${CARD_PREFIX} ${now.slice(0, 16)}`, primaryMuscle: 'chest', assistingMuscles: ['triceps'], equipment: 'barbell',
      description: 'Automated production API verification card.', legacyCustomIds: [], catalogMatch: null, createdAt: now, updatedAt: now, rev: 0, deletedAt: null, displaced: [] };
    let r = await push(a1, withCards(pulled, [...cards, card]), pulled.body.syncVersion, 2);
    check('K1', 'create card (push, level 2)', r, '200 syncVersion+1', r.status === 200 && r.body?.syncVersion === pulled.body.syncVersion + 1);

    const read2 = a2 ? await pull(a2, 2) : null;
    if (a2) check('K2', 'read card from second client session', read2, '200, card equal field by field', read2.status === 200 && same(findCard(read2, card.id), card));
    else block('K2', 'second client session', 'second sign-in failed');

    pulled = await pull(a1, 2);
    const updated = { ...findCard(pulled, card.id), name: `${card.name} (updated)`, description: 'Updated by verification.', rev: card.rev + 1, updatedAt: new Date().toISOString() };
    r = await push(a1, withCards(pulled, cardsOf(pulled).map(item => item.id === card.id ? updated : item)), pulled.body.syncVersion, 2);
    check('K3', 'update card (name, description, rev+1)', r, '200', r.status === 200);
    const read3 = await pull(a2 || a1, 2);
    check('K4', 'read update from other session', read3, '200, updated fields', read3.status === 200 && same(findCard(read3, card.id), updated));

    // 4. Old clients against the level-2 account: writes refused, nothing changes, pull still allowed.
    const before = await pull(a1, 2);
    for (const [id, level] of [['O1', 1], ['O2', null]]) {
      r = await push(a1, withCards(before, cardsOf(before)), before.body.syncVersion, level);
      check(id, `old client push (data level ${level ?? 'absent'})`, r, '409 SYNC_CLIENT_UPGRADE_REQUIRED', r.status === 409 && r.body?.code === 'SYNC_CLIENT_UPGRADE_REQUIRED');
    }
    r = await http('POST', '/api/backup/restore/operations', { token: a1.token, json: {}, headers: { 'X-Reptrio-Data-Level': '1' } });
    check('O3', 'old client restore start (data level 1)', r, '409 SYNC_CLIENT_UPGRADE_REQUIRED', r.status === 409 && r.body?.code === 'SYNC_CLIENT_UPGRADE_REQUIRED');
    const oldPull = await pull(a1, 1);
    check('O4', 'old client pull (data level 1) still allowed', oldPull, '200', oldPull.status === 200);
    const after = await pull(a1, 2);
    check('O5', 'refused writes changed nothing', after, '200, same syncVersion and card', after.status === 200 && after.body.syncVersion === before.body.syncVersion && same(findCard(after, card.id), updated));

    // 5. Isolation and level-1 compatibility on B (B never receives a card).
    if (b) {
      const bp = await pull(b, 1);
      check('I1', 'B pull (data level 1)', bp, '200, no A card', bp.status === 200 && !JSON.stringify(bp.body?.data ?? null).includes(card.id));
      const bc = cardsOf(bp);
      if (bc.length) block('L1', 'B level-1 write', `B unexpectedly holds ${bc.length} card(s); not writing`);
      else {
        const data = bp.body?.data && typeof bp.body.data === 'object' ? bp.body.data : { schemaVersion: 8, programs: [], sessions: [], measurements: [] };
        r = await push(b, data, bp.body.syncVersion, 1);
        check('L1', 'B push without cards (data level 1)', r, '200 (account stays below level 2)', r.status === 200);
      }
      const cross = await pull(b, 2);
      check('I2', 'B pull after A writes: no A card', cross, '200, no A card', cross.status === 200 && !JSON.stringify(cross.body?.data ?? null).includes(card.id));
    } else block('I1', 'isolation with B', 'B not set up');
    const anon = await http('GET', '/api/sync/pull');
    check('I3', 'no session cannot read', anon, '401 AUTH_REQUIRED', anon.status === 401 && anon.body?.code === 'AUTH_REQUIRED');

    // 6. Official cleanup: tombstone, then release; the card must not come back.
    const present = await pull(a1, 2);
    check('D0', 'card present before delete', present, '200, this run\'s card live', present.status === 200 && !!findCard(present, card.id) && !findCard(present, card.id).deletedAt);
    if (await cleanup(a1, check, 'D')) liveCardId = null;
    const final = await pull(a2 || a1, 2);
    check('D3', 'card absent after re-sync', final, '200, card absent', final.status === 200 && !findCard(final, card.id));
  } catch (cause) {
    block('X', 'run stopped', cause.stopReason || cause.message);
    if (a1 && liveCardId) { try { await cleanup(a1, check, 'R'); } catch { block('RL', 'LEFTOVER CARD', 'cleanup after failure threw; rerun verify (its first step removes test cards)'); } }
  } finally {
    for (const s of sessions) { const r = await http('POST', '/api/auth/logout', { token: s.token, json: {} }); check(`Z-${s.label}`, `logout ${s.label}`, r, '200', r.status === 200); }
  }
  const counts = results.reduce((acc, item) => ({ ...acc, [item.result]: (acc[item.result] || 0) + 1 }), {});
  const verified = !counts.FAIL && !counts.BLOCKED;
  const report = { base: BASE, startedAt, finishedAt: new Date().toISOString(), counts, verdict: verified ? (PRODUCTION ? 'PRODUCTION API VERIFIED' : 'LOCAL WORKER VERIFIED (not production evidence)') : 'NOT VERIFIED', results };
  const out = resolve(args.out || `prod-api-verify-${startedAt.replace(/[:.]/g, '-')}`); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'result.md'), markdown(report));
  log(`\n${report.verdict} — ${JSON.stringify(counts)} — report: ${out}`);
  process.exitCode = verified ? 0 : 1;
}

// Removes every test-prefixed card through the official sync path (tombstone, then release from the array). Each step re-pulls
// and retries on SYNC_CONFLICT (a real app session on A may sync concurrently). Afterwards it confirms that no live test card
// is left; if one is, it records BLOCKED "LEFTOVER CARD" so the run can never be reported as verified.
async function cleanup(session, check, prefix) {
  const isTest = card => String(card?.name || '').startsWith(CARD_PREFIX);
  const step = async (n, label, transform) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const p = await pull(session, 2); if (p.status !== 200) { check(`${prefix}${n}`, label, p, '200', false, 'pull failed'); return false; }
      const cards = cardsOf(p); const next = transform(cards);
      if (next === null) return true;   // nothing to do for this step
      const r = await push(session, withCards(p, next), p.body.syncVersion, 2);
      if (r.status === 409 && r.body?.code === 'SYNC_CONFLICT' && attempt < 5) continue;
      check(`${prefix}${n}`, label, r, '200', r.status === 200, attempt > 1 ? `after ${attempt - 1} SYNC_CONFLICT retr${attempt > 2 ? 'ies' : 'y'}` : '');
      return r.status === 200;
    }
    return false;
  };
  const stamp = () => new Date().toISOString();
  await step(1, 'delete card: tombstone via sync', cards => cards.some(card => isTest(card) && !card.deletedAt)
    ? cards.map(card => isTest(card) && !card.deletedAt ? { ...card, deletedAt: stamp(), updatedAt: stamp(), rev: card.rev + 1 } : card) : null);
  await step(2, 'release tombstone from array via sync', cards => cards.some(card => isTest(card) && card.deletedAt)
    ? cards.filter(card => !(isTest(card) && card.deletedAt)) : null);
  const final = await pull(session, 2);
  const live = cardsOf(final).filter(card => isTest(card) && !card.deletedAt).length;
  if (final.status !== 200 || live) {
    results_block(`${prefix}L`, 'LEFTOVER CARD', final.status !== 200 ? `could not confirm cleanup (pull ${final.status})` : `${live} live test card(s) remain on A; rerun verify (its first step removes them)`);
    return false;
  }
  return true;
}

// ---------- one-time setup (interactive; local terminal only) ----------
async function setup(key, register) {
  const acc = config.accounts[key]; const email = acc.email;
  if (register) {
    if (!PRODUCTION && !args.accounts) die('loopback setup-register needs --accounts <copy>; the default accounts file is production-only');
    if (!PRODUCTION && process.env.REPTRIO_TEST_DEV_STORE !== '1') die('loopback setup needs REPTRIO_TEST_DEV_STORE=1 (never writes the Keychain)');
    if (acc.userId) die(`${key} already pinned (${acc.userId.slice(0, 8)}…); not creating again. Use setup-reset if the password is unknown.`);
    const password = randomBytes(24).toString('base64url');
    const r = await http('POST', '/api/auth/register', { json: { email, password }, headers: { 'X-Reptrio-Client': 'mobile' } });
    if (r.status === 409 && r.body?.code === 'AUTH_EMAIL_IN_USE') die(`${key}: an account already exists for this address; not creating. Pin its id and run setup-reset.`);
    if (r.status !== 201 || !r.body?.user?.id) die(`${key}: register returned ${r.status} ${r.body?.code || ''}`);
    await keychainStore(email, password);
    acc.userId = r.body.user.id; writeFileSync(ACCOUNTS_FILE, JSON.stringify(config, null, 2) + '\n');
    log(`${key}: created and pinned ${acc.userId.slice(0, 8)}…; password stored in Keychain. Proving the mailbox with a reset next.`);
    if (r.body.sessionToken) await http('POST', '/api/auth/logout', { token: r.body.sessionToken, json: {} });
  }
  if (!acc.userId) die(`${key} has no pinned userId`);
  const f = await http('POST', '/api/auth/password/forgot', { json: { email } });
  if (f.status !== 202) die(`${key}: forgot returned ${f.status} ${f.body?.code || ''}`);
  log(`${key}: reset mail requested (202). Open the Zoho test mailbox and copy the link from the newest Reptrio mail.`);
  const pasted = await hiddenPrompt('Paste the reset link or token (input hidden): ');
  const token = (pasted.match(/token=([A-Za-z0-9_-]{43})/) || [null, pasted.trim()])[1];
  if (!TOKEN_RE.test(token)) die('that is not a reset link/token');
  const password = randomBytes(24).toString('base64url');
  const r = await http('POST', '/api/auth/password/reset', { json: { token, password } });
  if (r.status !== 200) die(`${key}: reset returned ${r.status} ${r.body?.code || ''} (password unchanged; request a new link)`);
  await keychainStore(email, password);
  const s = await signIn(key, (id, step, res, exp, ok) => ok);
  if (!s) die(`${key}: sign-in with the new password failed`);
  await http('POST', '/api/auth/logout', { token: s.token, json: {} });
  log(`${key}: mailbox proven, password reset and stored in Keychain, sign-in pinned to ${acc.userId.slice(0, 8)}… OK.`);
}

// ---------- helpers ----------
async function signIn(key, check, id = `S-${key}`) {
  const acc = config.accounts[key];
  const password = readPassword(key, acc.email);
  if (!password) { check(id, `sign in ${key}`, null, '201', false, 'no password in secret store'); return null; }
  const r = await http('POST', '/api/auth/login', { json: { email: acc.email, password }, headers: { 'X-Reptrio-Client': 'mobile' } });
  const token = r.body?.sessionToken; if (r.body) delete r.body.sessionToken;
  const pinned = r.status === 201 && token && r.body?.user?.id === acc.userId;
  check(id, `sign in ${key} (pinned id)`, r, '201, user id == pinned', !!pinned);
  if (!pinned) { if (token) await http('POST', '/api/auth/logout', { token, json: {} }); return null; }
  const me = await http('GET', '/api/me', { token });
  if (me.body?.user?.id !== acc.userId) { await http('POST', '/api/auth/logout', { token, json: {} }); return null; }
  return { label: id, key, token };
}
function readPassword(key, email) {
  if (!PRODUCTION && devStore.has(email)) return devStore.get(email);
  if (!PRODUCTION && process.env[`REPTRIO_TEST_PASSWORD_${key}`]) return process.env[`REPTRIO_TEST_PASSWORD_${key}`];   // loopback dev Worker only
  if (!PRODUCTION) return null;   // a loopback run never reads production passwords from the Keychain
  try { return execFileSync('security', ['find-generic-password', '-s', config.keychainService, '-a', email, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}
function keychainStore(email, password) {
  if (!PRODUCTION && process.env.REPTRIO_TEST_DEV_STORE === '1') { devStore.set(email, password); return; }   // loopback dev Worker only
  if (!PRODUCTION) return Promise.reject(new Error('loopback setup needs REPTRIO_TEST_DEV_STORE=1 (never writes the Keychain)'));
  // `security -i` reads the command from stdin, so the password never appears in a process argument list.
  return new Promise((ok, fail) => {
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', fail); child.on('exit', code => code === 0 ? ok() : fail(new Error(`keychain write failed (${code})`)));
    child.stdin.end(`add-generic-password -U -s "${config.keychainService}" -a "${email}" -l "Reptrio production API test ${email}" -w "${password}"\n`);
  });
}
async function http(method, path, { token, json, raw, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
  const at = new Date().toISOString();
  try {
    const response = await fetch(BASE + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : raw, signal: AbortSignal.timeout(20000) });
    const text = await response.text(); let body = null; try { body = JSON.parse(text); } catch { body = null; }
    return { method, path, status: response.status, body, at };
  } catch (cause) { return { method, path, status: null, body: { code: `NETWORK:${cause.name}` }, at }; }
}
const pull = (s, level) => http('GET', '/api/sync/pull', { token: s.token, headers: level ? { 'X-Reptrio-Client': 'mobile', 'X-Reptrio-Data-Level': String(level) } : {} });
const push = (s, data, syncVersion, level) => http('POST', '/api/sync/push', { token: s.token, json: { data, syncVersion }, headers: { 'X-Reptrio-Client': 'mobile', ...(level ? { 'X-Reptrio-Data-Level': String(level) } : {}) } });
const cardsOf = p => Array.isArray(p?.body?.data?.personalExercises) ? p.body.data.personalExercises : [];
const findCard = (p, id) => cardsOf(p).find(card => card?.id === id) || null;
function withCards(p, cards) { const base = p?.body?.data && typeof p.body.data === 'object' ? p.body.data : { schemaVersion: 8, programs: [], sessions: [], measurements: [] }; return { ...base, personalExercises: cards }; }
const same = (x, y) => !!x && !!y && JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y));
function sortKeys(v) { return Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v; }
function account(key) { if (!config.accounts[key]) die('--account A|B required'); return key; }
function stop(reason) { return Object.assign(new Error(reason), { stopReason: reason }); }
function markdown(r) {
  const rows = r.results.map(x => `| ${x.id} | ${x.at.slice(11, 19)} | ${x.method || '-'} | ${x.path || '-'} | ${x.step} | ${x.expected} | ${x.status ?? '-'} | ${x.code ?? '-'} | ${x.result} | ${String(x.note || '').replace(/\|/g, '/')} |`);
  return [`# Production API verification (${r.base})`, '', `${r.startedAt} → ${r.finishedAt}`, '', `**${r.verdict}** — ${JSON.stringify(r.counts)}`, '',
    '| # | UTC | Method | Path | Step | Expected | HTTP | code | Result | Note |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
}
function hiddenPrompt(question) {
  return new Promise(done => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(question); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); done(answer); });
  });
}
function parseArgs(list) { const out = { _: [] }; for (let i = 0; i < list.length; i++) { if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') || list[i + 1] === undefined ? true : list[++i]; else out._.push(list[i]); } return out; }
function log(line) { process.stdout.write(line + '\n'); }
function die(message) { process.stderr.write(`prod-api-verify: ${message}\n`); process.exit(2); }

// ---------- entry (last, after every helper is initialised) ----------
const command = args._[0];
if (command === 'verify') await verify();
else if (command === 'setup-reset') await setup(account(args.account), false);
else if (command === 'setup-register') await setup(account(args.account), true);
else die('usage: prod-api-verify.mjs verify | setup-reset --account A|B | setup-register --account B  [--base URL] [--out DIR] [--accounts FILE]');
