// Build 47 H1: account-level, monotonic data-feature guard.
// A Build 46 (or older) client does not know gym googlePlaceId/archivedAt, extended dated body measurements or the
// routine catalogLink Undo journal; its normalization drops them. Once an account holds such data the server refuses
// every write from a client that does not declare the Build 47 data level. The level is derived on the SERVER from the
// stored records (never from the client's claim) and only rises, in the same atomic batch as the revision CAS. A client
// that claims the level but still drops fields remains blocked by the content-based noFieldLoss rules.
import { RECORD_WRITE_GATE_SQL } from './record-sync-storage.js';

export const DATA_FEATURE_LEVEL = 1;
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

export function payloadDataLevel(kind, recordKey, payloadJson) {
  if (typeof payloadJson !== 'string') return 0;
  const has = keys => keys.some(key => payloadJson.includes(token(key)));
  if (has(ANY_KEYS)) return DATA_FEATURE_LEVEL;
  if (kind === 'measurement' && has(MEASUREMENT_KEYS)) return DATA_FEATURE_LEVEL;
  if (kind === 'metadata' && recordKey === SETTINGS_RECORD_KEY && has(SETTINGS_KEYS)) return DATA_FEATURE_LEVEL;
  return 0;
}
export function rowsDataLevel(rows) {
  return rows.some(row => !row.tombstone && payloadDataLevel(row.kind, row.record_key, row.payload_json)) ? DATA_FEATURE_LEVEL : 0;
}
// The same predicate in SQL (instr is case-sensitive, unlike LIKE). `alias` qualifies sync_records columns.
export function dataLevelPredicate(alias = '') {
  const c = column => (alias ? `${alias}.` : '') + column;
  const any = keys => keys.map(key => `instr(${c('payload_json')},'${token(key)}')>0`).join(' OR ');
  return `(${any(ANY_KEYS)} OR (${c('kind')}='measurement' AND (${any(MEASUREMENT_KEYS)})) OR (${c('kind')}='metadata' AND ${c('record_key')}='${SETTINGS_RECORD_KEY}' AND (${any(SETTINGS_KEYS)})))`;
}

// Declared capability of the calling client. Absent, malformed or lower means a pre-Build-47 client.
export function clientDataLevel(request) {
  const value = request?.headers?.get(DATA_LEVEL_HEADER);
  return typeof value === 'string' && /^[1-9][0-9]{0,2}$/.test(value.trim()) ? DATA_FEATURE_LEVEL : 0;
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
  return Number.isSafeInteger(row?.level) && row.level >= DATA_FEATURE_LEVEL ? DATA_FEATURE_LEVEL : 0;
}
export async function accountDataLevel(db, userId) {
  const row = await db.prepare(`SELECT MAX(level) AS level FROM (SELECT level FROM ${DATA_FEATURE_TABLE} WHERE user_id=? UNION ALL SELECT 1 FROM sync_records WHERE user_id=? AND tombstone=0 AND ${dataLevelPredicate()} LIMIT 2)`).bind(userId, userId).first();
  return Number(row?.level) >= DATA_FEATURE_LEVEL ? DATA_FEATURE_LEVEL : 0;
}
// accountLevel: stored or observed level of the account; submittedLevel: level of the data being written.
export function assertClientMayWrite(clientLevel, accountLevel, submittedLevel = 0) {
  if (clientLevel < DATA_FEATURE_LEVEL && (accountLevel >= DATA_FEATURE_LEVEL || submittedLevel >= DATA_FEATURE_LEVEL)) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
}
// Appended LAST to a write batch, after the record statements: it only applies when this batch's CAS installed
// (version, writeToken). `force` records an already observed level; otherwise the rows just written are inspected.
export function raiseDataLevelStatement(db, userId, version, writeToken, stamp, force = false) {
  const observed = force ? '' : ` AND EXISTS(SELECT 1 FROM sync_records r WHERE r.user_id=? AND r.modified_revision=? AND r.tombstone=0 AND ${dataLevelPredicate('r')})`;
  return db.prepare(`INSERT INTO ${DATA_FEATURE_TABLE}(user_id,level,raised_revision,raised_at) SELECT ?,${DATA_FEATURE_LEVEL},?,? WHERE ${RECORD_WRITE_GATE_SQL}${observed} ON CONFLICT(user_id) DO NOTHING`)
    .bind(userId, version, stamp, userId, version, writeToken, ...(force ? [] : [userId, version]));
}
