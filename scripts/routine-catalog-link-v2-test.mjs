import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePortableRoot } from '../worker/personal-backup-contract.js';
import { validatePortableRootV2 } from '../worker/personal-backup-v2-contract.js';

const source=JSON.parse(readFileSync(new URL('../tests/fixtures/personal-backup-v1-golden.json',import.meta.url),'utf8'));
const root=structuredClone(source.roots.find(root=>root.kind==='program'));
assert.ok(root?.record?.days?.[0]?.sections?.[0]?.items?.[0]);
const entry=root.record.days[0].sections[0].items[0];
const journal={
  originalExerciseId:'custom:name:row-123',originalDisplayName:'Row',originalCustomExerciseName:'Row',
  catalogId:'ex_000166',catalogName:'Lat Pulldown',
  changes:[{sessionId:'session-A',groupKey:'row-A',storageKey:'1',
    hadCanonicalExerciseId:true,beforeCanonicalExerciseId:'custom:name:row-123',
    hadExerciseName:true,beforeExerciseName:'Row'}],
};
entry.catalogLink=journal;
assert.throws(()=>validatePortableRoot(structuredClone(root)),e=>e.code==='RESTORE_UNSUPPORTED_PERSONAL_FIELD','V1 remains frozen');
const valid=validatePortableRootV2(structuredClone(root));
assert.deepEqual(valid.record.days[0].sections[0].items[0].catalogLink,journal,'V2 preserves the undo journal');
const copy=structuredClone(root);
copy.record.days[0].sections[0].items[0].catalogLink.changes[0].sessionId='other';
copy.record.days[0].sections[0].items[0].catalogLink.changes.push({...copy.record.days[0].sections[0].items[0].catalogLink.changes[0]});
assert.throws(()=>validatePortableRootV2(copy),e=>e.code==='RESTORE_DUPLICATE_ID');
const bad=structuredClone(root);
bad.record.days[0].sections[0].items[0].catalogLink.secret='x';
assert.throws(()=>validatePortableRootV2(bad),e=>e.code==='RESTORE_UNSUPPORTED_PERSONAL_FIELD');
const zero=structuredClone(root);
delete zero.record.days[0].sections[0].items[0].catalogLink;
assert.deepEqual(validatePortableRootV2(zero),validatePortableRoot(zero),'old V1 program accepted unchanged in V2');

// Build47 gym and dated-body additions are V2-only. Frozen V1 rejects them;
// V2 validates and preserves them without losing account/history identity.
const gymRoot=structuredClone(source.roots.find(row=>row.kind==='settings'));
gymRoot.record.gyms[0].googlePlaceId='google-place-123';
gymRoot.record.gyms[0].archivedAt='2026-10-19T12:00:00Z';
assert.throws(()=>validatePortableRoot(structuredClone(gymRoot)),e=>e.code==='RESTORE_UNSUPPORTED_PERSONAL_FIELD');
assert.deepEqual(validatePortableRootV2(structuredClone(gymRoot)).record.gyms,gymRoot.record.gyms);
const badGym=structuredClone(gymRoot);badGym.record.gyms[0].googlePlaceId=73;
assert.throws(()=>validatePortableRootV2(badGym),e=>e.code==='RESTORE_TYPE_MISMATCH');
const bodyRoot=structuredClone(source.roots.find(row=>row.kind==='measurement'));
bodyRoot.record.neckCm=39.5;
bodyRoot.record.extraCm=[{id:'wrist',label:'Wrist',cm:17.2}];
bodyRoot.record.profileAtRecord={heightCm:180,gender:'male',birthYear:1985};
bodyRoot.record.derived={version:1,bmi:25.4,waistToHeight:null,waistToHip:null,
  navyBodyFatPercent:null,bodyFatBasis:null,fatMassKg:null,leanMassKg:null,ffmi:null,estimatedRestingKcal:null};
assert.throws(()=>validatePortableRoot(structuredClone(bodyRoot)),e=>e.code==='RESTORE_UNSUPPORTED_PERSONAL_FIELD');
assert.deepEqual(validatePortableRootV2(structuredClone(bodyRoot)).record,bodyRoot.record);
const invalidBody=structuredClone(bodyRoot);invalidBody.record.extraCm[0].cm='x';
assert.throws(()=>validatePortableRootV2(invalidBody),e=>e.code==='RESTORE_TYPE_MISMATCH');
console.log('PASS: V2-only catalog reclassification journals, validation, legacy V1 frozen and undo provenance preserved.');
