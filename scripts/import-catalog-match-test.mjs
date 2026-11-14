// B57-007: import catalog matching. Pure pipeline (exact step, allowlist, deterministic guards, one batched call, technical
// failures) + the routed endpoint over real SQLite (auth, same origin, consent, ownership, readiness, catalog revision,
// idempotent cache, failure leaves the preview untouched, nothing stored upstream). The model is a local fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { createD1 } from './lib/d1-sqlite.mjs';
import {
  IMPORT_MATCH_CATALOG, catalogEquipment, catalogIndex, exactKey, guardRefusal, matchImportPreview, matchPrompt, matchRequestBody,
  previewNames, validateModelRow,
} from '../worker/import-catalog-match.js';

const POLICY = 'ai_import_openai_document_v1';
const ref = { page: null, sheet: null, cellRange: null, text: null };
const rx = { sets: 3, setsText: '3', repsMin: 10, repsMax: 10, repsText: '10' };
const ex = (name, extra = {}) => ({ itemType: 'exercise', order: 1, sourceExerciseName: name, normalizedExerciseName: name, exerciseMatch: null, notes: null, sourceReference: ref, prescription: rx, ...extra });
const previewOf = (...days) => ({ schemaVersion: '1.1', importId: 'x', importedAt: '2026-11-14T00:00:00.000Z', source: { fileName: 'r.pdf', fileType: 'pdf', language: 'tr', documentTitle: null },
  program: { id: null, name: 'Fixture', description: null, sourceType: 'pdf-import', notes: null, days: days.map((items, i) => ({ name: `Gün ${i + 1}`, order: i + 1, notes: null, sourceReference: ref, sections: [{ title: 'Ana Antrenman', sectionType: 'strength', order: 1, notes: null, sourceReference: ref, items }] })) },
  warnings: [], unparsedContent: [] });
const reply = rows => ({ payload: { model: 'gpt-4.1-mini-fixture', output_text: JSON.stringify({ results: rows }), usage: { input_tokens: 5000, output_tokens: 300, input_tokens_details: { cached_tokens: 4096 } } } });
const row = (index, patch = {}) => ({ index, understood: true, interpretation: '', sourceEquipment: 'unspecified', sourceQualifiers: [], sameExerciseId: null, suggestionIds: [], ...patch });

// ---- Catalog file: the byte-identical copy of the app's data/import-match-catalog.v1.json (302 active ids).
assert.equal(IMPORT_MATCH_CATALOG.count, 302);
assert.equal(IMPORT_MATCH_CATALOG.exercises.length, 302);
assert.ok(IMPORT_MATCH_CATALOG.exercises.every(e => /^ex_\d{6}$/.test(e.id)));
assert.match(IMPORT_MATCH_CATALOG.revision, /^wg-1\.0\.0\+[0-9a-f]{12}$/);
const index = catalogIndex();

// ---- Distinct names: the same exercise on several days is matched once; empty names are never invented.
{
  const names = previewNames(previewOf([ex('Bench Press'), ex('  bench   press ')], [ex('BENCH PRESS'), ex(''), ex('Squat')]));
  assert.deepEqual(names.map(n => n.sourceName), ['Bench Press', 'Squat']);
}

// ---- Exact step: unique id / English name / curated alias, no model call.
{
  let calls = 0;
  const result = await matchImportPreview({ preview: previewOf([ex('Bench Press'), ex('lat pull down'), ex('RDL'), ex('Hip Add')]), model: 'm', requestId: 'r', callModel: async () => { calls++; } });
  assert.equal(calls, 0, 'all exact: no model call');
  assert.deepEqual(result.results.map(r => [r.status, r.method, r.exerciseId]), [['matched', 'exact', 'ex_000038'], ['matched', 'exact', 'ex_000166'], ['matched', 'exact', 'ex_000215'], ['matched', 'exact', 'ex_000142']]);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.catalogRevision, IMPORT_MATCH_CATALOG.revision);
}

// ---- One batched model call for the remaining names; the model resolves language/spelling; ids are allowlisted.
{
  const bodies = [];
  const preview = previewOf([ex('Dumbell Bench'), ex('Şınav'), ex('Bench Press')], [ex('Dumbell Bench'), ex('asf@@ 2!!'), ex('Pendulum squat'), ex('Fake id move')]);
  const result = await matchImportPreview({ preview, model: 'm', requestId: 'req-1', callModel: async body => {
    bodies.push(body);
    const names = JSON.parse(body.input[1].content[0].text).names.map(n => n.name);
    assert.deepEqual(names, ['Dumbell Bench', 'Şınav', 'asf@@ 2!!', 'Pendulum squat', 'Fake id move'], 'only non-exact distinct names are sent');
    return reply([
      row(0, { sameExerciseId: 'ex_000095', sourceEquipment: 'dumbbell' }),
      row(1, { sameExerciseId: 'ex_000205' }),
      row(2, { understood: false }),
      row(3, { suggestionIds: ['ex_000128', 'ex_999999', 'ex_000128', 'ex_000254', 'ex_000172', 'ex_000036'] }),
      row(4, { sameExerciseId: 'ex_999999', suggestionIds: ['not-an-id'] }),
    ]);
  } });
  assert.equal(bodies.length, 1, 'one call per import');
  const by = Object.fromEntries(result.results.map(r => [r.sourceName, r]));
  assert.deepEqual([by['Dumbell Bench'].status, by['Dumbell Bench'].exerciseId, by['Dumbell Bench'].method], ['matched', 'ex_000095', 'ai']);
  assert.equal(by['Şınav'].exerciseId, 'ex_000205');
  assert.deepEqual([by['asf@@ 2!!'].status, by['asf@@ 2!!'].understood, by['asf@@ 2!!'].suggestions], ['personal', false, []]);
  assert.deepEqual([by['Pendulum squat'].status, by['Pendulum squat'].suggestions], ['suggested', ['ex_000128', 'ex_000254', 'ex_000172']], 'deduped, allowlisted, at most 3');
  assert.deepEqual([by['Fake id move'].status, by['Fake id move'].exerciseId, by['Fake id move'].guard], ['personal', null, 'unknownId'], 'an invented id is never accepted');
  assert.deepEqual(result.summary, { names: 6, exact: 1, matched: 3, suggested: 1, personal: 2 });
  assert.deepEqual(result.usage, { inputTokens: 5000, cachedInputTokens: 4096, outputTokens: 300 });
}

// ---- Deterministic guards turn a wrong automatic match into a suggestion (never "not understood").
{
  const entry = { key: 'k', sourceName: 'x' };
  const barbellCurl = validateModelRow(index, entry, row(0, { sameExerciseId: 'ex_000040', sourceEquipment: 'barbell' }));
  assert.deepEqual([barbellCurl.status, barbellCurl.guard, barbellCurl.suggestions[0], barbellCurl.understood], ['suggested', 'equipment', 'ex_000040', true]);
  const inclineFly = validateModelRow(index, entry, row(0, { sameExerciseId: 'ex_000098', sourceQualifiers: ['incline'] }));
  assert.deepEqual([inclineFly.status, inclineFly.guard], ['suggested', 'variant'], 'incline in the source, flat target');
  const flatToIncline = validateModelRow(index, entry, row(0, { sameExerciseId: 'ex_000151' }));
  assert.deepEqual([flatToIncline.status, flatToIncline.guard], ['suggested', 'variant'], 'incline target, no incline in the source');
  const singleArm = validateModelRow(index, entry, row(0, { sameExerciseId: 'ex_000166', sourceQualifiers: ['single_arm'] }));
  assert.equal(singleArm.guard, 'variant');
  const machineHip = validateModelRow(index, entry, row(0, { sameExerciseId: 'ex_000144', sourceEquipment: 'machine' }));
  assert.equal(machineHip.guard, 'equipment');
  assert.equal(guardRefusal(index.byId.get('ex_000254'), 'smith_machine', []), null, 'smith machine squat accepts smith');
  assert.equal(guardRefusal(index.byId.get('ex_000278'), 'trap_bar', []), null);
  assert.equal(guardRefusal(index.byId.get('ex_000111'), 'barbell', []), 'equipment', 'EZ-bar curl is not a straight barbell curl');
  assert.equal(guardRefusal(index.byId.get('ex_000188'), 'dumbbell', ['single_arm']), null);
  assert.equal(guardRefusal(index.byId.get('ex_000218'), 'machine', []), null, 'rowing machine = Rowing (cardio)');
  assert.deepEqual([...catalogEquipment(index.byId.get('ex_000203'))].sort(), ['bodyweight', 'pull_up_bar']);
  const ok = validateModelRow(index, entry, row(0, { sameExerciseId: 'ex_000151', sourceEquipment: 'dumbbell', sourceQualifiers: ['incline'] }));
  assert.deepEqual([ok.status, ok.exerciseId], ['matched', 'ex_000151']);
}

// ---- The source text itself is parsed (TR/EN), so a model that under-reports attributes cannot auto-match a variant.
{
  const silent = (id, name) => validateModelRow(index, { key: 'k', sourceName: name }, row(0, { sameExerciseId: id }));
  for (const [name, id] of [['Incline DB press', 'ex_000095'], ['Neutral grip lat pulldown', 'ex_000166'], ['Sumo deadlift', 'ex_000081'],
    ['Dumbbell shoulder press', 'ex_000225'], ['Ters eğimli bench', 'ex_000148'], ['Barbell curl', 'ex_000040'], ['Pendulum squat', 'ex_000128'],
    ['Z press', 'ex_000189'], ['Önden lat çekiş', 'ex_000166'], ['Tek kol kablo lateral raise', 'ex_000052'], ['Makinede hip thrust', 'ex_000144']]) {
    const r = silent(id, name);
    assert.equal(r.status, 'suggested', `${name} must not auto-match ${id}`);
    assert.equal(r.suggestions[0], id);
  }
  for (const [name, id] of [['Incline DB press', 'ex_000151'], ['Ters tutuş barfiks', 'ex_000066'], ['Chin up', 'ex_000066'], ['Kablo ile oturarak row', 'ex_000229'],
    ['Yatarak leg curl', 'ex_000176'], ['Geniş tutuş lat pulldown', 'ex_000298'], ['Çekiç curl', 'ex_000131'], ['Kürek makinesi', 'ex_000218'],
    ['Butterfly makinesi', 'ex_000192'], ['Tek kol dambıl row', 'ex_000188'], ['EZ bar curl', 'ex_000111'], ['Barfiks', 'ex_000203']]) {
    assert.equal(silent(id, name).status, 'matched', `${name} → ${id} stays automatic`);
  }
  // The golden set: a perfect model loses nothing to the guards; an over-eager model is stopped on every trap.
  const golden = JSON.parse(readFileSync(new URL('./fixtures/import-match-golden.v1.json', import.meta.url), 'utf8'));
  for (const [name, id] of golden.same) assert.equal(silent(id, name).status, 'matched', `guard false refusal: ${name} → ${id}`);
  for (const [name, , trap] of golden.variant) if (trap) assert.notEqual(silent(trap, name).status, 'matched', `trap not caught: ${name} → ${trap}`);
}

// ---- Technical failures are errors, never "not understood".
await assert.rejects(matchImportPreview({ preview: previewOf([ex('Foo move'), ex('Bar move')]), model: 'm', requestId: 'r', callModel: async () => reply([row(0)]) }), { code: 'IMPORT_MATCH_INCOMPLETE' });
await assert.rejects(matchImportPreview({ preview: previewOf([ex('Foo move')]), model: 'm', requestId: 'r', callModel: async () => ({ payload: { output_text: '{not json' } }) }), { code: 'IMPORT_MATCH_INVALID_RESPONSE' });
await assert.rejects(matchImportPreview({ preview: previewOf([ex('Foo move')]), model: 'm', requestId: 'r', callModel: async () => { throw Object.assign(new Error('x'), { code: 'OPENAI_TIMEOUT' }); } }), { code: 'OPENAI_TIMEOUT' });
await assert.rejects(matchImportPreview({ preview: previewOf(Array.from({ length: 201 }, (_, i) => ex(`Move ${i}`))), model: 'm', requestId: 'r', callModel: async () => reply([]) }), { code: 'IMPORT_MATCH_TOO_MANY_NAMES' });

// ---- Request body: strict schema, not stored upstream, catalog in the developer prefix; the old "always null" rule is gone.
{
  const body = matchRequestBody('gpt-4.1-mini', [{ sourceName: 'Dumbell Bench', normalizedName: 'Dumbbell Bench' }], 'rid');
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.temperature, 0);
  assert.ok(body.input[0].content[0].text.includes('ex_000095 | Dumbbell Bench Press | Dumbbell'));
  assert.deepEqual(JSON.parse(body.input[1].content[0].text), { names: [{ index: 0, name: 'Dumbell Bench', cleanedName: 'Dumbbell Bench' }] });
  assert.ok(matchPrompt().length < 40000, 'compact catalog');
  const worker = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  assert.ok(!worker.includes('exerciseMatch must always be null'));
  assert.ok(worker.includes('separate validated matching step (B57-007)'));
}

// ---- Same normalization as the app (src/exercises.ts normalizeExerciseQuery).
assert.equal(exactKey('  İç  Bacak Makinesi '), 'ic bacak makinesi');
assert.equal(exactKey('Lat Pull-Down'), 'lat pull down');

// ---- Routed endpoint over real SQLite.
const net = { calls: 0, bodies: [], next: null };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === 'https://api.openai.com/v1/responses' && init.method === 'POST') {
    net.calls++; const body = JSON.parse(init.body); net.bodies.push(body);
    if (net.during) await net.during();
    if (net.next) return net.next(body);
    const names = JSON.parse(body.input[1].content[0].text).names;
    return new Response(JSON.stringify(reply(names.map(n => row(n.index, n.name === 'Dumbell Bench' ? { sameExerciseId: 'ex_000095', sourceEquipment: 'dumbbell' } : { understood: false }))).payload), { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const db = createD1();
const env = { DB: db, OPENAI_API_KEY: 'fixture', OPENAI_IMPORT_RETRY_BASE_MS: '1', ZEPTOMAIL_API_KEY: 'fixture', ASSETS: { fetch: () => new Response('') } };
const call = (path, token, payload, headers = {}) => worker.fetch(new Request('https://api.reptrio.com' + path, { method: payload === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile', ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), env, { waitUntil() {} });
async function account(tag, consent = true) {
  const r = await call('/api/auth/register', null, { email: tag + '@example.test', password: 'fixture-password' }); assert.equal(r.status, 201);
  const u = await r.json();
  if (consent) assert.equal((await call('/api/privacy/ai-import/consent', u.sessionToken, { action: 'grant', policyVersion: POLICY })).status, 200);
  return u;
}
const seed = (u, id, status, preview) => db.raw.prepare(`INSERT INTO import_jobs (id, user_id, status, source_json, normalized_document_json, preview_json, attempts, created_at, updated_at)
  VALUES (?, ?, ?, '{}', '{}', ?, 1, '2026-11-14T00:00:00.000Z', '2026-11-14T00:00:00.000Z')`).run(id, u.user.id, status, preview ? JSON.stringify(preview) : null);
const stored = (u, id) => JSON.parse(db.rows('SELECT preview_json FROM import_jobs WHERE user_id=? AND id=?', u.user.id, id)[0].preview_json);
const match = (u, id, revision = IMPORT_MATCH_CATALOG.revision, headers) => call(`/api/import/jobs/${id}/match`, u?.sessionToken, { catalogRevision: revision }, headers);

const alice = await account('alice');
const bob = await account('bob');
const preview = previewOf([ex('Bench Press'), ex('Dumbell Bench')], [ex('Dumbell Bench'), ex('asf@@ 2!!')]);
seed(alice, 'job-a', 'done', preview);
seed(alice, 'job-run', 'processing', null);

assert.equal((await match(null, 'job-a')).status, 401);
assert.equal((await call('/api/import/jobs/job-a/match', alice.sessionToken)).status, 405, 'GET not allowed');
assert.equal((await match(alice, 'job-a', IMPORT_MATCH_CATALOG.revision, { Origin: 'https://evil.example' })).status, 403);
assert.equal((await match(bob, 'job-a')).status, 404, 'another account cannot match (or learn about) this job');
assert.equal((await match(alice, 'job-run')).status, 409, 'not finished yet');
const mismatch = await match(alice, 'job-a', 'wg-0.9.9+000000000000');
assert.deepEqual([mismatch.status, (await mismatch.json()).code], [409, 'IMPORT_MATCH_CATALOG_MISMATCH']);
assert.equal(net.calls, 0, 'no model call for refused requests');

// Upstream failure: technical code, stored preview untouched, retry later succeeds.
net.next = () => new Response('{}', { status: 429 });
const limited = await match(alice, 'job-a');
assert.deepEqual([limited.status, (await limited.json()).code], [429, 'OPENAI_RATE_LIMITED']);
assert.deepEqual(stored(alice, 'job-a'), preview, 'failure keeps the preview byte-identical');
net.next = null; net.calls = 0;
const ok = await match(alice, 'job-a');
assert.equal(ok.status, 200);
const okBody = await ok.json();
assert.equal(okBody.cached, false);
assert.equal(net.calls, 1);
assert.equal(net.bodies.at(-1).store, false, 'synchronous call, not stored upstream');
assert.deepEqual(okBody.catalogMatching.results.map(r => [r.sourceName, r.status, r.exerciseId]), [['Bench Press', 'matched', 'ex_000038'], ['Dumbell Bench', 'matched', 'ex_000095'], ['asf@@ 2!!', 'personal', null]]);
assert.deepEqual(stored(alice, 'job-a').catalogMatching, okBody.catalogMatching, 'persisted on the job');
assert.deepEqual(stored(alice, 'job-a').program, preview.program, 'source names and prescriptions unchanged');
// Double submit / reopen: cached, no second model call; the GET poll serves the stored matching too.
const again = await match(alice, 'job-a');
assert.equal((await again.json()).cached, true);
assert.equal(net.calls, 1);
const polled = await (await call('/api/import/jobs/job-a', alice.sessionToken)).json();
assert.equal(polled.preview.catalogMatching.status, 'done');

// Consent withdrawn: refused before any model call.
assert.equal((await call('/api/privacy/ai-import/consent', alice.sessionToken, { action: 'revoke', policyVersion: POLICY })).status, 200);
seed(alice, 'job-b', 'done', previewOf([ex('Dumbell Bench')]));
assert.equal((await match(alice, 'job-b')).status, 403);
assert.equal(net.calls, 1);

// Rate limit (B12) and consent order (B8): consent is checked before the limiter; a refused limiter costs no model call.
{
  const limiter = { calls: 0, ok: true, limit: async () => { limiter.calls++; return { success: limiter.ok }; } };
  env.AI_IMPORT_LIMITER = limiter;
  const carol = await account('carol');
  const dave = await account('dave', false);
  seed(carol, 'job-c', 'done', previewOf([ex('Dumbell Bench')]));
  seed(dave, 'job-d', 'done', previewOf([ex('Dumbell Bench')]));
  const before = net.calls;
  assert.equal((await match(dave, 'job-d')).status, 403);
  assert.equal(limiter.calls, 0, 'no consent: refused before the limiter');
  limiter.ok = false;
  const limited2 = await match(carol, 'job-c');
  assert.deepEqual([limited2.status, (await limited2.json()).code], [429, 'AI_IMPORT_RATE_LIMITED']);
  assert.equal(net.calls, before, 'limited: no model call');
  limiter.ok = true;

  // B9: consent revoked while the model runs → refused, nothing saved.
  net.during = async () => { net.during = null; await call('/api/privacy/ai-import/consent', carol.sessionToken, { action: 'revoke', policyVersion: POLICY }); };
  assert.equal((await match(carol, 'job-c')).status, 403);
  assert.equal(stored(carol, 'job-c').catalogMatching, undefined, 'revoked during the call: not saved');
  assert.equal((await call('/api/privacy/ai-import/consent', carol.sessionToken, { action: 'grant', policyVersion: POLICY })).status, 200);

  // B10 / race: the job is retried (queued) during the call → conflict, not saved over the new state.
  net.during = async () => { net.during = null; db.raw.prepare("UPDATE import_jobs SET status = 'queued', updated_at = '2026-11-14T00:00:01.000Z' WHERE id = 'job-c'").run(); };
  const raced = await match(carol, 'job-c');
  assert.deepEqual([raced.status, (await raced.json()).code], [409, 'IMPORT_CHANGED']);
  assert.equal(db.rows("SELECT status FROM import_jobs WHERE id = 'job-c'")[0].status, 'queued');
  // A re-extraction that already finished again (done, new preview) during the call is not overwritten either.
  db.raw.prepare("UPDATE import_jobs SET status = 'done' WHERE id = 'job-c'").run();
  const fresh = previewOf([ex('Squat'), ex('Şınav')]);
  net.during = async () => { net.during = null; db.raw.prepare("UPDATE import_jobs SET preview_json = ?, updated_at = '2026-11-14T00:00:02.000Z' WHERE id = 'job-c'").run(JSON.stringify(fresh)); };
  const raced2 = await match(carol, 'job-c');
  assert.equal(raced2.status, 409);
  assert.deepEqual(stored(carol, 'job-c'), fresh, 'the newer preview stays');
  // Then a normal match of the new preview succeeds.
  assert.equal((await match(carol, 'job-c')).status, 200);
  assert.equal(stored(carol, 'job-c').catalogMatching.results.length, 2);
  delete env.AI_IMPORT_LIMITER;
}

console.log('import catalog match test: PASS');
