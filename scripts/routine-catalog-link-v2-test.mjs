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
// Build 47 L2: bounds identical to the mobile editor and mobile V2 projection; refused explicitly, never trimmed.
const bodyCase=(mutate,code='RESTORE_TYPE_MISMATCH')=>{const root=structuredClone(bodyRoot);mutate(root.record);
 if(code)assert.throws(()=>validatePortableRootV2(root),e=>e.code===code,mutate.toString());else assert.deepEqual(validatePortableRootV2(structuredClone(root)).record,root.record,mutate.toString());};
for(const ok of [r=>{r.neckCm=1;},r=>{r.neckCm=350;},r=>{r.neckCm=null;},r=>{r.extraCm=Array.from({length:16},(_,i)=>({id:'e'+i,label:'Ölçü '+i,cm:10}));},
 r=>{r.profileAtRecord={heightCm:null,gender:'undisclosed',birthYear:null};},r=>{r.profileAtRecord={heightCm:90,gender:'female',birthYear:1900};},r=>{r.derived.bodyFatBasis='estimated';}])bodyCase(ok,null);
for(const bad of [r=>{r.neckCm=0.99;},r=>{r.neckCm=350.01;},r=>{r.hipCm=-1;},r=>{r.extraCm=Array.from({length:17},(_,i)=>({id:'e'+i,label:'L'+i,cm:10}));},
 r=>{r.extraCm[0].label='';},r=>{r.extraCm[0].label=' Wrist';},r=>{r.extraCm[0].label='x'.repeat(41);},r=>{r.extraCm[0].cm=351;},r=>{r.extraCm[0].cm=null;},r=>{r.extraCm[0].id='';},
 r=>{r.profileAtRecord.gender='other';},r=>{r.profileAtRecord.heightCm=89;},r=>{r.profileAtRecord.birthYear=1985.5;},r=>{r.derived.version=2;},r=>{r.derived.bodyFatBasis='guess';},r=>{r.derived.bmi='25';}])bodyCase(bad);
bodyCase(r=>{r.extraCm=[{id:'a',label:'Bilek',cm:17},{id:'b',label:'BİLEK',cm:18}];},'RESTORE_DUPLICATE_ID');
console.log('PASS: V2-only catalog reclassification journals, validation, legacy V1 frozen and undo provenance preserved; Build 47 measurement bounds aligned with mobile.');
