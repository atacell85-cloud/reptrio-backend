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
console.log('PASS: V2-only catalog reclassification journals, validation, legacy V1 frozen and undo provenance preserved.');
