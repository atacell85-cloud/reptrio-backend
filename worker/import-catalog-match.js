// B57-007: semantic matching of AI-imported exercise names against the ACTIVE Reptrio catalog (302 permanent `ex_` ids).
//
// Pipeline (one import = at most ONE extra model call, batched over the distinct names):
//   1. Distinct source names (an exercise repeated on several days is matched once).
//   2. Deterministic exact step: normalized id / English name / curated alias, unique target only → `matched` (no model).
//   3. One strict-JSON model call for the remaining names with the compact catalog in the (cacheable) developer prefix.
//      The model resolves spelling, Turkish/English, abbreviations and gym slang; it returns a catalog id only for the SAME
//      exercise, otherwise up to three close catalog alternatives.
//   4. Server validation (the model is never trusted on its own): ids must be in the active allowlist; explicit source
//      equipment must fit the catalog entry; incline/decline and single-arm/single-leg must agree on both sides. A failed
//      check turns an automatic match into a suggestion (never into "not understood").
// Result per distinct name: matched (auto) | suggested (user picks catalog / personal) | personal (no usable alternative:
// the app creates a personal card at routine creation). Technical failures throw coded errors; they are never mapped to
// "not understood".
import catalogData from '../data/import-match-catalog.v1.json' with { type: 'json' };

export const IMPORT_MATCH_CATALOG = catalogData;
export const IMPORT_MATCH_MAX_NAMES = 200;
export const IMPORT_MATCH_MAX_SUGGESTIONS = 3;
const NAME_MAX = 160;

export const SOURCE_EQUIPMENT = Object.freeze(['unspecified', 'barbell', 'dumbbell', 'cable', 'machine', 'smith_machine', 'kettlebell',
  'resistance_band', 'bodyweight', 'ez_bar', 'trap_bar', 'plate', 'pull_up_bar', 'bench', 'box', 'stability_ball', 'towel', 'wall',
  'doorway', 'chair', 'cardio_machine']);
export const SOURCE_QUALIFIERS = Object.freeze(['incline', 'decline', 'single_arm', 'single_leg', 'wide_grip', 'close_grip', 'neutral_grip',
  'reverse_grip', 'sumo', 'front', 'seated', 'standing', 'lying']);

// Same normalization as the app's normalizeExerciseQuery (src/exercises.ts): exact keys only, never fuzzy.
export const exactKey = value => String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('tr-TR')
  .replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, ' ').trim();
// Identity of a source name inside one import (Unicode safe, same rule as the app's personalNameKey).
export const nameKey = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');

const EQUIPMENT_OF = {
  Barbell: ['barbell'], Dumbbell: ['dumbbell'], Cable: ['cable'], Machine: ['machine'], Bodyweight: ['bodyweight', 'pull_up_bar'],
  'Resistance Band': ['resistance_band'], Cardio: ['cardio_machine', 'machine'], 'Pull-up Bar': ['pull_up_bar', 'bodyweight'],
  Kettlebell: ['kettlebell'], Plate: ['plate'], Bench: ['bench', 'bodyweight'], Box: ['box', 'bodyweight'], 'Stability Ball': ['stability_ball'],
  Towel: ['towel', 'bodyweight'], Wall: ['wall', 'bodyweight'], Doorway: ['doorway', 'bodyweight'], Chair: ['chair', 'bodyweight'],
};
export function catalogEquipment(entry) {
  const name = String(entry.name || '').toLowerCase();
  if (/\bez[- ]?bar\b/.test(name)) return new Set(['ez_bar']);
  if (/\b(trap|hex) bar\b/.test(name)) return new Set(['trap_bar']);
  const set = new Set(EQUIPMENT_OF[entry.equipment] || []);
  if (/\bsmith\b/.test(name)) set.add('smith_machine').add('machine');
  if (/\bmachine\b/.test(name)) set.add('machine');
  return set;
}
// Qualifier words on an exactKey-normalized name (lower case, Turkish letters folded: ğ→g, ş→s, ı→i, ö→o, ü→u, ç→c).
// Order matters: "ters egimli" is decline (removed before incline is looked for); "ez bar" / "trap bar" before plain barbell.
const QUALIFIER_WORDS = [
  ['decline', /\b(decline|ters egimli|asagi egimli|negatif egimli)\b/],
  ['incline', /\b(incline|egimli|egik|yukari egimli)\b/],
  ['single_arm', /\b(single|one)[ -]?arm\b|\btek (kol|kolla|kollu|el|elle)\b|\bunilateral\b/],
  ['single_leg', /\b(single|one)[ -]?leg\b|\btek (bacak|bacakla|bacakli|ayak|ayakla|ayakli)\b/],
  ['wide_grip', /\b(wide|genis)\b/],
  ['close_grip', /\b(close|narrow|dar)( grip| tutus| tutuslu)?\b/],
  ['neutral_grip', /\b(neutral|notr)( grip| tutus| tutuslu)?\b|\b(parallel|paralel) (grip|tutus|tutuslu)\b/],
  ['reverse_grip', /\b(reverse grip|underhand|supinated|ters tutus|ters tutuslu|ters el)\b/],
  ['sumo', /\bsumo\b/],
  ['front', /\b(front|onden|on)\b/],
  ['seated', /\b(seated|sitting|oturarak|oturmus|oturur)\b/],
  ['standing', /\b(standing|ayakta)\b/],
  ['lying', /\b(lying|yatarak|yatar|prone|supine|yuzustu|yuz ustu|sirt ustu)\b/],
];
const EQUIPMENT_WORDS = [
  ['ez_bar', /\bez ?bar\b/], ['trap_bar', /\b(trap|hex) ?bar\b/], ['smith_machine', /\bsmith\b/],
  ['kettlebell', /\b(kettlebell|kettle bell|kb)\b/], ['dumbbell', /\b(dumbbell|dumbell|dumbel|dambil|dambel|db)\b/],
  ['barbell', /\b(barbell|halter|bb)\b/], ['plate', /\b(plate|plaka|disk)\b/], ['cable', /\b(cable|kablo|kablolu|makara)\b/], ['resistance_band', /\b(band|banded|lastik|bant)\b/],
  ['machine', /\b(machine|makine|makinesi|makinede|makinada)\b/],
  ['rings', /\b(ring|rings|halka|halkada|jimnastik halkasi)\b/], ['suspension', /\b(trx|suspension|suspansiyon)\b/],
];
function wordsIn(name, table) {
  let text = ` ${exactKey(name)} `;
  const out = new Set();
  for (const [value, pattern] of table) {
    const global = new RegExp(pattern.source, 'g');
    if (global.test(text)) { out.add(value); text = text.replace(new RegExp(pattern.source, 'g'), ' '); }
  }
  return out;
}
// Named variants: a source naming one of these (that the catalog entry's own name does not carry) is a different exercise.
const VARIANT_WORDS = [
  ['pendulum', /\bpendulum\b/], ['zercher', /\bzercher\b/], ['jefferson', /\bjefferson\b/], ['floor_press', /\b(floor|yerde) press\b/],
  ['pullover', /\bpull ?over\b/], ['behind_neck', /\b(behind (the )?neck|ense arkasi|enseden)\b/], ['z_press', /\bz press\b/],
  ['box', /\b(box|kutu)\b/], ['pause', /\b(pause|paused|duraklamali|beklemeli)\b/], ['deficit', /\bdeficit\b/], ['pin', /\bpin\b/],
  ['spoto', /\bspoto\b/], ['larsen', /\blarsen\b/], ['cambered', /\bcambered\b/], ['safety_bar', /\b(safety (squat )?bar|ssb)\b/],
  ['guillotine', /\bguillotine\b/], ['svend', /\bsvend\b/], ['landmine', /\blandmine\b/], ['meadows', /\bmeadows\b/],
  ['kroc', /\bkroc\b/], ['seal', /\bseal\b/], ['spider', /\bspider\b/], ['drag', /\bdrag\b/], ['bayesian', /\bbayesian\b/],
  ['cuban', /\bcuban\b/], ['snatch_grip', /\bsnatch( grip)?\b/], ['jerk', /\bjerk\b/], ['zottman', /\bzottman\b/], ['yates', /\byates\b/],
  ['low_to_high', /\b(low to high|alttan yukari)\b/], ['high_to_low', /\b(high to low|ustten asagi)\b/], ['feet_elevated', /\b(feet elevated|ayaklar yukarida|ayak yukseltilmis)\b/], ['jm', /\bjm press\b/], ['tate', /\btate press\b/], ['hatfield', /\bhatfield\b/], ['anderson', /\banderson\b/],
];
const nameVariants = name => wordsIn(name, VARIANT_WORDS);
/** Qualifiers spelled out in a name (source text or catalog name), parsed without the model. */
export const nameQualifiers = name => wordsIn(name, QUALIFIER_WORDS);
/** Equipment spelled out in a source name, parsed without the model. */
export const nameEquipment = name => wordsIn(name, EQUIPMENT_WORDS);
export function catalogQualifiers(entry) { return nameQualifiers(entry.name); }
// What a catalog name implies for a source that spells it out (a chin-up is underhand, a hammer curl neutral, a preacher curl seated).
const IMPLIED = [[/\bchin ?up\b/, 'reverse_grip'], [/\bhammer\b/, 'neutral_grip'], [/\bpreacher\b/, 'seated']];
function impliedQualifiers(entry) {
  const out = catalogQualifiers(entry);
  const name = exactKey(entry.name);
  for (const [pattern, q] of IMPLIED) if (pattern.test(name)) out.add(q);
  return out;
}

/**
 * Why an automatic match is refused (null = the deterministic checks agree). Source equipment/qualifiers are the union of what the
 * model reported AND what the source text itself spells out (parsed here, independent of the model). Written source equipment must
 * fit the entry; a qualifier written in the source must exist in the entry; a qualifier in the catalog name must be written in the
 * source (a generic name never takes a specific variant).
 */
export function guardRefusal(entry, sourceEquipment, sourceQualifiers, sourceText = '', catalog = IMPORT_MATCH_CATALOG) {
  const equipment = new Set([...(sourceEquipment && sourceEquipment !== 'unspecified' ? [sourceEquipment] : []), ...nameEquipment(sourceText)]);
  const allowed = catalogEquipment(entry);
  for (const e of equipment) {
    if (allowed.has(e)) continue;
    // A cable station is commonly called a machine ("lat pulldown makinesi"), unless a real machine entry of that movement exists.
    if (e === 'machine' && entry.equipment === 'Cable' && !siblings(entry, catalog).some(other => other.equipment === 'Machine')) continue;
    return 'equipment';
  }
  const source = new Set([...(sourceQualifiers || []).filter(q => SOURCE_QUALIFIERS.includes(q)), ...nameQualifiers(sourceText)]);
  const target = catalogQualifiers(entry);
  const implied = impliedQualifiers(entry);
  // Angle, one side, grip, sumo, front: a different exercise whenever the two sides disagree.
  for (const q of STRICT_QUALIFIERS) {
    if (source.has(q) && !implied.has(q)) return 'variant';
    if (target.has(q) && !source.has(q)) return 'variant';
  }
  // Seated / standing / lying: opposite positions never match; a missing position on one side only matters when the catalog
  // separates the movement by exactly that position (another entry of the same movement and equipment differs only by it).
  const sourcePos = POSITIONS.filter(q => source.has(q)), targetPos = POSITIONS.filter(q => implied.has(q));
  if (sourcePos.length && targetPos.length && !sourcePos.some(q => targetPos.includes(q))) return 'variant';
  const quals = other => [...catalogQualifiers(other)].sort().join(',');
  const withPos = (set, p) => [...[...set].filter(x => !POSITIONS.includes(x)), ...(p ? [p] : [])].sort().join(',');
  const fits = (other, kinds) => [...catalogEquipment(other)].some(e => kinds.has(e));
  // Source names a position the entry lacks: refused when the catalog splits this movement by position (any equipment the
  // source could mean: "Seated calf raise" ≠ the bodyweight Calf Raise because a Seated Calf Raise exists).
  if (sourcePos.length && !targetPos.length) {
    const pool = siblings(entry, catalog).filter(other => !equipment.size || fits(other, equipment));
    if (pool.some(other => POSITIONS.some(p => quals(other) === withPos(target, p)))) return 'variant';
  }
  // Entry carries a position the source does not name: refused when the same movement on the same equipment also exists
  // without it or with another position ("Calf raise" ≠ Standing Calf Raise; "Cable row" = the only two-arm Seated Cable Row).
  if (targetPos.length && !sourcePos.length) {
    const kinds = equipment.size ? equipment : catalogEquipment(entry);
    const pool = siblings(entry, catalog).filter(other => fits(other, kinds));
    if (pool.some(other => [null, ...POSITIONS].some(p => !targetPos.includes(p) && quals(other) === withPos(target, p)))) return 'variant';
  }
  const targetVariants = nameVariants(entry.name);
  for (const v of nameVariants(sourceText)) if (!targetVariants.has(v)) return 'variant';
  return null;
}
const STRICT_QUALIFIERS = ['incline', 'decline', 'single_arm', 'single_leg', 'wide_grip', 'close_grip', 'neutral_grip', 'reverse_grip', 'sumo', 'front'];
const POSITIONS = ['seated', 'standing', 'lying'];
// The movement of a catalog name without equipment, qualifier and named-variant words ("Seated Cable Row" and "Machine Row" → "row").
const STRIP = [...QUALIFIER_WORDS, ...EQUIPMENT_WORDS].map(([, pattern]) => new RegExp(pattern.source, 'g'));
export function movementKey(name) {
  let text = ` ${exactKey(name)} `;
  for (const pattern of STRIP) text = text.replace(pattern, ' ');
  return text.replace(/\b(cable|machine|barbell|dumbbell|banded|smith)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
const siblingMemo = new WeakMap();
function siblings(entry, catalog) {
  let byKey = siblingMemo.get(catalog);
  if (!byKey) {
    byKey = new Map();
    for (const other of catalog.exercises) { const key = movementKey(other.name); if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(other); }
    siblingMemo.set(catalog, byKey);
  }
  return (byKey.get(movementKey(entry.name)) || []).filter(other => other.id !== entry.id);
}

export function catalogIndex(catalog = IMPORT_MATCH_CATALOG) {
  const byId = new Map(catalog.exercises.map(entry => [entry.id, entry]));
  const exact = new Map();
  for (const entry of catalog.exercises) for (const value of [entry.id, entry.name, ...(entry.aliases || [])]) {
    const key = exactKey(value);
    if (!key) continue;
    if (!exact.has(key)) exact.set(key, new Set());
    exact.get(key).add(entry.id);
  }
  return { byId, exact, revision: catalog.revision };
}

/** Distinct exercise names of a stored preview, in first-seen order. */
export function previewNames(preview) {
  const seen = new Map();
  for (const day of preview?.program?.days || []) for (const section of day.sections || []) for (const item of section.items || []) {
    if (item?.itemType !== 'exercise') continue;
    const name = String(item.sourceExerciseName || item.normalizedExerciseName || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    const normalized = String(item.normalizedExerciseName || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    const key = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.set(key, { key, sourceName: name, normalizedName: normalized && normalized !== name ? normalized : null });
  }
  return [...seen.values()];
}

export function exactMatch(index, entry) {
  for (const value of [entry.sourceName, entry.normalizedName]) {
    const ids = index.exact.get(exactKey(value));
    if (ids?.size === 1) return [...ids][0];
  }
  return null;
}

function catalogLines(catalog) {
  return catalog.exercises.map(e => [e.id, e.name, e.equipment || '-', (e.primary || []).join('/') || '-', (e.aliases || []).join('; ')].join(' | ')).join('\n');
}
export function matchPrompt(catalog = IMPORT_MATCH_CATALOG) {
  return `You map exercise names from a user's uploaded workout program to the Reptrio exercise catalog.
Matching to the catalog is the main goal: a well-known exercise that exists in the catalog must get its catalog id, whatever
the language (Turkish or English), spelling mistakes, abbreviations (DB, BB, OHP, RDL...), word order, plural or gym slang.

For every input name return one result with the same index:
- understood: true when the text names a recognizable exercise or activity in any language, false only for text that is not an
  exercise at all (gibberish, symbols, a program or day title, a code).
- interpretation: the standard English exercise name you understood (empty string when not understood). Never invent an exercise.
- sourceEquipment: equipment WRITTEN in the name, else "unspecified". Turkish: dambıl/dumbell = dumbbell, halter/bar = barbell,
  kablo/kablolu/makara = cable, makine/makinesi/machine = machine, smith = smith_machine, lastik/bant = resistance_band,
  ez bar = ez_bar, trap bar/hex bar = trap_bar, vücut ağırlığı = bodyweight.
- sourceQualifiers: only words WRITTEN in the name: incline (incline, eğimli, eğik, yukarı eğimli), decline (decline, aşağı eğimli,
  ters eğimli), single_arm (single arm, one arm, tek kol, tek kollu), single_leg (single leg, one leg, tek bacak, tek bacaklı).
- sameExerciseId: the catalog id of the SAME exercise, else null. Same exercise = same movement pattern, same equipment, same
  bench angle, same grip/stance variant, same one-sided or two-sided execution. A generic name matches the catalog entry that
  carries that generic name (e.g. "bench press" = "Bench Press", "lat pulldown" = "Lat Pulldown", "squat" = "Squat").
  If the catalog only holds DIFFERENT or MORE SPECIFIC variants (another equipment, angle, grip, stance, seated vs standing,
  unilateral vs bilateral), do not pick one: sameExerciseId null.
- suggestionIds: when sameExerciseId is null and the exercise is understood, up to 3 closest catalog alternatives (best first),
  for example the same movement with other equipment or angle. Empty when sameExerciseId is set or nothing is reasonably close.
Only ids from the catalog below are valid. Output JSON only.

Catalog (id | name | equipment | primary muscles | aliases):
${catalogLines(catalog)}`;
}

const nullable = type => ({ type: [type, 'null'] });
export const matchSchema = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['index', 'understood', 'interpretation', 'sourceEquipment', 'sourceQualifiers', 'sameExerciseId', 'suggestionIds'],
    properties: {
      index: { type: 'integer' }, understood: { type: 'boolean' }, interpretation: { type: 'string' },
      sourceEquipment: { type: 'string', enum: SOURCE_EQUIPMENT },
      sourceQualifiers: { type: 'array', items: { type: 'string', enum: SOURCE_QUALIFIERS } },
      sameExerciseId: nullable('string'), suggestionIds: { type: 'array', items: { type: 'string' } },
    },
  } } },
};

export function matchRequestBody(model, names, requestId, catalog = IMPORT_MATCH_CATALOG) {
  const input = names.map((entry, index) => ({ index, name: entry.sourceName, ...(entry.normalizedName ? { cleanedName: entry.normalizedName } : {}) }));
  // Synchronous and NOT stored upstream (store:false): nothing is left at the provider to delete with the account.
  return {
    model, temperature: 0, store: false, metadata: { import_match_request_id: requestId },
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: matchPrompt(catalog) }] },
      { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ names: input }) }] },
    ],
    text: { format: { type: 'json_schema', name: 'import_catalog_match_v1', strict: true, schema: matchSchema } },
  };
}

/** Validates one model row against the allowlist and the deterministic guards. */
export function validateModelRow(index, entry, row) {
  const valid = id => typeof id === 'string' && index.byId.has(id);
  const understood = row?.understood === true;
  const equipment = SOURCE_EQUIPMENT.includes(row?.sourceEquipment) ? row.sourceEquipment : 'unspecified';
  const qualifiers = Array.isArray(row?.sourceQualifiers) ? row.sourceQualifiers.filter(q => SOURCE_QUALIFIERS.includes(q)) : [];
  let suggestions = Array.from(new Set((Array.isArray(row?.suggestionIds) ? row.suggestionIds : []).filter(valid)));
  const proposed = valid(row?.sameExerciseId) ? row.sameExerciseId : null;
  let guard = null;
  if (proposed) {
    guard = guardRefusal(index.byId.get(proposed), equipment, qualifiers, [entry.sourceName, entry.normalizedName].filter(Boolean).join(' '));
    if (!guard) return { key: entry.key, sourceName: entry.sourceName, status: 'matched', method: 'ai', exerciseId: proposed, suggestions: [], understood: true, guard: null };
    suggestions = [proposed, ...suggestions.filter(id => id !== proposed)];
  } else if (row?.sameExerciseId != null) guard = 'unknownId';
  suggestions = suggestions.slice(0, IMPORT_MATCH_MAX_SUGGESTIONS);
  return {
    key: entry.key, sourceName: entry.sourceName, status: suggestions.length ? 'suggested' : 'personal', method: 'ai', exerciseId: null,
    suggestions, understood: understood || Boolean(proposed), guard,
  };
}

/**
 * Matches every distinct exercise name of a preview. `callModel(body)` returns `{ payload, upstream }` of a Responses API call
 * (or throws a coded error). Returns the `catalogMatching` object stored on the preview.
 */
export async function matchImportPreview({ preview, model, requestId, callModel, catalog = IMPORT_MATCH_CATALOG, now = () => new Date().toISOString() }) {
  const index = catalogIndex(catalog);
  const names = previewNames(preview);
  if (names.length > IMPORT_MATCH_MAX_NAMES) throw Object.assign(new Error('IMPORT_MATCH_TOO_MANY_NAMES'), { code: 'IMPORT_MATCH_TOO_MANY_NAMES' });
  const results = new Map();
  const pending = [];
  for (const entry of names) {
    const id = exactMatch(index, entry);
    if (id) results.set(entry.key, { key: entry.key, sourceName: entry.sourceName, status: 'matched', method: 'exact', exerciseId: id, suggestions: [], understood: true, guard: null });
    else pending.push(entry);
  }
  let usage = null, modelName = null, durationMs = 0;
  if (pending.length) {
    const started = Date.now();
    const { payload } = await callModel(matchRequestBody(model, pending, requestId, catalog));
    durationMs = Date.now() - started;
    let parsed;
    try { parsed = JSON.parse(outputText(payload)); } catch { throw Object.assign(new Error('IMPORT_MATCH_INVALID_RESPONSE'), { code: 'IMPORT_MATCH_INVALID_RESPONSE' }); }
    const rows = new Map();
    for (const row of Array.isArray(parsed?.results) ? parsed.results : []) if (Number.isInteger(row?.index) && !rows.has(row.index)) rows.set(row.index, row);
    // A missing row is a technical failure of this call, not "not understood".
    if (pending.some((_, i) => !rows.has(i))) throw Object.assign(new Error('IMPORT_MATCH_INCOMPLETE'), { code: 'IMPORT_MATCH_INCOMPLETE' });
    pending.forEach((entry, i) => results.set(entry.key, validateModelRow(index, entry, rows.get(i))));
    usage = payload?.usage ? { inputTokens: payload.usage.input_tokens ?? null, cachedInputTokens: payload.usage.input_tokens_details?.cached_tokens ?? null, outputTokens: payload.usage.output_tokens ?? null } : null;
    modelName = payload?.model || model;
  }
  const ordered = names.map(entry => results.get(entry.key));
  const count = status => ordered.filter(r => r.status === status).length;
  return {
    version: 1, status: 'done', catalogRevision: catalog.revision, matchedAt: now(), model: modelName, modelCalls: pending.length ? 1 : 0,
    summary: { names: ordered.length, exact: ordered.filter(r => r.method === 'exact').length, matched: count('matched'), suggested: count('suggested'), personal: count('personal') },
    usage, durationMs, results: ordered,
  };
}

function outputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  for (const item of payload?.output || []) for (const content of item?.content || []) {
    if ((content.type === 'output_text' || content.type === 'text') && typeof content.text === 'string' && content.text.trim()) return content.text;
  }
  throw Object.assign(new Error('IMPORT_MATCH_INVALID_RESPONSE'), { code: 'IMPORT_MATCH_INVALID_RESPONSE' });
}
