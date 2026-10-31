// Build 47 H1: account-level, monotonic data-feature guard.
// A Build 46 (or older) client does not know gym googlePlaceId/archivedAt, extended dated body measurements or the
// routine catalogLink Undo journal; its normalization drops them. Once an account holds such data the server refuses
// every write from a client that does not declare the Build 47 data level. The level is derived on the SERVER from the
// stored records (never from the client's claim) and only rises, in the same atomic batch as the revision CAS. A client
// that claims the level but still drops fields remains blocked by the content-based noFieldLoss rules.
// Same text as record-sync-storage.js RECORD_WRITE_GATE_SQL (asserted by data-feature-guard-test); a local
// copy keeps this module free of an import cycle.
export const DATA_LEVEL_WRITE_GATE_SQL = `EXISTS (SELECT 1 FROM sync_account_state s JOIN users u ON u.id = s.user_id WHERE s.user_id = ? AND s.revision = ? AND s.write_token = ? AND s.storage_schema_version = 1 AND s.write_status = 'ACTIVE' AND u.deleted_at IS NULL)`;

// Level 1 = Build 47 data (gym place ids, extended measurements, catalog link journal).
// Level 2 = Build 52 personal exercise cards (root `personalExercises` holding at least one card). A client that does not declare
// the level of the account's data may not write (it would drop or fail to merge the cards); pull stays allowed.
export const DATA_FEATURE_LEVEL = 2;   // the highest level this Worker understands (the level a current client declares)
export const DATA_FEATURE_TABLE = 'sync_account_data_features';
export const DATA_LEVEL_HEADER = 'X-Reptrio-Data-Level';

const MEASUREMENT_KEYS = Object.freeze(['shoulderCm','chestCm','neckCm','hipCm','basenCm','bicepsLeftCm','bicepsRightCm',
  'forearmLeftCm','forearmRightCm','thighLeftCm','thighRightCm','calfLeftCm','calfRightCm','extraCm','profileAtRecord','derived']);
const SETTINGS_KEYS = Object.freeze(['googlePlaceId','archivedAt']);
const ANY_KEYS = Object.freeze(['catalogLink']);
// Stored payloads are compact storageJSON: an object key is always `"name":`. Inside a JSON string the quote before a
// colon is escaped (`\"name\":`), so free text cannot produce this exact byte sequence.
const token = key => `"${key}":`;
const SETTINGS_RECORD_KEY = JSON.stringify(['settings']);
const PERSONAL_RECORD_KEY = JSON.stringify(['personalExercises']);
export const PERSONAL_EXERCISES_LEVEL = 2;

// Level 2: the personalExercises metadata row holds at least one card (a stored card always carries `"id":`; `[]` does not count).
const holdsPersonalCards = (kind, recordKey, payloadJson) => kind === 'metadata' && recordKey === PERSONAL_RECORD_KEY && payloadJson.includes(token('id'));
export function payloadDataLevel(kind, recordKey, payloadJson) {
  if (typeof payloadJson !== 'string') return 0;
  if (holdsPersonalCards(kind, recordKey, payloadJson)) return PERSONAL_EXERCISES_LEVEL;
  const has = keys => keys.some(key => payloadJson.includes(token(key)));
  if (has(ANY_KEYS)) return 1;
  if (kind === 'measurement' && has(MEASUREMENT_KEYS)) return 1;
  if (kind === 'metadata' && recordKey === SETTINGS_RECORD_KEY && has(SETTINGS_KEYS)) return 1;
  return 0;
}
// Highest level among the live rows. A card row can also carry level-1 tokens elsewhere; the maximum is what matters.
export function rowsDataLevel(rows) {
  let level = 0;
  for (const row of rows) if (!row.tombstone) level = Math.max(level, payloadDataLevel(row.kind, row.record_key, row.payload_json));
  return level;
}
// The same predicates in SQL (instr is case-sensitive, unlike LIKE). `alias` qualifies sync_records columns. `level` 1 (default) is
// the Build 47 predicate (unchanged text), level 2 the personal-card row.
export function dataLevelPredicate(alias = '', level = 1) {
  const c = column => (alias ? `${alias}.` : '') + column;
  if (level >= PERSONAL_EXERCISES_LEVEL) return `(${c('kind')}='metadata' AND ${c('record_key')}='${PERSONAL_RECORD_KEY}' AND instr(${c('payload_json')},'${token('id')}')>0)`;
  const any = keys => keys.map(key => `instr(${c('payload_json')},'${token(key)}')>0`).join(' OR ');
  return `(${any(ANY_KEYS)} OR (${c('kind')}='measurement' AND (${any(MEASUREMENT_KEYS)})) OR (${c('kind')}='metadata' AND ${c('record_key')}='${SETTINGS_RECORD_KEY}' AND (${any(SETTINGS_KEYS)})))`;
}
// SQL expression: the data level of a live row (0, 1 or 2).
export const dataLevelCase = (alias = '') => `CASE WHEN ${dataLevelPredicate(alias, 2)} THEN 2 WHEN ${dataLevelPredicate(alias, 1)} THEN 1 ELSE 0 END`;

// Declared capability of the calling client. Absent, malformed or lower means a pre-Build-47 client.
// The declared number, capped at the highest level this Worker knows (a future client declaring 3 is treated as 2).
export function clientDataLevel(request) {
  const value = request?.headers?.get(DATA_LEVEL_HEADER);
  return typeof value === 'string' && /^[1-9][0-9]{0,2}$/.test(value.trim()) ? Math.min(Number(value.trim()), DATA_FEATURE_LEVEL) : 0;
}
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
export function dataFeatureSchemaStatus(tables) {
  const row = tables.find(item => item.type !== 'index' && item.name === DATA_FEATURE_TABLE);
  if (!row) return 'missing';
  return ['user_id','level','raised_revision','raised_at'].every(column => new RegExp(`\\b${column}\\b`).test(row.sql)) ? 'ready' : 'unsupported';
}
// Writers fail closed: without the guard table no write path may run (migration 0016 precedes the Worker deploy).
export function requireDataFeatureSchema(tables) {
  const status = dataFeatureSchemaStatus(tables);
  if (status !== 'ready') fail(status === 'missing' ? 'SYNC_STORAGE_MIGRATION_REQUIRED' : 'SYNC_STORAGE_SCHEMA_UNSUPPORTED', 503);
}
export async function storedDataLevel(db, userId) {
  const row = await db.prepare(`SELECT level FROM ${DATA_FEATURE_TABLE} WHERE user_id=?`).bind(userId).first();
  return Number.isSafeInteger(row?.level) && row.level >= 1 ? Math.min(row.level, DATA_FEATURE_LEVEL) : 0;
}
export async function accountDataLevel(db, userId) {
  const row = await db.prepare(`SELECT MAX(level) AS level FROM (SELECT level FROM ${DATA_FEATURE_TABLE} WHERE user_id=? UNION ALL SELECT 2 WHERE EXISTS(SELECT 1 FROM sync_records WHERE user_id=? AND tombstone=0 AND ${dataLevelPredicate('', 2)}) UNION ALL SELECT 1 WHERE EXISTS(SELECT 1 FROM sync_records WHERE user_id=? AND tombstone=0 AND ${dataLevelPredicate('', 1)}))`).bind(userId, userId, userId).first();
  const level = Number(row?.level);
  return Number.isSafeInteger(level) && level >= 1 ? Math.min(level, DATA_FEATURE_LEVEL) : 0;
}
// accountLevel: stored or observed level of the account; submittedLevel: level of the data being written. A client may write only if
// it declares at least the highest of the two (a level-1 client is refused on an account holding level-2 data; pull stays allowed).
export function assertClientMayWrite(clientLevel, accountLevel, submittedLevel = 0) {
  if (clientLevel < Math.max(accountLevel, submittedLevel)) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
}
// Appended LAST to a write batch, after the record statements: it only applies when this batch's CAS installed
// (version, writeToken). `force` records an already observed level (`level`, 1..DATA_FEATURE_LEVEL); otherwise the level is derived
// in SQL from the rows this revision wrote (2 if one is a personal-card row, else 1; no row, no raise). Monotonic: an existing
// row is only ever raised (the 0016 trigger also forbids a decrease); equal or lower is a no-op.
export function raiseDataLevelStatement(db, userId, version, writeToken, stamp, force = false, level = 1) {
  const upsert = ` ON CONFLICT(user_id) DO UPDATE SET level=excluded.level, raised_revision=excluded.raised_revision, raised_at=excluded.raised_at WHERE excluded.level > ${DATA_FEATURE_TABLE}.level`;
  if (force) {
    const forced = Math.min(Math.max(Number(level) | 0, 1), DATA_FEATURE_LEVEL);
    return db.prepare(`INSERT INTO ${DATA_FEATURE_TABLE}(user_id,level,raised_revision,raised_at) SELECT ?,?,?,? WHERE ${DATA_LEVEL_WRITE_GATE_SQL}${upsert}`)
      .bind(userId, forced, version, stamp, userId, version, writeToken);
  }
  const rows = pred => `EXISTS(SELECT 1 FROM sync_records r WHERE r.user_id=? AND r.modified_revision=? AND r.tombstone=0 AND ${pred})`;
  return db.prepare(`INSERT INTO ${DATA_FEATURE_TABLE}(user_id,level,raised_revision,raised_at) SELECT ?,CASE WHEN ${rows(dataLevelPredicate('r', 2))} THEN 2 ELSE 1 END,?,? WHERE ${DATA_LEVEL_WRITE_GATE_SQL} AND (${rows(dataLevelPredicate('r', 1))} OR ${rows(dataLevelPredicate('r', 2))})${upsert}`)
    .bind(userId, userId, version, version, stamp, userId, version, writeToken, userId, version, userId, version);
}
