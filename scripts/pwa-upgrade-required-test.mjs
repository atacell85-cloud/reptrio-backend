// B57-002 (Guardian r5 MAJOR-R5-1): the web app (PWA, schema 5) on an account at data level 3 (an exercise removed in the Build 57
// mobile app). The server refuses its reads and writes with SYNC_CLIENT_UPGRADE_REQUIRED. The web app must still start, keep its local
// data untouched, send nothing, and say why it cannot sync.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSyncService } from '../sync-service.js';

const calls = [];
let answer = () => ({ status: 409, body: { code: 'SYNC_CLIENT_UPGRADE_REQUIRED' } });
globalThis.fetch = async (url, options = {}) => {
  calls.push([url, options.method || 'GET']);
  const { status, body } = answer(url);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

function repository(local) {
  const log = [];
  return {
    log,
    setSyncHandler(handler) { log.push(['handler', Boolean(handler)]); },
    async getSyncMetadata() { return { dirty: true }; },
    async getData() { return local; },
    async replaceData(data) { log.push(['replace', data]); },
    async markSyncSucceeded() { log.push(['succeeded']); },
    async markSyncFailed(error) { log.push(['failed', error.code]); },
  };
}
const local = { programs: [{ id: 'p' }], sessions: [{ id: 's-local' }], draft: null, programBuilderDraft: null, importPreviews: {} };

// Start: no throw (the app does not show "Uygulama başlatılamadı"), local data never replaced, status says why.
{
  const statuses = []; const repo = repository(local);
  const sync = createSyncService(repo, status => statuses.push(status));
  await sync.start({ id: 'u' });
  assert.deepEqual(statuses, ['upgradeRequired']);
  assert.ok(!repo.log.some(([kind]) => kind === 'replace'), 'local data kept');
  // A later local edit is not sent (no request storm), the status stays.
  calls.length = 0;
  await sync.push({ schemaVersion: 5 });
  assert.deepEqual(calls, [], 'nothing sent while the account needs a newer app');
  assert.deepEqual(statuses.at(-1), 'upgradeRequired');
  // After sign-out and a start on an account that is readable again (another account), normal sync resumes.
  sync.stop();
  answer = url => url.endsWith('/pull') ? { status: 200, body: { data: null, syncVersion: 4 } } : { status: 200, body: { syncVersion: 5 } };
  await sync.start({ id: 'other' });
  assert.equal(statuses.at(-1), 'saved');
}
// Other errors keep their old behaviour (thrown to the caller as before).
{
  answer = () => ({ status: 503, body: { code: 'SYNC_STORAGE_UNAVAILABLE' } });
  const sync = createSyncService(repository(local));
  await assert.rejects(sync.start({ id: 'u' }), { code: 'SYNC_STORAGE_UNAVAILABLE' });
}
// A push refused with the upgrade code (account raised while this tab was open): marked failed (kept dirty), status, no further sends.
{
  answer = url => url.endsWith('/pull') ? { status: 200, body: { data: null, syncVersion: 1 } } : { status: 409, body: { code: 'SYNC_CLIENT_UPGRADE_REQUIRED' } };
  const statuses = []; const repo = repository(local);
  const sync = createSyncService(repo, status => statuses.push(status));
  await sync.start({ id: 'u' });
  await sync.push({ schemaVersion: 5 });
  assert.deepEqual(repo.log.filter(([kind]) => kind === 'failed'), [['failed', 'SYNC_CLIENT_UPGRADE_REQUIRED']]);
  assert.equal(statuses.at(-1), 'upgradeRequired');
  calls.length = 0;
  await sync.push({ schemaVersion: 5 });
  assert.deepEqual(calls, []);
}
// Account switch (Guardian r6 LOW): the flag never carries over — after stop/start on a readable account pushes are sent; and a late
// refusal of a push that account A started does not block account B.
{
  answer = url => url.endsWith('/pull') ? { status: 409, body: { code: 'SYNC_CLIENT_UPGRADE_REQUIRED' } } : { status: 200, body: { syncVersion: 2 } };
  const sync = createSyncService(repository(local));
  await sync.start({ id: 'A' });
  assert.equal(sync.isUpgradeRequired(), true);
  sync.stop();
  answer = url => url.endsWith('/pull') ? { status: 200, body: { data: null, syncVersion: 1 } } : { status: 200, body: { syncVersion: 2 } };
  await sync.start({ id: 'B' });
  assert.equal(sync.isUpgradeRequired(), false);
  calls.length = 0;
  await sync.push({ schemaVersion: 5 });
  assert.ok(calls.some(([url]) => url.endsWith('/push')), 'B syncs normally');
  // In-flight push of A, answered with the refusal after A signed out and B signed in.
  let release; const gate = new Promise(resolve => { release = resolve; });
  answer = url => url.endsWith('/pull') ? { status: 200, body: { data: null, syncVersion: 1 } } : { status: 409, body: { code: 'SYNC_CLIENT_UPGRADE_REQUIRED' } };
  const slow = globalThis.fetch;
  globalThis.fetch = async (url, options) => { if (url.endsWith('/push')) await gate; return slow(url, options); };
  const sync2 = createSyncService(repository(local));
  await sync2.start({ id: 'A' });
  const inFlight = sync2.push({ schemaVersion: 5 });
  sync2.stop(); await sync2.start({ id: 'B' });
  release(); await inFlight;
  globalThis.fetch = slow;
  assert.equal(sync2.isUpgradeRequired(), false, "A's late refusal does not block B");
}
// Delivery (Guardian r6 MAJOR-R6-1): the service worker serves the app shell cache-first, so the change only reaches returning users
// with a new cache version; the cached app.js entry is the one index.html loads; sync-service.js is in the shell.
{
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const version = sw.match(/const CACHE_VERSION = '([^']+)'/)[1];
  assert.notEqual(version, 'a2-workout-v66-english-youtube-2026-08-26', 'cache version bumped from the production one');
  const loaded = html.match(/src="(app\.js\?v=[^"]+)"/)[1];
  assert.ok(sw.includes(`'./${loaded}'`), 'the cached app.js is the one index.html loads');
  assert.ok(sw.includes("'./sync-service.js'"));
}
// Legacy data migration on a level-3 account: no false "transferred" message.
assert.ok(readFileSync(new URL('../app.js', import.meta.url), 'utf8').includes("toast(sync.isUpgradeRequired() ? 'Veriler bu cihazda kaydedildi;"), 'migrate message');
// The status text exists in the web app.
assert.ok(readFileSync(new URL('../app.js', import.meta.url), 'utf8').includes("upgradeRequired: 'Bu hesap Reptrio mobil uygulamasının yeni sürümüyle güncellendi"), 'status label');
console.log('PWA upgrade-required handling (B57-002) tests passed');
