#!/usr/bin/env node
// B57-007 accuracy / cost measurement of the PRODUCTION match step: the same `matchImportPreview` (exact step, prompt, strict
// schema, guards) and the same `requestOpenAIBody` call (model, temperature 0, store:false, 30 s timeout, 1 retry) the Worker
// runs in POST /api/import/jobs/:id/match. Not covered: the document extraction step before it (names are fed directly).
//
//   node scripts/import-match-eval.mjs [--set heldout|golden] [--batch 30] [--model gpt-4.1-mini] [--out result.json]
//       real model calls. The API key is read from OPENAI_API_KEY or, when unset, hidden terminal input (never echoed, never
//       an argument, never logged or written). Output (console and --out, mode 600) holds names, ids, statuses, token counts
//       and timings only. Test names are synthetic (no user data).
//   offline modes (no key, no network): --exact-only | --oracle | --trap | --trap-reported
//
// Sets: `heldout` (default; scripts/fixtures/import-match-heldout.v1.json, written after the guards and never used to tune
// them) and `golden` (scripts/fixtures/import-match-golden.v1.json, the implementer's tuning set).
// Metrics, per class and overall, reported for the model ALONE (its raw pick, guards ignored) and for model + guards (what the
// app receives):
//   found     — exercise is in the catalog and the correct id is assigned automatically
//   needless  — exercise is in the catalog, but the person must confirm (split: model gave no id / guard refused a correct id)
//   wrong     — an automatic id that is not acceptable (wrong exercise, or any id on a variant / nonsense name)
//   saved     — wrong model picks the guards turned into suggestions
import { readFileSync, writeFileSync } from 'node:fs';
import { IMPORT_MATCH_CATALOG, catalogEquipment, catalogQualifiers, matchImportPreview } from '../worker/import-catalog-match.js';
import { requestOpenAIBody } from '../worker/index.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const has = name => process.argv.includes(name);
const exactOnly = has('--exact-only'), oracle = has('--oracle'), trapReported = has('--trap-reported'), trap = has('--trap') || trapReported;
// --replay <result.json>: re-run the CURRENT pipeline on the raw model answers recorded by an earlier real run (no key, no network).
const replayFile = arg('--replay', null);
const replay = replayFile ? new Map(JSON.parse(readFileSync(replayFile, 'utf8')).results.filter(r => r.model).map(r => [r.name, r.model])) : null;
const offline = exactOnly || oracle || trap || Boolean(replay);
const setName = arg('--set', 'heldout');
const batchSize = Number(arg('--batch', 30));
const model = arg('--model', 'gpt-4.1-mini');
const out = arg('--out', null);
// gpt-4.1-mini list prices per 1M tokens (USD) at the time of writing; verify before quoting.
const PRICE = { input: 0.40, cachedInput: 0.10, output: 1.60 };

function loadCases() {
  const read = file => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
  if (setName === 'golden') {
    const g = read('import-match-golden.v1.json');
    return [
      ...g.same.map(([name, id]) => ({ name, class: 'same', kind: 'same', expected: id, acceptable: [id] })),
      ...g.variant.map(([name, acceptable, trapId]) => ({ name, class: 'variant', kind: 'variant', expected: null, acceptable, trap: trapId || null })),
      ...g.nonsense.map(name => ({ name, class: 'nonsense', kind: 'nonsense', expected: null, acceptable: [] })),
    ];
  }
  if (setName === 'heldout') return read('import-match-heldout.v1.json').cases.map(c => ({ trap: null, ...c }));
  throw new Error(`unknown --set ${setName}`);
}
const cases = loadCases();

function hiddenInput(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('OPENAI_API_KEY is not set and no TTY is available for hidden input.'));
    stdout.write(prompt); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let value = '';
    const done = err => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); stdout.write('\n'); err ? reject(err) : resolve(value.trim()); };
    const onData = chunk => { for (const ch of chunk) { if (ch === '\r' || ch === '\n') return done(); if (ch === '\u0003') return done(new Error('cancelled')); if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch; } };
    stdin.on('data', onData);
  });
}

let apiKey = null;
if (!offline) apiKey = process.env.OPENAI_API_KEY || await hiddenInput('OpenAI API key (gizli giriş, kaydedilmez): ');
// Same values as the Worker's match call (worker/index.js matchConfig defaults).
const config = { model, timeoutMs: 30000, maxRetries: 1, retryBaseMs: 750 };
const byName = new Map(cases.map(c => [c.name, c]));
const fakeRow = n => {
  if (replay) { const m = replay.get(n.name); return m ? { index: n.index, ...m } : { index: n.index, understood: false, interpretation: '', sourceEquipment: 'unspecified', sourceQualifiers: [], sameExerciseId: null, suggestionIds: [] }; }
  const c = byName.get(n.name);
  const base = { index: n.index, understood: true, interpretation: '', sourceEquipment: 'unspecified', sourceQualifiers: [], sameExerciseId: null, suggestionIds: [] };
  if (exactOnly) return base;
  if (c.kind === 'nonsense') return { ...base, understood: false };
  if (c.kind === 'same') return { ...base, sameExerciseId: c.expected };
  if (trapReported && c.trap) {
    const entry = IMPORT_MATCH_CATALOG.exercises.find(e => e.id === c.trap);
    return { ...base, sameExerciseId: c.trap, sourceEquipment: [...catalogEquipment(entry)][0] || 'unspecified', sourceQualifiers: [...catalogQualifiers(entry)] };
  }
  return { ...base, sameExerciseId: trap ? c.trap : null };
};
const rawRows = new Map();   // the model's own answer per name (id, equipment, qualifiers), for diagnosis only
const remember = (body, payload) => {
  const names = JSON.parse(body.input[1].content[0].text).names;
  let rows = [];
  try { rows = JSON.parse(payload.output_text ?? payload.output?.flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text ?? '{}').results || []; } catch {}
  for (const r of rows) if (names[r.index]) rawRows.set(names[r.index].name, { sameExerciseId: r.sameExerciseId, suggestionIds: r.suggestionIds, sourceEquipment: r.sourceEquipment, sourceQualifiers: r.sourceQualifiers, understood: r.understood, interpretation: r.interpretation });
  return { payload };
};
const callModel = offline
  ? async body => remember(body, { output_text: JSON.stringify({ results: JSON.parse(body.input[1].content[0].text).names.map(fakeRow) }) })
  : async body => { const res = await requestOpenAIBody({ apiKey, config, body, requestId: `eval-${Date.now()}` }); remember(body, res.payload); return res; };

const ref = { page: null, sheet: null, cellRange: null, text: null };
const results = [], calls = [];
for (let i = 0; i < cases.length; i += batchSize) {
  const batch = cases.slice(i, i + batchSize);
  const preview = { program: { days: [{ sections: [{ items: batch.map(c => ({ itemType: 'exercise', sourceExerciseName: c.name, normalizedExerciseName: c.name, sourceReference: ref })) }] }] } };
  const started = Date.now();
  const matching = await matchImportPreview({ preview, model, requestId: `eval-${i}`, callModel });
  calls.push({ names: batch.length, modelCalls: offline ? 0 : matching.modelCalls, wallMs: Date.now() - started, usage: matching.usage });
  for (const c of batch) {
    const r = matching.results.find(x => x.sourceName === c.name);
    // The model's raw pick: an accepted id, or the id a guard refused (always the first suggestion then).
    const modelPick = r.exerciseId || (r.guard && r.guard !== 'unknownId' ? r.suggestions[0] : null);
    results.push({ ...c, status: r.status, method: r.method, exerciseId: r.exerciseId, modelPick, suggestions: r.suggestions, understood: r.understood, guard: r.guard, model: rawRows.get(c.name) || null });
  }
}

const isWrong = (r, id) => Boolean(id) && !r.acceptable.includes(id);
function metrics(rows) {
  const same = rows.filter(r => r.kind === 'same');
  return {
    names: rows.length,
    inCatalog: same.length,
    modelAlone: { found: same.filter(r => r.modelPick === r.expected).length, wrong: rows.filter(r => isWrong(r, r.modelPick)).length },
    withGuards: {
      found: same.filter(r => r.exerciseId === r.expected).length,
      foundRate: same.length ? +(same.filter(r => r.exerciseId === r.expected).length / same.length).toFixed(3) : null,
      exactStep: same.filter(r => r.method === 'exact' && r.exerciseId === r.expected).length,
      needless: same.filter(r => r.exerciseId !== r.expected && !isWrong(r, r.exerciseId)).length,
      needlessModelNoId: same.filter(r => !r.exerciseId && !r.modelPick).length,
      needlessModelOtherId: same.filter(r => !r.exerciseId && r.modelPick && r.modelPick !== r.expected).length,
      needlessGuardRefusedCorrect: same.filter(r => !r.exerciseId && r.modelPick === r.expected).length,
      correctAmongSuggestions: same.filter(r => !r.exerciseId && r.suggestions.includes(r.expected)).length,
      wrong: rows.filter(r => isWrong(r, r.exerciseId)).length,
    },
    guardsSaved: rows.filter(r => isWrong(r, r.modelPick) && !r.exerciseId).length,
  };
}
const classes = [...new Set(results.map(r => r.class))];
const tokens = calls.reduce((t, c) => ({ input: t.input + (c.usage?.inputTokens || 0), cached: t.cached + (c.usage?.cachedInputTokens || 0), output: t.output + (c.usage?.outputTokens || 0) }), { input: 0, cached: 0, output: 0 });
const cost = ((tokens.input - tokens.cached) * PRICE.input + tokens.cached * PRICE.cachedInput + tokens.output * PRICE.output) / 1e6;
const modelCalls = calls.filter(c => c.modelCalls);
const summary = {
  mode: replay ? `replay of ${replayFile.split('/').pop()}` : exactOnly ? 'exact-only' : oracle ? 'oracle (perfect model)' : trapReported ? 'trap-reported (over-eager model reporting its pick\'s attributes)' : trap ? 'trap (over-eager model, no reported attributes)' : `model:${model}`,
  set: setName, batchSize, overall: metrics(results), byClass: Object.fromEntries(classes.map(c => [c, metrics(results.filter(r => r.class === c))])),
  trapsOffered: results.filter(r => r.trap).length, modelCalls: modelCalls.length, tokens, estimatedCostUsd: +cost.toFixed(5),
  perCallAvg: modelCalls.length ? { names: +(modelCalls.reduce((s, c) => s + c.names, 0) / modelCalls.length).toFixed(1), wallMs: Math.round(modelCalls.reduce((s, c) => s + c.wallMs, 0) / modelCalls.length), costUsd: +(cost / modelCalls.length).toFixed(5) } : null,
};
console.log(JSON.stringify(summary, null, 1));
for (const r of results.filter(r => isWrong(r, r.exerciseId))) console.log(`WRONG AUTO     [${r.class}] "${r.name}" -> ${r.exerciseId} (acceptable: ${r.acceptable.join(',') || '-'})`);
for (const r of results.filter(r => isWrong(r, r.modelPick) && !r.exerciseId)) console.log(`GUARD SAVED    [${r.class}] "${r.name}" model ${r.modelPick} -> ${r.status} (guard=${r.guard})`);
for (const r of results.filter(r => r.kind === 'same' && !r.exerciseId)) console.log(`NEEDS CONFIRM  [${r.class}] "${r.name}" expected ${r.expected}; model ${r.modelPick || '-'}; ${r.status} [${r.suggestions.join(',')}]${r.guard ? ` guard=${r.guard}` : ''}`);
if (out) writeFileSync(out, JSON.stringify({ summary, calls, results }, null, 1), { mode: 0o600 });
// Enforced in offline modes: a perfect model loses nothing on the golden set and an over-eager one auto-assigns no wrong id there.
if (offline && setName === 'golden' && (summary.overall.withGuards.wrong > 0 || (oracle && summary.overall.withGuards.found !== summary.overall.inCatalog))) process.exitCode = 1;
