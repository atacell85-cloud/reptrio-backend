// B57-007: import catalog matching. Pure pipeline (exact step, allowlist, deterministic guards, one batched call, technical
// failures) + the routed endpoint over real SQLite (auth, same origin, consent, ownership, readiness, catalog revision,
// idempotent cache, failure leaves the preview untouched, nothing stored upstream). The model is a local fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { createD1 } from './lib/d1-sqlite.mjs';
import {
  IMPORT_MATCH_CATALOG, catalogEquipment, catalogIndex, exactKey, exactMatch, guardRefusal, matchImportPreview, matchPrompt, matchRequestBody,
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
  assert.equal(exactMatch(index, { sourceName: 'Dumbell Bench', normalizedName: 'Bench Press' }), null, 'the extraction model\'s cleaned name is not an exact match');
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
  assert.equal(guardRefusal(index.byId.get('ex_000254'), 'smith_machine', [], 'Smith squat'), null, 'smith machine squat accepts smith');
  assert.equal(guardRefusal(index.byId.get('ex_000278'), 'trap_bar', [], 'Trap bar deadlift'), null);
  assert.equal(guardRefusal(index.byId.get('ex_000111'), 'barbell', []), 'equipment', 'EZ-bar curl is not a straight barbell curl');
  assert.equal(guardRefusal(index.byId.get('ex_000188'), 'dumbbell', ['single_arm'], 'One arm DB row'), null);
  assert.equal(guardRefusal(index.byId.get('ex_000218'), 'machine', []), null, 'rowing machine = Rowing (cardio)');
  assert.deepEqual([...catalogEquipment(index.byId.get('ex_000203'))].sort(), ['bodyweight', 'pull_up_bar']);
  // Model-reported attributes alone no longer satisfy the reverse checks: the source text must say incline.
  assert.equal(validateModelRow(index, entry, row(0, { sameExerciseId: 'ex_000151', sourceEquipment: 'dumbbell', sourceQualifiers: ['incline'] })).status, 'suggested');
  const ok = validateModelRow(index, { key: 'k', sourceName: 'Incline DB press' }, row(0, { sameExerciseId: 'ex_000151', sourceEquipment: 'dumbbell', sourceQualifiers: ['incline'] }));
  assert.deepEqual([ok.status, ok.exerciseId], ['matched', 'ex_000151']);
}

// ---- The source text itself is parsed (TR/EN), so a model that under-reports attributes cannot auto-match a variant.
{
  const silent = (id, name) => validateModelRow(index, { key: 'k', sourceName: name }, row(0, { sameExerciseId: id }));
  for (const [name, id] of [['Incline DB press', 'ex_000095'], ['Neutral grip lat pulldown', 'ex_000166'], ['Sumo deadlift', 'ex_000081'],
    ['Ters eğimli bench', 'ex_000148'], ['Barbell curl', 'ex_000040'], ['Pendulum squat', 'ex_000128'],
    ['Z press', 'ex_000189'], ['Standing leg curl', 'ex_000170'], ['Calf raise', 'ex_000224'], ['Seated calf raise', 'ex_000059'],
    ['Seated row machine', 'ex_000229'], ['Floor press', 'ex_000038'],
    ['Yana açış', 'ex_000052'], ['Yana açış', 'ex_000180'], ['Pazı curl', 'ex_000048'], ['Çömelme', 'ex_000254'], ['Lat çekiş', 'ex_000022'],
    ['Glute bridges', 'ex_000031'], ['Barfiks', 'ex_000295'], ['Dips', 'ex_000294'], ['Şınav', 'ex_000296'], ['Weighted plank', 'ex_000196'],
    ['Ring dip', 'ex_000088'], ['TRX row', 'ex_000153'], ['Snatch grip deadlift', 'ex_000081'], ['Push jerk', 'ex_000204'], ['Zottman curl', 'ex_000040'],
    ['Yates row', 'ex_000032'], ['Low to high cable fly', 'ex_000049'], ['Feet elevated push up', 'ex_000205'], ['Tek kol kablo lateral raise', 'ex_000052'], ['Makinede hip thrust', 'ex_000144']]) {
    const r = silent(id, name);
    assert.equal(r.status, 'suggested', `${name} must not auto-match ${id}`);
    assert.equal(r.suggestions[0], id);
  }
  for (const [name, id] of [['Incline DB press', 'ex_000151'], ['Ters tutuş barfiks', 'ex_000066'], ['Chin up', 'ex_000066'], ['Kablo ile oturarak row', 'ex_000229'],
    ['Yatarak leg curl', 'ex_000176'], ['Geniş tutuş lat pulldown', 'ex_000298'], ['Çekiç curl', 'ex_000131'], ['Kürek makinesi', 'ex_000218'],
    ['Butterfly makinesi', 'ex_000192'], ['Tek kol dambıl row', 'ex_000188'], ['EZ bar curl', 'ex_000111'], ['Barfiks', 'ex_000203'],
    ['Seated leg extension', 'ex_000171'], ['Ayakta OHP', 'ex_000189'], ['Lat pulldown makinesi', 'ex_000166'], ['Cable row', 'ex_000229'],
    ['Reverse grip curl', 'ex_000210'], ['Front plank', 'ex_000196'], ['Front lunge', 'ex_000118'], ['CGBP', 'ex_000068'], ['Hammer grip pull-up', 'ex_000186'],
    ['Ağırlıklı barfiks', 'ex_000295'], ['Smith squat', 'ex_000254'], ['Banded lat pulldown', 'ex_000022'],
    ['Önden lat çekiş', 'ex_000166'], ['Üstten aşağı çekiş', 'ex_000166'], ['Calf raise on leg press', 'ex_000173'], ['Push-up on knees', 'ex_000159'],
    ['Ön kol curl', 'ex_000301'], ['Box step-up', 'ex_000266'], ['Feet elevated push-up', 'ex_000084'], ['Plank on elbows', 'ex_000196'],
    ['Ön squat', 'ex_000122'], ['Yüzüstü leg curl', 'ex_000176'], ['Tek kolla dumbbell row', 'ex_000188'], ['Parallel bar dips', 'ex_000088'], ['Yerde mekik', 'ex_000076']]) {
    assert.equal(silent(id, name).status, 'matched', `${name} → ${id} stays automatic`);
  }
  // Round 6: Turkish suffixes on equipment words; every named-variant word of the entry; and the model can NOT vouch for the
  // attributes of its own pick (reverse checks use only the source text).
  for (const [name, id] of [['Lastikli squat', 'ex_000258'], ['Dambılla bench press', 'ex_000038'], ['Kabloyla curl', 'ex_000040'], ['Halterle curl', 'ex_000040'],
    ['Kablodan yana açış', 'ex_000168'], ['Halterli lunge', 'ex_000212'], ['Plakayla ön kaldırış', 'ex_000121'], ['Lastikli lat pulldown', 'ex_000166'],
    ['Row', 'ex_000183'], ['Curl', 'ex_000255'], ['Lunge', 'ex_000086'], ['Tek bacak squat', 'ex_000239'], ['Shoulder press', 'ex_000163'], ['RDLs', 'ex_000164'],
    ['Jumping jacks', 'ex_000223'], ['Incline bench', 'ex_000151'], ['Decline press', 'ex_000083']]) assert.equal(silent(id, name).status, 'suggested', `${name} must not auto-match ${id}`);
  const reported = (id, name, sourceEquipment, sourceQualifiers = []) => validateModelRow(index, { key: 'k', sourceName: name }, row(0, { sameExerciseId: id, sourceEquipment, sourceQualifiers }));
  for (const [name, id, eq, q] of [['Yana açış', 'ex_000052', 'cable'], ['Yana açış', 'ex_000180', 'machine'], ['Çömelme', 'ex_000254', 'smith_machine'],
    ['Lat çekiş', 'ex_000022', 'resistance_band'], ['Lat çekiş', 'ex_000298', 'unspecified', ['wide_grip']], ['Barfiks', 'ex_000186', 'unspecified', ['neutral_grip']],
    ['Squats', 'ex_000122', 'unspecified', ['front']]]) assert.equal(reported(id, name, eq, q).status, 'suggested', `model-vouched ${name} → ${id} refused`);
  for (const [name, id] of [['Lastikli hip thrust', 'ex_000020'], ['Ters tutuşla curl', 'ex_000210'], ['Rope crunch', 'ex_000047'], ['Halat crunch', 'ex_000047'],
    ['Crossover', 'ex_000049'], ['EZ curl', 'ex_000111'], ['Dumbbell Russian twist', 'ex_000297'], ['Dambılla Russian twist', 'ex_000297'], ['Plate crunch', 'ex_000293'],
    ['Chest press', 'ex_000178'], ['Pull through', 'ex_000054'], ['Pull aparts', 'ex_000012'], ['Battle ropes', 'ex_000033'], ['Jump rope', 'ex_000154'],
    ['Koşu bandı', 'ex_000219'], ['Incline bench press', 'ex_000148']]) assert.equal(silent(id, name).status, 'matched', `${name} → ${id} stays automatic`);
  // Round 7: bant / tek taraflı / sağlık topu / halka words, position pools from the source text only, catalog distinguishing
  // words (walking, diamond, bench dip, nordic, kneeling, assisted, towel, handstand, archer, rope where a rope version exists…).
  const r7 = (name, id, eq = 'unspecified', q = []) => validateModelRow(index, { key: 'k', sourceName: name }, row(0, { sameExerciseId: id, sourceEquipment: eq, sourceQualifiers: q }));
  for (const [name, id, eq, q] of [['Bant ile squat','ex_000258'],['Bant squat','ex_000258'],['Tek taraflı dumbbell row','ex_000096'],['Tek taraflı cable row','ex_000229'],['Tek taraflı leg press','ex_000172'],
['Oturarak calf raise','ex_000059','bodyweight'],['Seated calf raises','ex_000059','bodyweight'],['Seated calf','ex_000059','bodyweight'],
['Walking lunges','ex_000212'],['Yürüyen lunge','ex_000212'],['Diamond pushups','ex_000205'],['Bench dips','ex_000088'],['Nordic curl','ex_000170'],['Kneeling pallof press','ex_000191'],['Rope pushdown','ex_000281'],
['Barfiks','ex_000010'],['Barfiks','ex_000276'],['Push-ups','ex_000133'],['Push-ups','ex_000003'],['Leg curl','ex_000176','unspecified',['lying']],['Sağlık topu crunch','ex_000076'],['Halkada dips','ex_000088'],
['Yana açış','ex_000052']]) assert.equal(r7(name, id, eq, q).status, 'suggested', `r7 leak: ${name} → ${id}`);
  for (const [name, id, eq, q] of [['Bant ile squat','ex_000028'],['Lastikli squat','ex_000028'],['Tek taraflı dumbbell row','ex_000188'],['Tek taraflı cable row','ex_000236'],['Halat sallama','ex_000033'],['Rope jumping','ex_000154'],['Skipping rope','ex_000154'],['Rope crunch','ex_000047'],['Rope pushdown','ex_000217'],
['Elmas şınav','ex_000087'],['Diamond push up','ex_000087'],['Walking lunge','ex_000286'],['Yürüyerek lunge','ex_000286'],['Bench dip','ex_000037'],['Nordic hamstring curl','ex_000187'],['Half kneeling pallof press','ex_000130'],['Destekli barfiks','ex_000010'],['Negatif barfiks','ex_000185'],['Amuda kalkarak şınav','ex_000133'],['Pistol squat','ex_000195'],['Bulgar squat','ex_000044'],['Goblet squat','ex_000126'],['Hack squat','ex_000128'],['Ters tutuşlu curl','ex_000210'],['Hammer curl','ex_000131'],['Çekiç curl','ex_000131'],['Pike push up','ex_000194'],['Archer push up','ex_000003'],['Donkey calf raise','ex_000089'],['Belt squat','ex_000036'],['Seated calf raise','ex_000224']]) assert.equal(r7(name, id, eq, q).status, 'matched', `r7 accept: ${name} → ${id}`);
  // A suffixed Turkish grip word still counts ("ters tutuşlu" lat pulldown is not the plain Lat Pulldown).
  assert.equal(r7('Ters tutuşlu lat pulldown', 'ex_000166').status, 'suggested');
  assert.equal(r7('Ters tutuşla barfiks', 'ex_000066').status, 'matched');
  // After the real-model run (2026-11-15): catalog-derived specific versions, and refusals the run exposed.
  assert.equal(r7('Calf press on leg press', 'ex_000172').status, 'suggested', 'Leg Press Calf Raise exists → not the plain Leg Press');
  assert.equal(r7('Calf press on leg press', 'ex_000173').status, 'matched');
  for (const [name, id] of [['Dizüstü şınav', 'ex_000159'], ['Göğüs destekli row', 'ex_000064'], ['Yürüyüş lunge', 'ex_000286'], ['Destekli barfiks', 'ex_000010'],
    ['Leg press', 'ex_000172'], ['Romanian deadlift', 'ex_000215'], ['Barbell squat', 'ex_000258']]) assert.equal(r7(name, id).status, 'matched', `${name} → ${id}`);
  // The extraction model's cleaned name cannot vouch for a pick.
  assert.equal(validateModelRow(index, { key: 'k', sourceName: 'Yana açış', normalizedName: 'Cable Lateral Raise' }, row(0, { sameExerciseId: 'ex_000052' })).status, 'suggested');
  // The golden set: a perfect model loses nothing to the guards; an over-eager model is stopped on every trap.
  const golden = JSON.parse(readFileSync(new URL('./fixtures/import-match-golden.v1.json', import.meta.url), 'utf8'));
  // Names the exact step resolves never reach the guards in production.
  for (const [name, id] of golden.same) if (!exactMatch(index, { sourceName: name })) assert.equal(silent(id, name).status, 'matched', `guard false refusal: ${name} → ${id}`);
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
  // Ids are constrained to the catalog (the real run returned whole calls of unusable ids without this).
  const props = body.text.format.schema.properties.results.items.properties;
  assert.deepEqual(props.sameExerciseId.enum, [...IMPORT_MATCH_CATALOG.exercises.map(e => e.id), null]);
  assert.deepEqual(props.suggestionIds.items.enum, IMPORT_MATCH_CATALOG.exercises.map(e => e.id));
  assert.ok(body.input[0].content[0].text.includes('şınav çekme = push-up'));
  assert.equal(body.temperature, 0);
  assert.ok(body.input[0].content[0].text.includes('ex_000095 | Dumbbell Bench Press | Dumbbell'));
  assert.deepEqual(JSON.parse(body.input[1].content[0].text), { names: [{ index: 0, name: 'Dumbell Bench', cleanedName: 'Dumbbell Bench' }] });
  assert.ok(matchPrompt().length < 40000, 'compact catalog');
  const worker = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  assert.ok(!worker.includes('exerciseMatch must always be null'));
  assert.ok(worker.includes('separate validated matching step (B57-007)'));
}

// ---- Exact step needs exactly one target (an alias shared by two entries is left to the model).
{
  const tiny = { revision: 'x', exercises: [{ id: 'ex_a', name: 'Row', equipment: 'Barbell', primary: [], aliases: ['cable row'] }, { id: 'ex_b', name: 'Cable Row', equipment: 'Cable', primary: [], aliases: [] }] };
  let sent = null;
  const result = await matchImportPreview({ preview: previewOf([ex('Cable row'), ex('Row')]), model: 'm', requestId: 'r', catalog: tiny, callModel: async body => { sent = JSON.parse(body.input[1].content[0].text).names.map(n => n.name); return reply([row(0)]); } });
  assert.deepEqual(sent, ['Cable row'], 'ambiguous exact name goes to the model');
  assert.deepEqual(result.results.map(r => [r.sourceName, r.method, r.exerciseId]), [['Cable row', 'ai', null], ['Row', 'exact', 'ex_a']]);
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
const matchCol = (u, id) => JSON.parse(db.rows('SELECT catalog_match_json FROM import_jobs WHERE user_id=? AND id=?', u.user.id, id)[0].catalog_match_json || 'null');
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
assert.deepEqual(matchCol(alice, 'job-a').catalogMatching, okBody.catalogMatching, 'persisted beside the preview');
assert.match(matchCol(alice, 'job-a').previewSha, /^[0-9a-f]{64}$/);
assert.deepEqual(stored(alice, 'job-a'), preview, 'the preview itself is byte-identical (never carries the match result)');
// Double submit / reopen: cached, no second model call (the GET poll never serves it; see below).
const again = await match(alice, 'job-a');
assert.equal((await again.json()).cached, true);
assert.equal(net.calls, 1);
// Cross-client safety (Guardian r3 BLOCKER-1): the job poll that every client (mobile <= 1.2.0 (56), web app) copies into its
// synced importPreviews never carries the match result.
const polled = await (await call('/api/import/jobs/job-a', alice.sessionToken)).json();
assert.deepEqual(polled.preview, preview, 'poll returns the extraction preview only');
assert.ok(!JSON.stringify(polled).includes('catalogMatching') && !JSON.stringify(polled).includes('catalog_match'), 'no match data anywhere in the poll');
// The cache is bound to the exact preview: a re-extracted preview is matched again, not served the old result.
db.raw.prepare("UPDATE import_jobs SET preview_json = ? WHERE id = 'job-a'").run(JSON.stringify(previewOf([ex('Squat')])));
const rematched = await (await match(alice, 'job-a')).json();
assert.equal(rematched.cached, false);
assert.deepEqual(rematched.catalogMatching.results.map(r => r.sourceName), ['Squat']);
db.raw.prepare("UPDATE import_jobs SET preview_json = ? WHERE id = 'job-a'").run(JSON.stringify(preview));
// Re-match the original preview so the stored entry's hash matches it again (cached on the next call)...
assert.equal((await (await match(alice, 'job-a')).json()).cached, false);
assert.equal((await (await match(alice, 'job-a')).json()).cached, true, 'same preview + same catalog → cached');
// ...then only the catalog revision differs: the cached entry must not be served.
db.raw.prepare("UPDATE import_jobs SET catalog_match_json = json_set(catalog_match_json, '$.catalogMatching.catalogRevision', 'wg-0.0.0+old') WHERE id = 'job-a'").run();
assert.equal((await (await match(alice, 'job-a')).json()).cached, false, 'old-catalog result is not served');

// Consent withdrawn: refused before any model call.
assert.equal((await call('/api/privacy/ai-import/consent', alice.sessionToken, { action: 'revoke', policyVersion: POLICY })).status, 200);
seed(alice, 'job-b', 'done', previewOf([ex('Dumbell Bench')]));
const callsBeforeRevoked = net.calls;
assert.equal((await match(alice, 'job-b')).status, 403);
assert.equal(net.calls, callsBeforeRevoked);

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
  assert.equal(matchCol(carol, 'job-c'), null, 'revoked during the call: not saved');
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
  assert.equal(matchCol(carol, 'job-c').catalogMatching.results.length, 2);
  assert.equal(stored(carol, 'job-c').catalogMatching, undefined);
  delete env.AI_IMPORT_LIMITER;
}

// An incomplete model answer is a 502 technical failure; the stored preview stays untouched.
{
  const erin = await account('erin');
  seed(erin, 'job-e', 'done', previewOf([ex('Foo move'), ex('Bar move')]));
  net.next = () => new Response(JSON.stringify(reply([row(0)]).payload), { headers: { 'Content-Type': 'application/json' } });
  const incomplete = await match(erin, 'job-e');
  assert.deepEqual([incomplete.status, (await incomplete.json()).code], [502, 'IMPORT_MATCH_INCOMPLETE']);
  assert.equal(matchCol(erin, 'job-e'), null);
  net.next = null;
}

// Before migration 0019 the endpoint fails closed (503), and nothing is written into the preview.
{
  const oldDb = createD1({ migrationsUpTo: '0018_password_enabled.sql' });
  const oldEnv = { ...env, DB: oldDb };
  const r = await worker.fetch(new Request('https://api.reptrio.com/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ email: 'old@example.test', password: 'fixture-password' }) }), oldEnv, { waitUntil() {} });
  const u = await r.json();
  await worker.fetch(new Request('https://api.reptrio.com/api/privacy/ai-import/consent', { method: 'POST', headers: { Authorization: 'Bearer ' + u.sessionToken, 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ action: 'grant', policyVersion: POLICY }) }), oldEnv, { waitUntil() {} });
  oldDb.raw.prepare(`INSERT INTO import_jobs (id, user_id, status, source_json, normalized_document_json, preview_json, attempts, created_at, updated_at) VALUES ('j', ?, 'done', '{}', '{}', ?, 1, 'x', 'x')`).run(u.user.id, JSON.stringify(previewOf([ex('Dumbell Bench')])));
  const res = await worker.fetch(new Request('https://api.reptrio.com/api/import/jobs/j/match', { method: 'POST', headers: { Authorization: 'Bearer ' + u.sessionToken, 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ catalogRevision: IMPORT_MATCH_CATALOG.revision }) }), oldEnv, { waitUntil() {} });
  assert.deepEqual([res.status, (await res.json()).code], [503, 'IMPORT_MATCH_UNAVAILABLE']);
  assert.ok(!oldDb.rows("SELECT preview_json FROM import_jobs WHERE id='j'")[0].preview_json.includes('catalogMatching'));
}

console.log('import catalog match test: PASS');
