// The wire AppData remains raw JSON. This adapter owns storage, not client normalization/export projection.
const encoder = new TextEncoder();
export const STORAGE_SCHEMA_VERSION = 1;
export const LIMITS = Object.freeze({ dataBytes: 4_000_000, envelopeBytes: 4_100_000, rowBytes: 1_800_000, chunkBytes: 1_800_000, depth: 64, nodes: 200_000, records: 25_000, queries: 50 });
const collections = Object.freeze(Object.assign(Object.create(null), { programs: 'program', sessions: 'session', measurements: 'measurement' }));
const size = value => encoder.encode(value).byteLength;
const own = (obj, key) => Object.hasOwn(obj, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const rejection = cause => response({ code: cause.code || 'SYNC_STORAGE_UNAVAILABLE' }, cause.status || 503);
const identity = (kind, key) => JSON.stringify([kind, key]);

export async function storageTables(db) {
  return (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('sync_account_state','sync_records','sync_mutation_receipts')").all()).results || [];
}
export function recordSchemaStatus(tables) {
  const rows = tables.filter(row => row.name !== 'sync_mutation_receipts');
  if (!rows?.length) return 'missing';
  const required = { sync_account_state: ['user_id', 'storage_schema_version', 'revision', 'write_token', 'write_status', 'updated_at'], sync_records: ['user_id','kind','record_key','parent_key','ordinal','address_json','payload_json','created_revision','modified_revision','tombstone','deleted_revision'] };
  if (rows.length !== 2 || rows.some(row => required[row.name].some(column => !new RegExp(`\\b${column}\\b`).test(row.sql)))) return 'unsupported';
  return 'ready';
}
export async function storageSchema(db) { return recordSchemaStatus(await storageTables(db)); }
export function receiptSchemaStatus(tables) {
  const row = tables.find(row => row.name === 'sync_mutation_receipts');
  if (!row) return 'missing';
  return ['user_id','mutation_id','request_hash','plan_hash','base_revision','committed_revision','outcome_json','created_at','expires_at'].every(column => new RegExp(`\\b${column}\\b`).test(row.sql)) ? 'ready' : 'unsupported';
}
// Lightweight state only; the internal token never crosses a response boundary.
export async function readRecordState(db,userId,mutationId=undefined) {
  const state = await db.prepare(`SELECT u.deleted_at, s.storage_schema_version, s.revision, s.write_token, s.write_status, s.updated_at,
    COALESCE(s.revision,d.sync_version,0) AS sync_version ${mutationId === undefined ? '' : ',m.request_hash,m.outcome_json,m.expires_at,m.base_revision,m.committed_revision'} FROM users u LEFT JOIN sync_account_state s ON s.user_id=u.id LEFT JOIN user_data d ON d.user_id=u.id ${mutationId === undefined ? '' : 'LEFT JOIN sync_mutation_receipts m ON m.user_id=u.id AND m.mutation_id=?'}
    WHERE u.id=?`).bind(...(mutationId === undefined ? [userId] : [mutationId,userId])).first();
  if (!state || state.deleted_at !== null || (state.write_status && state.write_status !== 'ACTIVE')) fail('SYNC_ACCOUNT_BLOCKED');
  if (state.storage_schema_version !== null && state.storage_schema_version !== STORAGE_SCHEMA_VERSION) fail('SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
  return state;
}

// Account deletion needs only schema/state version before external cleanup, never account payload assembly.
export async function storageCleanupMode(db,userId) {
  const tables = await storageTables(db);
  const readiness = recordSchemaStatus(tables);
  const receipts = receiptSchemaStatus(tables);
  if (receipts === 'unsupported' || (receipts === 'ready' && readiness !== 'ready')) fail('SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
  if (readiness === 'missing') return 'legacy';
  if (readiness !== 'ready') fail('SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
  const state = await db.prepare('SELECT storage_schema_version FROM sync_account_state WHERE user_id = ?').bind(userId).first();
  if (state && state.storage_schema_version !== STORAGE_SCHEMA_VERSION) fail('SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
  return receipts === 'ready' ? 'receipts' : 'records';
}

// One SQL statement observes state and records (or only legacy fallback) in one read snapshot. No account-wide
// JSON aggregate and no fallback once the authority marker exists, including accounts with zero live records.
export async function readRecordSnapshot(db, userId, readiness) {
  if (readiness === 'missing') {
    const row = await db.prepare(`SELECT u.id, d.payload_json, d.sync_version, d.updated_at FROM users u LEFT JOIN user_data d ON d.user_id = u.id WHERE u.id = ? AND u.deleted_at IS NULL`).bind(userId).first();
    if (!row) fail('SYNC_ACCOUNT_BLOCKED');
    return { state: null, rows: [], data: row.payload_json === null ? null : JSON.parse(row.payload_json), syncVersion: row.sync_version ?? 0, updatedAt: row.updated_at };
  }
  if (readiness !== 'ready') fail('SYNC_STORAGE_SCHEMA_UNSUPPORTED', 503);
  const rows = (await db.prepare(`
    SELECT 'record' AS source, s.storage_schema_version, s.revision, s.write_status, s.updated_at,
      r.kind, r.record_key, r.parent_key, r.ordinal, r.address_json, r.payload_json, r.created_revision, r.modified_revision, r.tombstone, r.deleted_revision
    FROM users u JOIN sync_account_state s ON s.user_id = u.id LEFT JOIN sync_records r ON r.user_id = s.user_id
    WHERE u.id = ? AND u.deleted_at IS NULL
    UNION ALL
    SELECT 'legacy', NULL, d.sync_version, NULL, d.updated_at, NULL, NULL, NULL, NULL, NULL, d.payload_json, NULL, NULL, NULL, NULL
    FROM users u LEFT JOIN user_data d ON d.user_id = u.id
    WHERE u.id = ? AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_account_state WHERE user_id = u.id)
  `).bind(userId, userId).all()).results;
  if (!rows?.length) fail('SYNC_ACCOUNT_BLOCKED');
  const first = rows[0];
  if (first.source === 'legacy') return { state: null, rows: [], data: first.payload_json === null ? null : JSON.parse(first.payload_json), syncVersion: first.revision ?? 0, updatedAt: first.updated_at };
  if (first.storage_schema_version !== STORAGE_SCHEMA_VERSION) fail('SYNC_STORAGE_SCHEMA_UNSUPPORTED', 503);
  if (first.write_status !== 'ACTIVE') fail('SYNC_ACCOUNT_BLOCKED');
  const records = rows.filter(row => row.kind !== null);
  return { state: first, rows: records, data: assembleRecordData(records), syncVersion: first.revision, updatedAt: first.updated_at };
}

export async function recordPull(env, userId) {
  try { const result = await readRecordSnapshot(env.DB, userId, await storageSchema(env.DB)); return response({ data: result.data, syncVersion: result.syncVersion, updatedAt: result.updatedAt }); }
  catch (cause) { return rejection(cause); }
}
export async function recordCapabilities(env, userId) {
  try {
    const tables = await storageTables(env.DB); const readiness = recordSchemaStatus(tables);
    const transport = receiptSchemaStatus(tables) === 'ready' && env.RECORD_TRANSPORT_ENABLED !== 'false';
    if (readiness !== 'ready') return response({ storageSchemaVersion: STORAGE_SCHEMA_VERSION, writable: false, recordPaging:false, rootDeltaSync:false, personalRestoreProtocol:false, code: readiness === 'missing' ? 'SYNC_STORAGE_MIGRATION_REQUIRED' : 'SYNC_STORAGE_SCHEMA_UNSUPPORTED' });
    const state = await readRecordState(env.DB,userId); const authority = state.write_token ? 'records' : 'legacy';
    return response({ storageSchemaVersion: STORAGE_SCHEMA_VERSION, writable: true, authority, syncVersion:state.sync_version, recordPaging:transport && authority === 'records', rootDeltaSync:transport && authority === 'records', personalRestoreProtocol:false });
  } catch (cause) { return response({ storageSchemaVersion: STORAGE_SCHEMA_VERSION, writable: false, recordPaging:false,rootDeltaSync:false,personalRestoreProtocol:false,code: cause.code || 'SYNC_STORAGE_UNAVAILABLE' }); }
}

export async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) fail('SYNC_PAYLOAD_INVALID', 400);
  const chunks = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > LIMITS.envelopeBytes) { await reader.cancel(); fail('SYNC_PAYLOAD_INVALID', 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('SYNC_PAYLOAD_INVALID', 400); }
}
export function inspect(value) {
  let nodes = 0; const stack = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('SYNC_STRUCTURE_LIMIT', 413);
    if (item && typeof item === 'object') for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
}
function domainId(item) { if (!object(item) || typeof item.id !== 'string' || !item.id.length) fail('SYNC_RECORD_ID_INVALID', 400); return item.id; }
function row(kind, key, parent, ordinal, address, payload) {
  const result = { kind, record_key: key, parent_key: parent, ordinal, address_json: JSON.stringify(address), payload_json: JSON.stringify(payload) };
  // Conservatively include all text twice plus fixed SQL/value overhead. A legal JSON payload can still exceed
  // D1's per-row budget due to a very long identity/address. Such a plan must not partially commit.
  if (size(JSON.stringify(result)) + 256 > LIMITS.rowBytes) fail('SYNC_RECORD_TOO_LARGE', 413);
  return result;
}
function parentLink(item, field, parent) {
  if (object(item) && own(item,field) && item[field] !== null && item[field] !== parent) fail('SYNC_RECORD_LINK_INVALID',400);
}
function programLinks(program) {
  if (!own(program,'days')) return;
  if (!Array.isArray(program.days)) fail('SYNC_COLLECTION_INVALID',400);
  const seenByKind = new Map();
  const visit = (kind,item) => { const id = domainId(item); if (!seenByKind.has(kind)) seenByKind.set(kind,new Set()); const seen=seenByKind.get(kind); if (seen.has(id)) fail('SYNC_RECORD_ID_DUPLICATE',400); seen.add(id); return id; };
  for (const day of program.days) {
    const dayId=visit('day',day); parentLink(day,'programId',program.id);
    if (!own(day,'sections')) continue; if (!Array.isArray(day.sections)) fail('SYNC_COLLECTION_INVALID',400);
    for (const section of day.sections) {
      const sectionId=visit('section',section); parentLink(section,'workoutDayId',dayId);
      if (!own(section,'items')) continue; if (!Array.isArray(section.items)) fail('SYNC_COLLECTION_INVALID',400);
      for (const exercise of section.items) {
        const exerciseId=visit('exercise',exercise); parentLink(exercise,'sectionId',sectionId);
        if (!own(exercise,'individualSets')) continue; if (!Array.isArray(exercise.individualSets)) fail('SYNC_COLLECTION_INVALID',400);
        // Individual prescriptions remain an opaque ordered payload inside the program; current mobile AI
        // programs legitimately omit prescription IDs. Only an explicitly supplied parent link is checked.
        for (const prescription of exercise.individualSets) parentLink(prescription,'exercisePrescriptionId',exerciseId);
      }
    }
  }
}
export function splitData(data) {
  inspect(data);
  if (!object(data)) fail('SYNC_PAYLOAD_INVALID', 400);
  const result = []; const seen = new Set();
  const add = item => { const key = identity(item.kind, item.record_key); if (seen.has(key)) fail('SYNC_RECORD_ID_DUPLICATE', 400); seen.add(key); result.push(item); if (result.length > LIMITS.records) fail('SYNC_RECORD_LIMIT', 413); };
  Object.entries(data).forEach(([field, value], fieldOrdinal) => {
    const kind = collections[field];
    add(row('metadata', JSON.stringify([field]), null, fieldOrdinal, { field, collection: Boolean(kind) }, kind ? null : value));
    if (!kind) return;
    if (!Array.isArray(value)) fail('SYNC_COLLECTION_INVALID', 400);
    value.forEach((item, ordinal) => {
      const id = domainId(item); const key = JSON.stringify([id]);
      if (kind !== 'session') { if (kind === 'program') programLinks(item); add(row(kind, key, null, ordinal, {}, item)); return; }
      const shell = Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'sets'));
      const descriptor = { fields: Object.keys(item), sets: own(item, 'sets') ? 'present' : 'absent' };
      if (own(item, 'sets')) {
        if (Array.isArray(item.sets)) {
          descriptor.container = 'array'; descriptor.length = item.sets.length;
          const ids = new Set();
          item.sets.forEach((entry, setOrdinal) => {
            const setId = domainId(entry); parentLink(entry,'sessionId',id); if (ids.has(setId)) fail('SYNC_RECORD_ID_DUPLICATE', 400); ids.add(setId);
            add(row('set', JSON.stringify(['pwa-array', id, setId]), key, setOrdinal, { container: 'array', index: setOrdinal }, entry));
          });
        } else if (object(item.sets)) {
          descriptor.container = 'object'; descriptor.groups = [];
          Object.entries(item.sets).forEach(([groupKey, entries]) => {
            if (!object(entries)) fail('SYNC_SET_CONTAINER_UNSUPPORTED', 409);
            const keys = Object.keys(entries); descriptor.groups.push({ key: groupKey, keys });
            keys.forEach((storageKey, setOrdinal) => { parentLink(entries[storageKey],'sessionId',id); add(row('set', JSON.stringify([id, groupKey, storageKey]), key, setOrdinal, { container: 'object', groupKey, storageKey }, entries[storageKey])); });
          });
        } else fail('SYNC_SET_CONTAINER_UNSUPPORTED');
      }
      add(row('session', key, null, ordinal, descriptor, shell));
    });
  });
  return result;
}
export function assembleRecordData(rows) {
  const active = rows.filter(row => !row.tombstone); const data = {};
  const kinds = new Map(); const setsByParent = new Map();
  for (const item of active) {
    if (!kinds.has(item.kind)) kinds.set(item.kind,[]); kinds.get(item.kind).push(item);
    if (item.kind === 'set') { if (!setsByParent.has(item.parent_key)) setsByParent.set(item.parent_key,[]); setsByParent.get(item.parent_key).push(item); }
  }
  for (const items of kinds.values()) items.sort((a,b) => a.ordinal-b.ordinal);
  const byKind = kind => kinds.get(kind) || [];
  for (const record of byKind('metadata')) {
    const address = JSON.parse(record.address_json); const kind = collections[address.field];
    let value = JSON.parse(record.payload_json);
    if (address.collection) {
      value = byKind(kind).map(item => {
        const payload = JSON.parse(item.payload_json);
        if (kind !== 'session') return payload;
        const descriptor = JSON.parse(item.address_json); let sets;
        if (descriptor.sets === 'present') {
          const children = setsByParent.get(item.record_key) || [];
          if (descriptor.container === 'array') sets = children.sort((a,b) => a.ordinal-b.ordinal).map(child => JSON.parse(child.payload_json));
          else {
            sets = Object.fromEntries(descriptor.groups.map(group => [group.key, {}]));
            const childMap = new Map(children.map(child => { const address = JSON.parse(child.address_json); return [JSON.stringify([address.groupKey,address.storageKey]),child]; }));
            for (const group of descriptor.groups) for (const key of group.keys) {
              const child = childMap.get(JSON.stringify([group.key,key])); if (!child) fail('SYNC_STORAGE_CORRUPT',503);
              Object.defineProperty(sets[group.key],key,{value:JSON.parse(child.payload_json),enumerable:true,writable:true,configurable:true});
            }
          }
        }
        return Object.fromEntries(descriptor.fields.map(field => [field, field === 'sets' ? sets : payload[field]]));
      });
    }
    Object.defineProperty(data,address.field,{value,enumerable:true,writable:true,configurable:true});
  }
  return data;
}

// Coverage for explicit operational draft clear, recovered from mobile types/workout-finish and PWA
// normalizeDraft/program-service. This is a deletion-coverage check only, never a storage allowlist.
const scalarFields = names => Object.fromEntries(names.split(' ').map(name => [name,true]));
const setShape = scalarFields('canonicalExerciseId weightUnit id sessionId exerciseId exerciseName setNumber setType weight kg reps rir rpe rest tempo note completed startedAt completedAt updatedAt');
const prescriptionShape = scalarFields('id exercisePrescriptionId setNumber setType reps repsText weight weightUnit weightText rir rirText rpe rpeText restSeconds restText notes');
const exerciseShape = { ...scalarFields('id itemType sectionId exerciseId customExerciseName displayName order sets setsText repsMin repsMax repsText weight weightUnit weightText rir rirText rpe rpeText restSeconds restText tempoText durationSeconds durationText distance distanceUnit distanceText notes groupId groupType text'), individualSets: [prescriptionShape] };
const programShape = { ...scalarFields('schemaVersion id name description sourceType createdAt updatedAt'), days: [{ ...scalarFields('id programId name order notes'), sections: [{ ...scalarFields('id workoutDayId title sectionType order notes'), items: [exerciseShape] }] }] };
const timerShape = scalarFields('exerciseId endsAt notificationId setKey startedAt durationSeconds source notified');
const mobileDraftShape = { ...scalarFields('id programId dayId dayName startedAt lastEditedAt lastActivityAt watchStateRevision gymId excludedFromStats freeWorkout weightUnit'), exercises: [exerciseShape], sets: { '*': { '*': setShape } }, restTimer: timerShape };
const pwaDraftShape = { ...scalarFields('id programId workoutDayId startedAt status'), completedActivities: { '*': true }, sets: { '*': { '*': setShape } }, timer: timerShape };
const mobileSessionShape = { ...scalarFields('id programId dayId workoutDayId title startedAt completedAt updatedAt status gymId excludedFromStats weightUnit'), completedActivities: [true], summary: scalarFields('totalSets completedSets'), sets: { '*': { '*': setShape } } };
const pwaSetShape = scalarFields('id sessionId exerciseId exerciseName setNumber setType weight reps rir completedAt updatedAt');
const pwaSessionShape = { ...scalarFields('id programId workoutDayId startedAt completedAt status'), completedActivities: [true], summary: scalarFields('totalSets completedSets'), sets: [pwaSetShape] };
const measurementShape = scalarFields('id recordedAt weightKg waistCm bodyFatPercent');
// Actual preview producers: Worker responseSchema, local parser/PWA resolution, mobile ImportPreview and
// document-extractor. All nested branches are closed coverage; unknown/any payloads cannot authorize discard.
const sourceReferenceShape = scalarFields('page sheet cellRange text');
const previewPrescriptionShape = { ...scalarFields('sets setsText repsMin repsMax repsText weight weightUnit weightText rir rirText rpe rpeText restSeconds restText tempo tempoText durationSeconds durationText distance distanceUnit distanceText'), individualSets: [prescriptionShape] };
const previewMatchShape = { ...scalarFields('status exerciseId matchedName score'), candidates: [scalarFields('exerciseId name score')] };
const previewItemShape = { ...scalarFields('itemType order sourceExerciseName normalizedExerciseName notes resolutionStatus userEditedExerciseName text'), exerciseMatch: previewMatchShape, prescription: previewPrescriptionShape, sourceReference: sourceReferenceShape };
const previewProgramShape = { ...scalarFields('id name description sourceType notes'), days: [{ ...scalarFields('name order notes'), sourceReference: sourceReferenceShape, sections: [{ ...scalarFields('title sectionType order notes'), sourceReference: sourceReferenceShape, items: [previewItemShape] }] }] };
const normalizedDocumentShape = { ...scalarFields('fileName fileType extractedAt language'), blocks: [{ ...scalarFields('type text name usedRange'), rows: [[true]], sourceReference: sourceReferenceShape }] };
const importPreviewShape = { ...scalarFields('schemaVersion importId importedAt parserStatus errorCode failedAt parserProvider'), source: scalarFields('fileName fileType language documentTitle'), program: previewProgramShape, normalizedDocument: normalizedDocumentShape, warnings: [{ ...scalarFields('code severity message dayOrder sectionOrder exerciseOrder'), sourceReference: sourceReferenceShape }], unparsedContent: [{ ...scalarFields('text reason resolutionStatus'), sourceReference: sourceReferenceShape }] };
function removablePreview(preview,importId) {
  return object(preview) && preview.importId === importId && typeof preview.importedAt === 'string' && object(preview.source) && typeof preview.source.fileName === 'string' && typeof preview.source.fileType === 'string' && object(preview.program) && typeof preview.program.name === 'string' && Array.isArray(preview.program.days) && knownShape(preview,importPreviewShape);
}
function previewState(preview,importId) {
  if (!object(preview) || preview.importId !== importId) return null;
  if (preview.parserStatus === 'pending' || preview.parserStatus === 'failed') return preview.parserStatus;
  if (!own(preview,'parserStatus') && preview.schemaVersion === '1.1' && object(preview.program) && Array.isArray(preview.program.days) && object(preview.source)) return 'ready';
  return null;
}
function allowedOmission(previous,next,key,coverage,context) {
  if (!context) return false;
  const path=context.path;
  if (context.schemaVersion === 8 && path.length === 4 && path[0] === 'draft' && path[1] === 'sets' && key === 'completedAt') return typeof previous.completedAt === 'string' && previous.completed === true && own(next,'completed') && next.completed === false;
  if (path.length === 2 && path[0] === 'importPreviews') {
    const before=previewState(previous,path[1]);const after=previewState(next,path[1]);
    if (key === 'errorCode') return typeof previous[key] === 'string' && (before === 'failed' && (after === 'pending' || after === 'ready') || before === 'pending' && after === 'ready') || previous[key] === null && before === 'pending' && after === 'ready';
    if (typeof previous[key] !== 'string') return false;
    if (key === 'parserStatus') return (before === 'pending' || before === 'failed') && after === 'ready';
    if (key === 'failedAt') return (before === 'pending' || before === 'failed') && after === 'ready';
  }
  if (path.length === 1 && path[0] === 'importPreviews') return removablePreview(previous[key],key);
  if (context.schemaVersion === 5 && path[0] === 'draft') {
    if (path.length === 2 && path[1] === 'completedActivities') return previous[key] === null || typeof previous[key] !== 'object';
    if (path[1] === 'sets' && (path.length === 2 || path.length === 3)) return coverage && own(coverage,'*') && knownShape(previous[key],coverage['*']);
  }
  return context.schemaVersion === 8 && path.length === 1 && path[0] === 'settings' && key === 'heroPreference' && (previous[key] === 'female' || previous[key] === 'male');
}
function knownShape(value, shape) {
  if (value === null) return true;
  if (shape === true) return typeof value !== 'object';
  if (Array.isArray(shape)) return Array.isArray(value) && value.every(item => knownShape(item,shape[0]));
  if (!object(value) || !shape) return false;
  return Object.entries(value).every(([key,item]) => own(shape,key) ? knownShape(item,shape[key]) : own(shape,'*') && knownShape(item,shape['*']));
}
// Unknown nested fields cannot disappear from a surviving object. Known schema 8 permits collection deletion,
// but does not prove future opaque extensions are disposable. Conservative loss rejection keeps those values safe.
function noFieldLoss(previous, next, clearCoverage = null, context = null) {
  const knownNullable = [mobileDraftShape,pwaDraftShape,programShape,timerShape].includes(clearCoverage);
  if (next === null && previous !== null && knownNullable && knownShape(previous,clearCoverage)) return;
  if (object(previous)) {
    if (!object(next)) fail('SYNC_SCHEMA_LOSS_RISK');
    for (const [key,value] of Object.entries(previous)) {
      if (!own(next,key)) { if (allowedOmission(previous,next,key,clearCoverage,context)) continue; fail('SYNC_SCHEMA_LOSS_RISK'); }
      noFieldLoss(value,next[key],clearCoverage && (clearCoverage[key] || clearCoverage['*']),context && { ...context,path:[...context.path,key] });
    }
  } else if (Array.isArray(previous) && Array.isArray(next)) {
    // Match nested domain-id arrays by identity, not position, so normal day/exercise reorder is safe. Deletion of
    // nested objects requires known-schema coverage; callers handle owned collection records separately.
    if (previous.every(item => object(item) && typeof item.id === 'string')) {
      const map = new Map(next.filter(item => object(item)).map(item => [item.id,item]));
      for (const item of previous) {
        if (map.has(item.id)) noFieldLoss(item,map.get(item.id),Array.isArray(clearCoverage) ? clearCoverage[0] : null);
        else if (!Array.isArray(clearCoverage) || !knownShape(item,clearCoverage[0])) fail('SYNC_SCHEMA_LOSS_RISK');
      }
    } else for (let i=0; i<previous.length; i++) if (previous[i] && typeof previous[i] === 'object') {
      const elementCoverage = Array.isArray(clearCoverage) ? clearCoverage[0] : null;
      if (i<next.length) noFieldLoss(previous[i],next[i],elementCoverage);
      else if (!elementCoverage || !knownShape(previous[i],elementCoverage)) fail('SYNC_SCHEMA_LOSS_RISK');
    }
  } else if (previous && typeof previous === 'object' && previous !== next) fail('SYNC_SCHEMA_LOSS_RISK');
}
export function compatible(previous, submitted) {
  if (!previous) return submitted;
  // Preserve omitted top-level fields, including measurements absent from PWA. Explicit null is still presence.
  const next = Object.keys(previous).every(key => own(submitted,key)) ? Object.fromEntries(Object.entries(submitted)) : Object.fromEntries(Object.keys(previous).map(key => [key, own(submitted,key) ? submitted[key] : previous[key]]));
  for (const [key,value] of Object.entries(submitted)) if (!own(next,key)) Object.defineProperty(next,key,{value,enumerable:true,writable:true,configurable:true});
  const schemaVersion = submitted.schemaVersion;
  if (schemaVersion !== 5 && schemaVersion !== 8) {
    if (JSON.stringify(previous) !== JSON.stringify(next)) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
    return next;
  }
  if (schemaVersion === 5 && (previous.schemaVersion !== 5 || (previous.sessions || []).some(session => !Array.isArray(session.sets)))) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
  if (schemaVersion === 5 && own(submitted,'measurements') && JSON.stringify(previous.measurements) !== JSON.stringify(submitted.measurements)) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
  if (schemaVersion === 5 && (previous.programs || []).some(program => program.schemaVersion !== '1.0')) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
  for (const field of Object.keys(collections)) {
    const before = previous[field]; const after = next[field]; if (!Array.isArray(before) || !Array.isArray(after)) continue;
    const map = new Map(after.map(item => [item?.id,item]));
    for (const item of before) {
      if (!map.has(item.id)) {
        const coverage = field === 'programs' ? programShape : field === 'measurements' ? measurementShape : schemaVersion === 8 ? mobileSessionShape : pwaSessionShape;
        if (!knownShape(item,coverage)) fail(schemaVersion === 5 ? 'SYNC_CLIENT_UPGRADE_REQUIRED' : 'SYNC_SCHEMA_LOSS_RISK');
        continue;
      }
      const successor = map.get(item.id);
      if (field === 'sessions') {
        if (own(item,'sets') !== own(successor,'sets') || Array.isArray(item.sets) !== Array.isArray(successor.sets)) fail('SYNC_CLIENT_UPGRADE_REQUIRED');
        noFieldLoss(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'sets')), Object.fromEntries(Object.entries(successor).filter(([key]) => key !== 'sets')));
        if (Array.isArray(item.sets)) {
          const sets = new Map(successor.sets.map(set => [set?.id,set]));
          for (const set of item.sets) {
            if (sets.has(set.id)) noFieldLoss(set,sets.get(set.id));
            else if (!knownShape(set,schemaVersion === 5 ? pwaSetShape : setShape)) fail('SYNC_SCHEMA_LOSS_RISK');
          }
        } else if (object(item.sets) && object(successor.sets)) {
          for (const [group, entries] of Object.entries(item.sets)) for (const [key,value] of Object.entries(entries)) {
            const successorGroup = own(successor.sets,group) ? successor.sets[group] : null;
            if (successorGroup && own(successorGroup,key)) noFieldLoss(value,successorGroup[key]);
            else if (!knownShape(value,setShape)) fail('SYNC_SCHEMA_LOSS_RISK');
          }
        }
      } else noFieldLoss(item,successor,field === 'programs' ? programShape : null);
    }
  }
  for (const field of Object.keys(next)) if (!collections[field] && own(previous,field)) {
    const clearCoverage = field === 'draft' ? (schemaVersion === 8 ? mobileDraftShape : pwaDraftShape) : field === 'programBuilderDraft' ? programShape : field === 'settings' ? { gyms: [scalarFields('id name note')] } : field === 'importHistory' ? [{ ...scalarFields('importId finalProgramId finalizedAt'), source: scalarFields('fileName') }] : null;
    noFieldLoss(previous[field],next[field],clearCoverage,{schemaVersion,path:[field]});
  }
  return next;
}

export function recordChunks(items) {
  const result = []; let current = []; let length = 2;
  for (const item of items) {
    const encoded = JSON.stringify(item); const bytes = size(encoded);
    if (bytes + 2 > LIMITS.chunkBytes) fail('SYNC_RECORD_TOO_LARGE',413);
    if (length + bytes + 1 > LIMITS.chunkBytes) { result.push(JSON.stringify(current)); current = []; length = 2; }
    current.push(item); length += bytes + 1;
  }
  if (current.length) result.push(JSON.stringify(current));
  return result;
}
export const RECORD_WRITE_GATE_SQL = `EXISTS (SELECT 1 FROM sync_account_state s JOIN users u ON u.id = s.user_id WHERE s.user_id = ? AND s.revision = ? AND s.write_token = ? AND s.storage_schema_version = 1 AND s.write_status = 'ACTIVE' AND u.deleted_at IS NULL)`;
export async function recordPush(request, env, userId) {
  try {
    const payload = await boundedBody(request);
    if (!object(payload) || !object(payload.data)) fail('SYNC_PAYLOAD_INVALID',400);
    if (!Number.isSafeInteger(payload.syncVersion) || payload.syncVersion < 0 || payload.syncVersion === Number.MAX_SAFE_INTEGER) fail('SYNC_VERSION_INVALID',400);
    inspect(payload.data);
    if (size(JSON.stringify(payload.data)) > LIMITS.dataBytes) fail('SYNC_PAYLOAD_INVALID',413);
    const readiness = await storageSchema(env.DB);
    if (readiness !== 'ready') fail(readiness === 'missing' ? 'SYNC_STORAGE_MIGRATION_REQUIRED' : 'SYNC_STORAGE_SCHEMA_UNSUPPORTED',503);
    const previous = await readRecordSnapshot(env.DB,userId,readiness);
    if (previous.syncVersion !== payload.syncVersion) fail('SYNC_CONFLICT');
    const data = compatible(previous.data,payload.data);
    if (size(JSON.stringify(data)) > LIMITS.dataBytes) fail('SYNC_PAYLOAD_INVALID',413);
    const records = splitData(data);
    const oldRows = previous.state ? previous.rows : (previous.data ? splitData(previous.data).map(item => ({ ...item, created_revision: payload.syncVersion, modified_revision: payload.syncVersion, tombstone: 0, deleted_revision: null })) : []);
    const old = new Map(oldRows.map(row => [identity(row.kind,row.record_key),row]));
    const next = new Map(records.map(row => [identity(row.kind,row.record_key),row]));
    const version = payload.syncVersion + 1; const token = crypto.randomUUID(); const now = new Date().toISOString();
    const changes = [];
    for (const item of records) {
      const before = old.get(identity(item.kind,item.record_key));
      if (before?.tombstone) fail('SYNC_RECORD_DELETED');
      const changed = !previous.state || !before || ['payload_json','address_json','parent_key','ordinal'].some(field => before[field] !== item[field]);
      if (changed) changes.push({ ...item, created_revision: before?.created_revision ?? version, modified_revision: version, tombstone: 0, deleted_revision: null });
    }
    for (const before of oldRows) if (!before.tombstone && !next.has(identity(before.kind,before.record_key))) changes.push({ ...before, modified_revision: version, tombstone: 1, deleted_revision: version });
    const encodedChunks = recordChunks(changes);
    // Invocation budget: auth (1), schema (1), consistent pre-read (1), CAS (1), changes N, outcome read (1).
    if (encodedChunks.length + 5 > LIMITS.queries) fail('SYNC_QUERY_LIMIT',413);
    const db = env.DB;
    const cas = previous.state
      ? db.prepare(`UPDATE sync_account_state SET revision = ?, write_token = ?, updated_at = ? WHERE user_id = ? AND revision = ? AND storage_schema_version = 1 AND write_status = 'ACTIVE' AND EXISTS (SELECT 1 FROM users WHERE id = sync_account_state.user_id AND deleted_at IS NULL)`).bind(version,token,now,userId,payload.syncVersion)
      : db.prepare(`INSERT INTO sync_account_state (user_id,storage_schema_version,revision,write_token,write_status,updated_at)
          SELECT u.id,1,?,?, 'ACTIVE',? FROM users u WHERE u.id = ? AND u.deleted_at IS NULL
          AND COALESCE((SELECT sync_version FROM user_data WHERE user_id = u.id),0) = ?
          AND NOT EXISTS (SELECT 1 FROM sync_account_state WHERE user_id = u.id)
          ON CONFLICT(user_id) DO NOTHING`).bind(version,token,now,userId,payload.syncVersion);
    const statements = [cas, ...encodedChunks.map(chunk => db.prepare(`INSERT INTO sync_records
        (user_id,kind,record_key,parent_key,ordinal,address_json,payload_json,created_revision,modified_revision,tombstone,deleted_revision)
        SELECT ?, json_extract(value,'$.kind'),json_extract(value,'$.record_key'),json_extract(value,'$.parent_key'),json_extract(value,'$.ordinal'),
          json_extract(value,'$.address_json'),json_extract(value,'$.payload_json'),json_extract(value,'$.created_revision'),json_extract(value,'$.modified_revision'),json_extract(value,'$.tombstone'),json_extract(value,'$.deleted_revision')
        FROM json_each(?) WHERE ${RECORD_WRITE_GATE_SQL}
        ON CONFLICT(user_id,kind,record_key) DO UPDATE SET parent_key = excluded.parent_key, ordinal = excluded.ordinal, address_json = excluded.address_json,
          payload_json = excluded.payload_json, modified_revision = excluded.modified_revision, tombstone = excluded.tombstone, deleted_revision = excluded.deleted_revision
        WHERE sync_records.tombstone = 0`).bind(userId,chunk,userId,version,token))];
    const results = await db.batch(statements);
    if (results[0]?.meta?.changes !== 1) {
      const latest = await db.prepare(`SELECT s.revision, s.write_status, u.deleted_at FROM users u LEFT JOIN sync_account_state s ON s.user_id = u.id WHERE u.id = ?`).bind(userId).first();
      fail(!latest || latest.deleted_at !== null || latest.write_status === 'BLOCKED' ? 'SYNC_ACCOUNT_BLOCKED' : 'SYNC_CONFLICT');
    }
    return response({ ok: true, syncVersion: version, updatedAt: now });
  } catch (cause) { return rejection(cause); }
}
