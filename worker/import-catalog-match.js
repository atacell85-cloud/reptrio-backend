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
export const SOURCE_QUALIFIERS = Object.freeze(['incline', 'decline', 'single_arm', 'single_leg', 'single_side', 'wide_grip', 'close_grip', 'neutral_grip',
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
  // Feet elevated = a decline (push-ups); the named variant word below keeps it apart from the flat movement too.
  ['decline', /\b(decline|ters egimli|asagi egimli|negatif egimli)\b|\b(feet elevated|ayaklar yukarida|ayak yukseltilmis)\b/],
  ['incline', /\b(incline|egimli|egik|yukari egimli)\b/],
  ['single_arm', /\b(single|one)[ -]?arm\b|\btek (kol|kolla|kollu|el|elle)\b/],
  ['single_side', /\b(tek tarafli|tek taraf|unilateral|single side)\b/],
  ['single_leg', /\b(single|one)[ -]?leg\b|\btek (bacak|bacakla|bacakli|ayak|ayakla|ayakli)\b/],
  ['wide_grip', /\b(wide|genis)\b/],
  ['close_grip', /\b(close|narrow|dar)( grip| tutus| tutuslu)?\b|\b(cg|cgbp)\b/],
  ['neutral_grip', /\b(neutral|notr|hammer)( grip| tutus| tutuslu)\b|\b(neutral|notr)\b|\b(parallel|paralel) (grip|tutus|tutuslu)\b/],
  ['reverse_grip', /\b(reverse grip|underhand|supinated|ters tutus\w*|ters el\w*)\b/],
  ['sumo', /\bsumo\b/],
  ['front', /\b(front|onden)\b|\bon (squat|kaldiris|kaldirma|omuz|raise)\b/],
  ['seated', /\b(seated|sitting|oturarak|oturmus|oturur)\b/],
  ['standing', /\b(standing|ayakta)\b/],
  ['lying', /\b(lying|yatarak|yatar|prone|supine|yuzustu|yuz ustu|sirt ustu)\b/],
];
// Turkish stems take their case/possessive suffixes ("dambılla", "kabloyla", "halterli", "lastikli", "plakayla", "makinede").
const EQUIPMENT_WORDS = [
  ['ez_bar', /\bez( ?bar\w*)?\b/], ['trap_bar', /\b(trap|hex) ?bar\w*\b/], ['smith_machine', /\bsmith\w*\b/],
  ['kettlebell', /\b(kettlebell\w*|kettle bell|kb)\b/], ['dumbbell', /\b(dumbbell\w*|dumbell\w*|dumbel\w*|dambil\w*|dambel\w*|db)\b/],
  ['barbell', /\b(barbell\w*|halter\w*|bb)\b/], ['plate', /\b(plate|plates|plaka\w*|disk\w*)\b/],
  ['cable', /\b(cable\w*|kablo\w*|makara\w*|crossover)\b|\bhalat\w*\b(?! salla)|(?<!battle |jump |skipping )\brope\b(?! jump)/], ['resistance_band', /\b(band|bands|banded|lastik\w*|bant\w*)\b/],
  ['machine', /\b(machine\w*|makine\w*|makina\w*)\b/],
  ['rings', /\b(ring|rings|halka\w*)\b/], ['suspension', /\b(trx|suspension|suspansiyon\w*)\b/], ['medicine_ball', /\b(med ball|medicine ball|saglik topu\w*)\b/],
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
  ['cuban', /\bcuban\b/], ['weighted', /\b(weighted|agirlikli|yuklu)\b/],
  // Distinguishing words of catalog entries that also exist in a plainer form (with Turkish equivalents).
  ['walking', /\b(walking|yuruyen|yuruyerek|yurume|yuruyus)\b/], ['diamond', /\b(diamond|elmas)\b/], ['bench_dip', /\bbench dips?\b|\bsehpa\w* dips?\b/],
  ['nordic', /\bnordic\b/], ['kneeling', /\b(kneeling|half kneeling|diz ustu|dizustu|diz cokerek|dizler uzerinde)\b/], ['handstand', /\b(handstand|amut\w*|amuda)\b/],
  ['archer', /\b(archer|okcu)\b/], ['assisted', /\bassisted\b|(?<!gogus |chest )\b(destekli|yardimli)\b/], ['towel', /\b(towel|havlu\w*)\b/], ['negative', /\b(negative|negatif|eccentric|eksantrik)\b/],
  ['pistol', /\bpistol\b/], ['pike', /\bpike\b/], ['sissy', /\bsissy\b/], ['shrimp', /\bshrimp\b/], ['cossack', /\b(cossack|kazak)\b/], ['copenhagen', /\bcopenhagen\b/],
  ['typewriter', /\b(typewriter|daktilo)\b/], ['commando', /\bcommando\b/], ['hindu', /\bhindu\b/], ['explosive', /\b(explosive|patlayici|clap)\b/], ['scapular', /\b(scapular|skapular)\b/],
  ['skater', /\bskater\b/], ['goblet', /\bgoblet\b/], ['hack', /\bhack\b/], ['belt', /\bbelt\b/], ['donkey', /\b(donkey|esek)\b/], ['bulgarian', /\b(bulgarian|bulgar)\b/], ['snatch_grip', /\bsnatch( grip)?\b/], ['jerk', /\bjerk\b/], ['zottman', /\bzottman\b/], ['yates', /\byates\b/],
  ['low_to_high', /\b(low to high|alttan yukari)\b/], ['high_to_low', /\bhigh to low\b/], ['feet_elevated', /\b(feet elevated|ayaklar yukarida|ayak yukseltilmis)\b/], ['jm', /\bjm press\b/], ['tate', /\btate press\b/], ['hatfield', /\bhatfield\b/], ['anderson', /\banderson\b/],
];
const nameVariants = name => wordsIn(name, VARIANT_WORDS);
/** Qualifiers spelled out in a name (source text or catalog name), parsed without the model. */
export const nameQualifiers = name => wordsIn(name, QUALIFIER_WORDS);
/** Equipment spelled out in a source name, parsed without the model. */
export const nameEquipment = name => wordsIn(name, EQUIPMENT_WORDS);
export function catalogQualifiers(entry) { return nameQualifiers(entry.name); }
// What a catalog name implies for a source that spells it out (a chin-up is underhand, a hammer curl neutral, a preacher curl seated).
const IMPLIED = [[/\bchin ?up\b/, 'reverse_grip'], [/\bhammer\b/, 'neutral_grip'], [/\bpreacher\b/, 'seated'], [/\bpulldown\b/, 'front'], [/\bfeet elevated\b/, 'decline'], [/\breverse curl\b/, 'reverse_grip'],
  [/^plank$/, 'front'], [/\bforward lunge\b/, 'front']];
// Named variants a catalog name implies (a decline push-up is done feet elevated; step-ups / step-downs use a box).
const IMPLIED_VARIANTS = [[/\bdecline push ?up\b/, 'feet_elevated'], [/\bstep (up|down)\b/, 'box'], [/\bknee push ?up\b/, 'kneeling']];
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
  // Parsed = what the source TEXT spells out (independent of the model). Forward checks ("the source says X, so the entry must
  // allow X") also use what the model reports; reverse checks ("the entry's name says X, so the source must say X") use ONLY
  // the parsed text — the model cannot vouch for the attributes of its own pick.
  const parsedEquipment = nameEquipment(sourceText);
  // The model's reported equipment / qualifiers are NOT used for refusals: the real-model eval showed them noisy ("lying" for a
  // bench press, "single_arm" for knee push-ups, "barbell" for an EZ bar) and the guards caught the same traps without them.
  void sourceEquipment; void sourceQualifiers;
  const equipment = new Set(parsedEquipment);
  const allowed = catalogEquipment(entry);
  for (const e of equipment) {
    if (allowed.has(e)) continue;
    // A cable station is commonly called a machine ("lat pulldown makinesi"), unless a real machine entry of that movement exists.
    if (e === 'machine' && entry.equipment === 'Cable' && !siblings(entry, catalog).some(other => other.equipment === 'Machine')) continue;
    return 'equipment';
  }
  const parsed = nameQualifiers(sourceText);
  const source = new Set(parsed);
  const target = catalogQualifiers(entry);
  const implied = impliedQualifiers(entry);
  // Angle, one side, grip, sumo, front: a different exercise whenever the two sides disagree.
  // "Tek taraflı" / unilateral names a one-sided exercise without saying arm or leg: it needs a one-sided entry and satisfies it.
  const oneSidedTarget = implied.has('single_arm') || implied.has('single_leg');
  if (source.has('single_side') && !oneSidedTarget) return 'variant';
  for (const q of STRICT_QUALIFIERS) {
    if (source.has(q) && !implied.has(q)) return 'variant';
    if (target.has(q) && !parsed.has(q) && !((q === 'single_arm' || q === 'single_leg') && parsed.has('single_side'))) return 'variant';
  }
  // Seated / standing / lying: opposite positions never match; a missing position on one side only matters when the catalog
  // separates the movement by exactly that position (another entry of the same movement differs only by it).
  const sourcePos = POSITIONS.filter(q => source.has(q)), parsedPos = POSITIONS.filter(q => parsed.has(q)), targetPos = POSITIONS.filter(q => implied.has(q));
  if (parsedPos.length && targetPos.length && !parsedPos.some(q => targetPos.includes(q))) return 'variant';
  if (sourcePos.length && targetPos.length && !sourcePos.some(q => targetPos.includes(q))) return 'variant';
  const quals = other => [...catalogQualifiers(other)].sort().join(',');
  const withPos = (set, p) => [...[...set].filter(x => !POSITIONS.includes(x)), ...(p ? [p] : [])].sort().join(',');
  const fits = (other, kinds) => [...catalogEquipment(other)].some(e => kinds.has(e));
  if (sourcePos.length && !targetPos.length) {
    const pool = siblings(entry, catalog).filter(other => !parsedEquipment.size || fits(other, parsedEquipment));
    if (pool.some(other => POSITIONS.some(p => quals(other) === withPos(target, p)))) return 'variant';
  }
  if (targetPos.length && !parsedPos.length) {
    const kinds = parsedEquipment.size ? parsedEquipment : catalogEquipment(entry);
    const pool = siblings(entry, catalog).filter(other => fits(other, kinds));
    if (pool.some(other => [null, ...POSITIONS].some(p => !targetPos.includes(p) && quals(other) === withPos(target, p)))) return 'variant';
  }
  // Equipment written in the catalog name must be written in the source text when the catalog also holds the same movement with
  // other or no equipment ("Yana açış" is not the Cable/Machine Lateral Raise; "Lat çekiş" is not the Banded Lat Pulldown).
  for (const e of nameEquipment(entry.name)) {
    if (parsedEquipment.has(e) || (e === 'machine' && parsedEquipment.has('smith_machine'))) continue;
    if (siblings(entry, catalog).some(other => !nameEquipment(other.name).has(e))) return 'equipment';
  }
  // Named variants: every variant word of the catalog name must be in the source text (Meadows/Spider/Drag/Deficit/Landmine/Seal/
  // Box/Weighted…), and every variant word of the source must be in the entry (or implied by it). A loaded source ("dumbbell
  // Russian twist", "plate crunch") counts as weighted.
  const sourceVariants = nameVariants(sourceText);
  if (['dumbbell', 'plate', 'kettlebell', 'barbell', 'medicine_ball'].some(e => parsedEquipment.has(e))) sourceVariants.add('weighted');
  const explicitTarget = nameVariants(entry.name);
  for (const v of explicitTarget) if (!sourceVariants.has(v)) return 'variant';
  const targetVariants = new Set(explicitTarget);
  for (const [pattern, v] of IMPLIED_VARIANTS) if (pattern.test(exactKey(entry.name))) targetVariants.add(v);
  for (const v of nameVariants(sourceText)) if (!targetVariants.has(v)) return 'variant';
  // Derived from the catalog itself (no word list): when the source contains a word that the catalog uses to name a MORE
  // SPECIFIC version of the picked entry (an entry containing every word of the pick plus that word), the source means that
  // version, not the plainer pick ("Calf press on leg press" is not Leg Press, because Leg Press Calf Raise exists).
  {
    const targetTokens = new Set(exactKey(entry.name).split(' '));
    const sourceTokens = new Set(exactKey(sourceText).split(' ').filter(t => t.length > 2));
    for (const word of specificWords(entry, catalog)) if (!targetTokens.has(word) && sourceTokens.has(word)) return 'variant';
  }
  // Movement words, derived from the catalog (the last word of every catalog name: squat, row, crunch, press, curl, jack…): a
  // source that names a movement absent from the pick's whole name means another exercise ("Sumo squat" is not Sumo Deadlift,
  // "Seal row" is not Seal Jack). Plurals fold ("crushers" = crusher).
  { const conflict = movementConflict(entry, sourceText, catalog); if (conflict) return conflict; }
  // A rope attachment matters only where the catalog holds a rope version of the picked movement ("Rope pushdown" ≠ Tricep
  // Pushdown because Rope Tricep Pushdown exists; "Rope crunch" = Cable Crunch).
  if (/\b(rope|halat\w*)\b/.test(exactKey(sourceText)) && !/\brope\b/.test(exactKey(entry.name))) {
    const tokens = exactKey(entry.name).split(' ');
    if (catalog.exercises.some(other => other.id !== entry.id && /\brope\b/.test(exactKey(other.name)) && tokens.every(t => exactKey(other.name).split(' ').includes(t)))) return 'variant';
  }
  return null;
}
const STRICT_QUALIFIERS = ['incline', 'decline', 'single_arm', 'single_leg', 'wide_grip', 'close_grip', 'neutral_grip', 'reverse_grip', 'sumo', 'front'];
const POSITIONS = ['seated', 'standing', 'lying'];
// The movement of a catalog name without equipment, qualifier and named-variant words ("Seated Cable Row" and "Machine Row" → "row").
const STRIP = [...QUALIFIER_WORDS, ...EQUIPMENT_WORDS].map(([, pattern]) => new RegExp(pattern.source, 'g'));
export function movementKey(name) {
  let text = ` ${exactKey(name)} `;
  for (const pattern of STRIP) text = text.replace(pattern, ' ');
  return text.replace(/\b(cable|machine|barbell|dumbbell|banded|smith|bench)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
/** A text naming a movement the entry does not carry, for an entry named by a shared movement word (deadlift, jack, row, up…).
 * Uniquely named entries (Pec Deck, Farmer Carry) are left to the model. Plurals fold ("crushers" = crusher). */
export function movementConflict(entry, text, catalog = IMPORT_MATCH_CATALOG) {
  if (!entry || !text) return null;
  const fold = t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
  const targetWords = new Set(exactKey(entry.name).split(' ').map(fold));
  const words = new Set(exactKey(text).split(' ').map(fold));
  const targetMovement = fold(exactKey(entry.name).split(' ').at(-1));
  if (!(movementCount(catalog).get(targetMovement) >= 3) || words.has(targetMovement)) return null;
  for (const word of words) if (movementWords(catalog).has(word) && !targetWords.has(word)) return 'variant';
  return null;
}
const countMemo = new WeakMap();
function movementCount(catalog) {
  let counts = countMemo.get(catalog);
  if (!counts) {
    counts = new Map();
    for (const e of catalog.exercises) { const w = exactKey(e.name).split(' ').at(-1); const f = w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w; counts.set(f, (counts.get(f) || 0) + 1); }
    countMemo.set(catalog, counts);
  }
  return counts;
}
const movementMemo = new WeakMap();
/** The movement word of every catalog name (its last word, plural folded; "up"/"down" of push-up/step-down excluded as too generic). */
function movementWords(catalog) {
  let words = movementMemo.get(catalog);
  if (!words) {
    words = new Set(catalog.exercises.map(e => exactKey(e.name).split(' ').at(-1)).filter(w => w && w.length > 2 && !['up', 'down'].includes(w)));
    movementMemo.set(catalog, words);
  }
  return words;
}
const specificMemo = new WeakMap();
/** Words that turn this entry into a more specific catalog entry (from catalog name containment, e.g. Leg Press → calf, raise). */
function specificWords(entry, catalog) {
  let byId = specificMemo.get(catalog);
  if (!byId) {
    byId = new Map();
    const tokens = new Map(catalog.exercises.map(e => [e.id, exactKey(e.name).split(' ')]));
    for (const e of catalog.exercises) {
      const base = tokens.get(e.id);
      const words = new Set();
      for (const other of catalog.exercises) {
        if (other.id === e.id) continue;
        const ot = tokens.get(other.id);
        if (ot.length > base.length && base.every(t => ot.includes(t))) for (const t of ot) if (!base.includes(t)) words.add(t);
      }
      byId.set(e.id, words);
    }
    specificMemo.set(catalog, byId);
  }
  return byId.get(entry.id) || new Set();
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

// Only the name as written in the file: the extraction model's cleaned spelling is never trusted without the guards.
export function exactMatch(index, entry) {
  for (const value of [entry.sourceName]) {
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
Turkish names often add a verb or noun for doing the exercise (şınav çekme = push-up, barfiks çekme = pull-up, mekik çekme = crunch,
… yapma / atma / hareketi): it never changes which exercise it is.

For every input name return one result with the same index:
- understood: true when the text names a recognizable exercise or activity in any language, false only for text that is not an
  exercise at all (gibberish, symbols, a program or day title, a code).
- interpretation: the standard English exercise name you understood (empty string when not understood). Never invent an exercise.
- sourceEquipment: equipment WRITTEN in the name, else "unspecified". Turkish: dambıl/dumbell = dumbbell, halter/bar = barbell,
  kablo/kablolu/makara = cable, makine/makinesi/machine = machine, smith = smith_machine, lastik/bant = resistance_band,
  ez bar = ez_bar, trap bar/hex bar = trap_bar, vücut ağırlığı = bodyweight.
- sourceQualifiers: only words WRITTEN in the name: incline (incline, eğimli, eğik, yukarı eğimli), decline (decline, aşağı eğimli,
  ters eğimli), single_arm (single arm, one arm, tek kol, tek kollu), single_leg (single leg, one leg, tek bacak, tek bacaklı).
- sameExerciseId: the catalog id of the SAME exercise, else null. Same exercise = same movement (a row stays a row, a squat a
  squat, a crunch a crunch: sharing another word such as "seal", "sumo", "decline" or "box" is not enough), same equipment, same
  bench angle, same grip/stance variant, same one-sided or two-sided execution.
  A generic name ALWAYS takes the catalog entry that carries that generic name, even when more specific variants also exist
  ("bench press"/"düz bench" = "Bench Press", "lat pulldown"/"lat çekiş"/"lat machine" = "Lat Pulldown", "back squat" = "Squat",
  "cable row" = "Seated Cable Row", "Bulgar squat" = "Bulgarian Split Squat"). Return null only when NO entry is that exercise
  without adding or changing equipment, angle, grip, stance, position or side.
  Turkish body words: bacak = leg, diz = knee, kol = arm, ön kol = forearm, omuz = shoulder, göğüs = chest, sırt = back,
  kalça = hip/glute, baldır = calf, karın = abs, arka bacak = hamstring, ön bacak = quadriceps; yerde = on the floor,
  asılı = hanging, sallama = swing/wave, ölü kaldırma = deadlift (romen ölü kaldırma = Romanian deadlift).
- suggestionIds: when sameExerciseId is null and the exercise is understood, up to 3 closest catalog alternatives (best first),
  for example the same movement with other equipment or angle. Empty when sameExerciseId is set or nothing is reasonably close.
Only ids from the catalog below are valid. Output JSON only.

Catalog (id | name | equipment | primary muscles | aliases):
${catalogLines(catalog)}`;
}

const nullable = type => ({ type: [type, 'null'] });
const CATALOG_IDS = IMPORT_MATCH_CATALOG.exercises.map(e => e.id);
export const matchSchema = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['index', 'understood', 'interpretation', 'sourceEquipment', 'sourceQualifiers', 'sameExerciseId', 'suggestionIds'],
    properties: {
      index: { type: 'integer' }, understood: { type: 'boolean' }, interpretation: { type: 'string' },
      sourceEquipment: { type: 'string', enum: SOURCE_EQUIPMENT },
      sourceQualifiers: { type: 'array', items: { type: 'string', enum: SOURCE_QUALIFIERS } },
      // Constrained to the catalog ids (strict structured output): the model cannot return a malformed or invented id. The real
      // eval showed whole calls whose ids were all unusable without this.
      sameExerciseId: { type: ['string', 'null'], enum: [...CATALOG_IDS, null] }, suggestionIds: { type: 'array', items: { type: 'string', enum: CATALOG_IDS } },
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
  // The model's own interpretation (its standard English name for the exercise) is a semantic signal, used two ways:
  // - it left the id empty but named the exercise exactly as a catalog entry ("Lat Pulldown", "Hip Thrust"): that entry is the
  //   pick (the guards on the source text still apply). Real eval 3: 4 such needless confirmations.
  // - its pick does not carry the movement it named ("Barbell Lateral Raise" → Upright Row): refused like a source movement word.
  const interpretation = typeof row?.interpretation === 'string' ? row.interpretation : '';
  const named = interpretation ? index.exact.get(exactKey(interpretation)) : null;
  const proposed = valid(row?.sameExerciseId) ? row.sameExerciseId
    : row?.sameExerciseId == null && understood && named?.size === 1 ? [...named][0] : null;
  let guard = null;
  if (proposed) {
    // Only the name as written in the file: the extraction model's cleaned spelling cannot vouch for the pick.
    guard = guardRefusal(index.byId.get(proposed), equipment, qualifiers, entry.sourceName)
      || movementConflict(index.byId.get(proposed), interpretation, IMPORT_MATCH_CATALOG);
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
