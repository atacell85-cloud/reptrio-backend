#!/usr/bin/env node
// B57-007 accuracy / cost measurement of the PRODUCTION matcher (worker/import-catalog-match.js) on the synthetic golden set
// scripts/fixtures/import-match-golden.v1.json. Two modes:
//   node scripts/import-match-eval.mjs --exact-only            deterministic step alone (no model, no key)
//   node scripts/import-match-eval.mjs [--batch 30] [--model gpt-4.1-mini] [--out result.json]
//     real model calls; the API key comes from OPENAI_API_KEY or, when unset, hidden terminal input (never echoed,
//     never written, never passed as an argument). Output holds names, ids, statuses, tokens and timings only.
// Metrics: automatic-correct rate on names whose exercise IS in the catalog, false automatic matches (wrong id, or any id
// on a variant/nonsense name outside its acceptable list), suggestion coverage, tokens, latency and estimated cost.
import { readFileSync, writeFileSync } from 'node:fs';
import { matchImportPreview } from '../worker/import-catalog-match.js';
import { requestOpenAIBody } from '../worker/index.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const exactOnly = process.argv.includes('--exact-only');
const batchSize = Number(arg('--batch', 30));
const model = arg('--model', 'gpt-4.1-mini');
const out = arg('--out', null);
// List prices per 1M tokens (USD) for gpt-4.1-mini at the time of writing; verify before quoting.
const PRICE = { input: 0.40, cachedInput: 0.10, output: 1.60 };

const golden = JSON.parse(readFileSync(new URL('./fixtures/import-match-golden.v1.json', import.meta.url), 'utf8'));
const cases = [
  ...golden.same.map(([name, id]) => ({ name, kind: 'same', expected: id, acceptable: [id] })),
  ...golden.variant.map(([name, acceptable]) => ({ name, kind: 'variant', expected: null, acceptable })),
  ...golden.nonsense.map(name => ({ name, kind: 'nonsense', expected: null, acceptable: [] })),
];

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
if (!exactOnly) apiKey = process.env.OPENAI_API_KEY || await hiddenInput('OpenAI API key (gizli giriş): ');
const config = { model, timeoutMs: 60000, maxRetries: 1, retryBaseMs: 750 };
const callModel = exactOnly
  ? async body => ({ payload: { output_text: JSON.stringify({ results: JSON.parse(body.input[1].content[0].text).names.map(n => ({ index: n.index, understood: true, interpretation: '', sourceEquipment: 'unspecified', sourceQualifiers: [], sameExerciseId: null, suggestionIds: [] })) }) } })
  : body => requestOpenAIBody({ apiKey, config, body, requestId: `eval-${Date.now()}` });

const ref = { page: null, sheet: null, cellRange: null, text: null };
const results = [];
const calls = [];
for (let i = 0; i < cases.length; i += batchSize) {
  const batch = cases.slice(i, i + batchSize);
  const preview = { program: { days: [{ sections: [{ items: batch.map(c => ({ itemType: 'exercise', sourceExerciseName: c.name, normalizedExerciseName: c.name, sourceReference: ref })) }] }] } };
  const started = Date.now();
  const matching = await matchImportPreview({ preview, model, requestId: `eval-${i}`, callModel });
  calls.push({ names: batch.length, modelCalls: matching.modelCalls, wallMs: Date.now() - started, usage: matching.usage });
  for (const c of batch) {
    const r = matching.results.find(x => x.sourceName === c.name);
    results.push({ ...c, status: r.status, method: r.method, exerciseId: r.exerciseId, suggestions: r.suggestions, understood: r.understood, guard: r.guard });
  }
}

const same = results.filter(r => r.kind === 'same');
const notSame = results.filter(r => r.kind !== 'same');
const autoCorrect = same.filter(r => r.exerciseId === r.expected);
const falseAuto = results.filter(r => r.exerciseId && !r.acceptable.includes(r.exerciseId));
const sameMissedWithSuggestion = same.filter(r => !r.exerciseId && r.suggestions.includes(r.expected));
const variantAuto = notSame.filter(r => r.exerciseId);
const tokens = calls.reduce((t, c) => ({ input: t.input + (c.usage?.inputTokens || 0), cached: t.cached + (c.usage?.cachedInputTokens || 0), output: t.output + (c.usage?.outputTokens || 0) }), { input: 0, cached: 0, output: 0 });
const cost = ((tokens.input - tokens.cached) * PRICE.input + tokens.cached * PRICE.cachedInput + tokens.output * PRICE.output) / 1e6;
const modelCalls = calls.filter(c => c.modelCalls);
const summary = {
  mode: exactOnly ? 'exact-only' : `model:${model}`, batchSize, cases: results.length,
  same: { total: same.length, autoCorrect: autoCorrect.length, autoCorrectRate: +(autoCorrect.length / same.length).toFixed(3), exactStep: same.filter(r => r.method === 'exact' && r.exerciseId === r.expected).length,
    wrongId: same.filter(r => r.exerciseId && r.exerciseId !== r.expected).length, missedButSuggested: sameMissedWithSuggestion.length, missedNoSuggestion: same.filter(r => !r.exerciseId && !r.suggestions.includes(r.expected)).length },
  variant: { total: results.filter(r => r.kind === 'variant').length, auto: variantAuto.filter(r => r.kind === 'variant').length, autoAcceptable: variantAuto.filter(r => r.kind === 'variant' && r.acceptable.includes(r.exerciseId)).length,
    suggested: results.filter(r => r.kind === 'variant' && r.status === 'suggested').length, personal: results.filter(r => r.kind === 'variant' && r.status === 'personal').length },
  nonsense: { total: results.filter(r => r.kind === 'nonsense').length, auto: results.filter(r => r.kind === 'nonsense' && r.exerciseId).length, personal: results.filter(r => r.kind === 'nonsense' && r.status === 'personal').length },
  falseAutomaticMatches: falseAuto.length,
  guardDowngrades: results.filter(r => r.guard && r.guard !== 'unknownId').length,
  modelCalls: modelCalls.length, tokens, estimatedCostUsd: +cost.toFixed(5),
  perCallAvg: modelCalls.length ? { names: +(modelCalls.reduce((s, c) => s + c.names, 0) / modelCalls.length).toFixed(1), wallMs: Math.round(modelCalls.reduce((s, c) => s + c.wallMs, 0) / modelCalls.length), costUsd: +(cost / modelCalls.length).toFixed(5) } : null,
};
console.log(JSON.stringify(summary, null, 1));
for (const r of falseAuto) console.log(`FALSE AUTO  ${r.kind}  "${r.name}" -> ${r.exerciseId} (acceptable: ${r.acceptable.join(',') || '-'})`);
for (const r of same.filter(r => !r.exerciseId)) console.log(`MISSED      "${r.name}" expected ${r.expected} -> ${r.status} [${r.suggestions.join(',')}]${r.guard ? ` guard=${r.guard}` : ''}`);
if (out) writeFileSync(out, JSON.stringify({ summary, calls, results }, null, 1), { mode: 0o600 });
