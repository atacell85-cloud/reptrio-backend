import { WIRE_RULES, portableFail as fail, object, own, exactFields } from './personal-backup-contract.js';
import { validatePortableRootV2 } from './personal-backup-v2-contract.js';
// B52-002 S3: V3 = V2 content + the new portable root kind `personalExercise` ({kind,record:<stored S1 card>}). V1 WIRE_RULES and the
// V2 rules stay frozen; every other root kind is delegated to the V2 validator unchanged. Limits are the storage bounds (looser than
// the in-app write bounds) so that every stored card can be backed up; tombstones are included.
export const PERSONAL_EXERCISE_V3_RULES = Object.freeze({ idPrefix: 'custom:card:', legacyPrefix: 'custom:', maxCards: 1000, maxDisplaced: 5,
 reasons: Object.freeze(['edit-conflict','edited-before-delete','delete-superseded']),
 card: Object.freeze(['id','v','name','primaryMuscle','assistingMuscles','equipment','description','legacyCustomIds','catalogMatch','createdAt','updatedAt','rev','deletedAt','displaced']),
 displaced: Object.freeze(['name','primaryMuscle','assistingMuscles','equipment','description','legacyCustomIds','catalogMatch','rev','updatedAt','deletedAt','reason','displacedAt']),
 catalogMatch: Object.freeze(['catalogId','matchedAt']) });
const R = PERSONAL_EXERCISE_V3_RULES;
function exact(v,allowed){if(!object(v))fail('TYPE_MISMATCH');for(const k of Object.keys(v)){if(WIRE_RULES.recognizedCredentialKeys.includes(k))fail('SECRET_FIELD');if(!allowed.includes(k))fail('UNSUPPORTED_PERSONAL_FIELD');}if(allowed.some(k=>!own(v,k)))fail('MISSING_FIELD');}
const timestamp = v => { if(typeof v !== 'string' || !Number.isFinite(Date.parse(v)))fail('INVALID_TIME'); };
const text = (v,max,nullable) => { if(!(nullable&&v===null)&&(typeof v!=='string'||v.length>max))fail('TYPE_MISMATCH'); };
const texts = (v,maxItems,max) => { if(!Array.isArray(v)||v.length>maxItems)fail('TYPE_MISMATCH');for(const s of v)text(s,max,false); };
// Shared by the card and each displaced version (same field rules).
function version(v){
 text(v.name,500,false);text(v.primaryMuscle,64,true);texts(v.assistingMuscles,20,64);text(v.equipment,64,true);text(v.description,5000,true);
 texts(v.legacyCustomIds,50,256);if(v.legacyCustomIds.some(id=>!id.startsWith(R.legacyPrefix)||id.startsWith(R.idPrefix)))fail('TYPE_MISMATCH');
 if(v.catalogMatch!==null){exact(v.catalogMatch,R.catalogMatch);text(v.catalogMatch.catalogId,128,false);timestamp(v.catalogMatch.matchedAt);}
 if(!Number.isSafeInteger(v.rev)||v.rev<0)fail('TYPE_MISMATCH');timestamp(v.updatedAt);if(v.deletedAt!==null)timestamp(v.deletedAt);
}
export function validatePersonalExercise(card){
 exact(card,R.card);
 if(typeof card.id!=='string'||!card.id.startsWith(R.idPrefix)||card.id.length<=R.idPrefix.length||card.id.length>128||card.v!==1)fail('TYPE_MISMATCH');
 version(card);timestamp(card.createdAt);
 if(!Array.isArray(card.displaced)||card.displaced.length>R.maxDisplaced)fail('TYPE_MISMATCH');
 for(const d of card.displaced){exact(d,R.displaced);version(d);if(!R.reasons.includes(d.reason))fail('TYPE_MISMATCH');timestamp(d.displacedAt);}
 return card;
}
// Duplicate card ids across roots are refused by the staged root identity (UNIQUE root_kind+source_tuple → DUPLICATE_SOURCE_ID).
export function validatePortableRootV3(root){
 if(root?.kind!=='personalExercise')return validatePortableRootV2(root);
 // Same non-executing object boundary as V2 (no accessors, plain prototypes, bounded structure) before any field is read.
 let nodes=0;const seen=new Set();const inspect=(value,depth=0)=>{if(++nodes>200000||depth>32)fail('STRUCTURE_LIMIT',413);if(value===null||typeof value!=='object')return;if(seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('TYPE_MISMATCH');seen.add(value);for(const key of Reflect.ownKeys(value)){if(typeof key!=='string')fail('TYPE_MISMATCH');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d))fail('TYPE_MISMATCH');inspect(d.value,depth+1);}seen.delete(value);};inspect(root);
 exactFields(root,['kind','record']);validatePersonalExercise(root.record);return root;
}
// Undo proof scope of the stored card list: only what the server cannot interpret (unknown fields of a card, its catalog match or a
// displaced version; non-object entries). Known card content may change after a restore without blocking its undo.
export function personalExercisesOpaque(payload){
 if(!Array.isArray(payload))return {malformed:payload};
 const unknown=(v,allowed)=>object(v)?Object.fromEntries(Object.entries(v).filter(([k])=>!allowed.includes(k))):{malformed:v};
 const entries=payload.map((card,index)=>{const opaque=unknown(card,R.card);
  if(object(card)){if(object(card.catalogMatch)){const m=unknown(card.catalogMatch,R.catalogMatch);if(Object.keys(m).length)opaque.catalogMatch=m;}
   if(Array.isArray(card.displaced)){const d=card.displaced.map((entry,i)=>{const o=unknown(entry,R.displaced);if(object(entry)&&object(entry.catalogMatch)){const m=unknown(entry.catalogMatch,R.catalogMatch);if(Object.keys(m).length)o.catalogMatch=m;}return {index:i,opaque:o};}).filter(e=>Object.keys(e.opaque).length);if(d.length)opaque.displaced=d;}}
  return {index,id:card?.id??null,opaque};}).filter(e=>Object.keys(e.opaque).length);
 return entries.length?{entries}:{};
}
