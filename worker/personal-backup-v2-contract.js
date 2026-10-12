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
/** V1 validates all remaining domains and unknown fields without widening its frozen dictionary. */
export function validatePortableRootV2(root){
 // Direct codec consumers receive the same non-executing object boundary as routed JSON callers.
 let nodes=0;const seen=new Set();const inspect=(value,depth=0)=>{if(++nodes>200000||depth>32)fail('STRUCTURE_LIMIT',413);if(value===null||typeof value!=='object')return;if(seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('TYPE_MISMATCH');seen.add(value);for(const key of Reflect.ownKeys(value)){if(typeof key!=='string')fail('TYPE_MISMATCH');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d))fail('TYPE_MISMATCH');inspect(d.value,depth+1);}seen.delete(value);};inspect(root);

 if(root?.kind!=='settings'||!object(root.record?.profile))return validatePortableRoot(root);
 const extension=validateProfileExtensions(root.record.profile),profile={...root.record.profile};for(const k of extensions)delete profile[k];
 const validated=validatePortableRoot({...root,record:{...root.record,profile}});
 Object.assign(validated.record.profile,extension);return validated;
}
export const V2_SETTINGS_FIELDS = {...WIRE_RULES.fields.settings,profile:{fields:{...WIRE_RULES.fields.settings.profile.fields,goal:'string?~',experience:'string?~',weeklyDays:'number?~',gender:'string?~',heightCm:'number?~',birthYear:'number?~',onboarding:{fields:{version:'number',step:'number',startedAt:'date',completedAt:'date~',initialWeight:{fields:{id:'string',recordedAt:'date',weightKg:'number'}}}}}}};
