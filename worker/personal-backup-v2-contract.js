import { WIRE_RULES, validatePortableRoot, portableFail as fail, object, own } from './personal-backup-contract.js';
export const PROFILE_V2_RULES = Object.freeze({ version: 2, initialMeasurementId: 'reptrio:onboarding:initial-weight:v1', fields: { goal: ['muscle_gain','fat_loss','strength','general_fitness'], experience: ['beginner','intermediate','advanced'], weeklyDays: 'integer:1..7', gender: ['female','male','undisclosed'], heightCm: 'positive-finite', birthYear: 'positive-integer', onboarding: { version: 1, step: 'integer:0..8', startedAt: 'timestamp', completedAt: 'nullable-timestamp', initialWeight: { id: 'reptrio:onboarding:initial-weight:v1', recordedAt: 'timestamp', weightKg: 'positive-finite' } } } });
const extensions = Object.keys(PROFILE_V2_RULES.fields);
const timestamp = v => { if(typeof v !== 'string' || !Number.isFinite(Date.parse(v)))fail('INVALID_TIME'); };
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
function exact(v,allowed){if(!object(v))fail('TYPE_MISMATCH');for(const k of Object.keys(v)){if(WIRE_RULES.recognizedCredentialKeys.includes(k))fail('SECRET_FIELD');if(!allowed.includes(k))fail('UNSUPPORTED_PERSONAL_FIELD');}if(allowed.some(k=>!own(v,k)))fail('MISSING_FIELD');}
export function validateProfileExtensions(profile){
 const out={};
 for(const k of extensions){if(!own(profile,k))continue;const v=profile[k];
  if(k==='onboarding'){
   exact(v,['version','step','startedAt','completedAt','initialWeight']);
   if(v.version!==1||!Number.isInteger(v.step)||v.step<0||v.step>8||(v.step===8)!==(v.completedAt!==null))fail('INVALID_ONBOARDING');
   timestamp(v.startedAt);if(v.completedAt!==null)timestamp(v.completedAt);
   if(v.initialWeight!==null){exact(v.initialWeight,['id','recordedAt','weightKg']);if(v.initialWeight.id!==PROFILE_V2_RULES.initialMeasurementId||!positive(v.initialWeight.weightKg))fail('INVALID_INITIAL_WEIGHT');timestamp(v.initialWeight.recordedAt);}
  }else if(v!==null){const rule=PROFILE_V2_RULES.fields[k];if(Array.isArray(rule)?!rule.includes(v):k==='weeklyDays'?!Number.isInteger(v)||v<1||v>7:k==='birthYear'?!positive(v)||!Number.isInteger(v):!positive(v))fail('INVALID_PROFILE_ANSWER');}
  out[k]=v;
 }
 return out;
}
// V2-only optional per-routine-item reclassification journal. Immutable V1
// rules/hash are never widened. The authenticated restore still validates every
// ordinary program field through the original portable contract.
function validateCatalogLink(v) {
 exact(v,['originalExerciseId','originalDisplayName','originalCustomExerciseName','catalogId','catalogName','changes']);
 for(const k of ['originalExerciseId','originalDisplayName','originalCustomExerciseName'])
  if(v[k]!==null&&typeof v[k]!=='string')fail('TYPE_MISMATCH');
 if(typeof v.catalogId!=='string'||!/^ex_[0-9]{6}$/.test(v.catalogId)||
    typeof v.catalogName!=='string'||!v.catalogName.trim()||
    !Array.isArray(v.changes)||v.changes.length>10000)fail('TYPE_MISMATCH');
 const seen=new Set();
 for(const c of v.changes){
  exact(c,['sessionId','groupKey','storageKey','hadCanonicalExerciseId','beforeCanonicalExerciseId','hadExerciseName','beforeExerciseName']);
  if(['sessionId','groupKey','storageKey'].some(k=>typeof c[k]!=='string'||!c[k])||
     typeof c.hadCanonicalExerciseId!=='boolean'||typeof c.hadExerciseName!=='boolean'||
     c.beforeCanonicalExerciseId!==null&&typeof c.beforeCanonicalExerciseId!=='string'||
     c.beforeExerciseName!==null&&typeof c.beforeExerciseName!=='string')fail('TYPE_MISMATCH');
  const key=JSON.stringify([c.sessionId,c.groupKey,c.storageKey]);
  if(seen.has(key))fail('DUPLICATE_ID');seen.add(key);
 }
}
// V2-only extensions. Validate each modern field before temporarily removing it
// for the frozen V1 validator; never modify the V1 machine rules.
const optionalBodyFields=['shoulderCm','chestCm','neckCm','hipCm','basenCm','bicepsLeftCm','bicepsRightCm',
'forearmLeftCm','forearmRightCm','thighLeftCm','thighRightCm','calfLeftCm','calfRightCm'];
const metrics=['version','bmi','waistToHeight','waistToHip','navyBodyFatPercent','bodyFatBasis',
'fatMassKg','leanMassKg','ffmi','estimatedRestingKcal'];
const numberOrNull=v=>v===null||typeof v==='number'&&Number.isFinite(v);
const stringOrNull=v=>v===null||typeof v==='string';
// Same bounds as the mobile measurement editor and src/data-export/backup-profile-v2.ts (Build 47 L2): out-of-range or
// unknown values are refused explicitly, never silently dropped.
const cmOrNull=v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=1&&v<=350;
function extractMeasurement(v){
 const ext={};
 for(const k of optionalBodyFields)if(own(v,k)){
  if(!cmOrNull(v[k]))fail('TYPE_MISMATCH');
  ext[k]=v[k];
 }
 if(own(v,'extraCm')){
  if(!Array.isArray(v.extraCm)||v.extraCm.length>16)fail('TYPE_MISMATCH');
  const labels=new Set();
  for(const e of v.extraCm){exact(e,['id','label','cm']);
   if(typeof e.id!=='string'||!e.id||e.id.length>128||typeof e.label!=='string'||!e.label.trim()||e.label!==e.label.trim()||e.label.length>40||!cmOrNull(e.cm)||e.cm===null)fail('TYPE_MISMATCH');
   const label=e.label.toLocaleLowerCase('tr-TR');if(labels.has(label))fail('DUPLICATE_ID');labels.add(label);
  }ext.extraCm=v.extraCm;
 }
 if(own(v,'profileAtRecord')){
  const p=v.profileAtRecord;exact(p,['heightCm','gender','birthYear']);
  if(!(p.heightCm===null||numberOrNull(p.heightCm)&&p.heightCm>=90&&p.heightCm<=250)||![null,'male','female','undisclosed'].includes(p.gender)||!(p.birthYear===null||Number.isInteger(p.birthYear)&&p.birthYear>=1900&&p.birthYear<=2100))fail('TYPE_MISMATCH');
  ext.profileAtRecord=p;
 }
 if(own(v,'derived')){
  const d=v.derived;exact(d,metrics);
  if(d.version!==1||metrics.some(k=>k!=='version'&&k!=='bodyFatBasis'&&!numberOrNull(d[k]))||![null,'measured','estimated'].includes(d.bodyFatBasis))fail('TYPE_MISMATCH');
  ext.derived=d;
 }
 return ext;
}
function extractGyms(gyms){
 if(gyms===undefined)return {stripped:undefined,extras:[]};
 if(!Array.isArray(gyms))fail('TYPE_MISMATCH');
 const extras=[];
 const stripped=gyms.map((g,i)=>{
  if(!object(g))fail('TYPE_MISMATCH');
  const {googlePlaceId,archivedAt,...legacy}=g,extra={};
  if(own(g,'googlePlaceId')){
   if(!stringOrNull(googlePlaceId))fail('TYPE_MISMATCH');extra.googlePlaceId=googlePlaceId;
  }
  if(own(g,'archivedAt')){
   if(archivedAt!==null&&(typeof archivedAt!=='string'||!Number.isFinite(Date.parse(archivedAt))))fail('INVALID_TIME');
   extra.archivedAt=archivedAt;
  }
  extras.push({index:i,extra});return legacy;
 });
 return {stripped,extras};
}
/** V1 validates all remaining domains and unknown fields without widening its frozen dictionary. */
export function validatePortableRootV2(root){
 // Direct codec consumers receive the same non-executing object boundary as routed JSON callers.
 let nodes=0;const seen=new Set();const inspect=(value,depth=0)=>{if(++nodes>200000||depth>32)fail('STRUCTURE_LIMIT',413);if(value===null||typeof value!=='object')return;if(seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('TYPE_MISMATCH');seen.add(value);for(const key of Reflect.ownKeys(value)){if(typeof key!=='string')fail('TYPE_MISMATCH');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d))fail('TYPE_MISMATCH');inspect(d.value,depth+1);}seen.delete(value);};inspect(root);

 if(root?.kind==='program' && Array.isArray(root.record?.days)) {
  const journals=[];
  const stripped={...root,record:{...root.record,days:root.record.days.map((day,di)=>({
   ...day,sections:Array.isArray(day?.sections)?day.sections.map((section,si)=>({
    ...section,items:Array.isArray(section?.items)?section.items.map((item,ei)=>{
     if(!object(item)||!own(item,'catalogLink'))return item;
     validateCatalogLink(item.catalogLink);
     journals.push({di,si,ei,link:item.catalogLink});
     const {catalogLink: _excluded,...ordinary}=item;
     return ordinary;
    }):section.items,
   })):day?.sections,
  }))}};
  const validated=validatePortableRoot(stripped);
  for(const {di,si,ei,link} of journals) validated.record.days[di].sections[si].items[ei].catalogLink=link;
  return validated;
 }
 if(root?.kind==='measurement'&&object(root.record)){
  const extra=extractMeasurement(root.record),ordinary={...root.record};
  for(const k of Object.keys(extra))delete ordinary[k];
  const result=validatePortableRoot({...root,record:ordinary});
  Object.assign(result.record,extra);return result;
 }
 if(root?.kind!=='settings'||!object(root.record))return validatePortableRoot(root);
 const ordinary={...root.record},profile=ordinary.profile;
 const extraProfile=object(profile)?validateProfileExtensions(profile):{};
 if(object(profile)){
  ordinary.profile={...profile};
  for(const k of extensions)delete ordinary.profile[k];
 }
 const gymParts=extractGyms(ordinary.gyms);
 if(ordinary.gyms!==undefined)ordinary.gyms=gymParts.stripped;
 const result=validatePortableRoot({...root,record:ordinary});
 if(object(result.record.profile))Object.assign(result.record.profile,extraProfile);
 for(const {index,extra} of gymParts.extras)Object.assign(result.record.gyms[index],extra);
 return result;
}
export const V2_SETTINGS_FIELDS = {...WIRE_RULES.fields.settings,
 gyms:{array:{...WIRE_RULES.fields.gym,googlePlaceId:'string?~',archivedAt:'date?~'}},profile:{fields:{...WIRE_RULES.fields.settings.profile.fields,goal:'string?~',experience:'string?~',weeklyDays:'number?~',gender:'string?~',heightCm:'number?~',birthYear:'number?~',onboarding:{fields:{version:'number',step:'number',startedAt:'date',completedAt:'date~',initialWeight:{fields:{id:'string',recordedAt:'date',weightKg:'number'}}}}}}};
