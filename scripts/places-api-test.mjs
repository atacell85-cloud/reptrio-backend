import assert from 'node:assert/strict';
import {parsePlaceRequest,googlePlacesRequest} from '../worker/places-api.js';
const token='12345678-abcd-4e01-9876-123456789abc',placeId='ChIJ123456789012345678';
assert.deepEqual(parsePlaceRequest({input:' Salon A ',sessionToken:token},'autocomplete'),{input:'Salon A',sessionToken:token});
assert.equal(parsePlaceRequest({input:'xx',sessionToken:token},'autocomplete'),null);
assert.equal(parsePlaceRequest({placeId,sessionToken:'bad'},'verify'),null);
const provider=async(url,opts)=>{
 assert.equal(opts.headers['X-Goog-Api-Key'],'secret');assert.ok(!url.includes('secret'));
 if(url.includes('autocomplete')){
  assert.equal(JSON.parse(opts.body).sessionToken,token);
  return{ok:true,text:async()=>JSON.stringify({suggestions:[{placePrediction:{
   placeId,structuredFormat:{mainText:{text:'A Spor'}},text:{text:'A Spor, İstanbul'}}}]})};
 }
 assert.equal(new URL(url).searchParams.get('sessionToken'),token,'verification must end the same Places session');
 assert.equal(opts.headers['X-Goog-FieldMask'],'id','fetch ONLY verified Place ID');
 assert.equal(url.startsWith('https://places.googleapis.com/v1/places/'),true);
 return{ok:true,text:async()=>JSON.stringify({id:placeId})};
};
const a=await googlePlacesRequest('autocomplete',{input:'Salon A',sessionToken:token},'secret',provider);
assert.deepEqual(a.body,{predictions:[{placeId,name:'A Spor',description:'A Spor, İstanbul'}],attribution:'Google Maps'});
const v=await googlePlacesRequest('verify',{placeId,sessionToken:token},'secret',provider);
assert.deepEqual(v.body,{placeId,verified:true});
const e=await googlePlacesRequest('verify',{placeId,sessionToken:token},'secret',async()=>({ok:false,status:403}));
assert.equal(e.status,502);
// An expired/other search token must not be silently substituted by the proxy.
const different='87654321-abcd-4e01-9876-123456789abc';
const verified=await googlePlacesRequest('verify',{placeId,sessionToken:different},'secret',async(url,opts)=>{
 assert.equal(new URL(url).searchParams.get('sessionToken'),different);
 assert.equal(opts.headers['X-Goog-FieldMask'],'id');
 return{ok:true,text:async()=>JSON.stringify({id:placeId})};
});
assert.equal(verified.body.verified,true);
// Route order (Build 47 L6): auth incl. account lifecycle -> configuration -> body -> per-user rate limit -> upstream.
// A PENDING_DELETION/PURGING account is not authenticated (currentUser uses the lifecycle-gated DB) and spends no quota.
{
 const {default:worker}=await import('../worker/index.js');const {tokenDigest}=await import('../worker/account-api.js');const {createD1}=await import('./lib/d1-sqlite.mjs');
 const db=createD1();db.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES ('pu','pu@x','h','s','now')").run();
 db.raw.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES ('pa','pu',?,'now','2099-01-01')").run(await tokenDigest('places-token'));
 let limited=0,upstream=0;const realFetch=globalThis.fetch;globalThis.fetch=async()=>{upstream++;return{ok:true,text:async()=>JSON.stringify({suggestions:[]})};};
 const env={DB:db,GOOGLE_MAPS_PLACES_API_KEY:'secret',PLACES_LIMITER:{limit:async()=>{limited++;return{success:true};}}};
 const call=(body,extra={})=>worker.fetch(new Request('https://x/api/places/autocomplete',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer places-token'},body:JSON.stringify(body)}),{...env,...extra},{waitUntil(){}});
 const good={input:'Salon A',sessionToken:token};
 try{
  assert.equal((await call(good)).status,200);assert.equal(limited,1);assert.equal(upstream,1);
  assert.equal((await call({input:'x',sessionToken:token})).status,400);assert.equal(limited,1,'bad body never reaches the limiter');
  assert.equal((await call(good,{GOOGLE_MAPS_PLACES_API_KEY:''})).status,503);assert.equal(limited,1,'missing key fails closed before quota');
  for(const status of ['PENDING_DELETION','PURGING']){
   db.raw.prepare("UPDATE users SET account_status=?,deletion_requested_at='2026-10-01',purge_at='2026-11-01' WHERE id='pu'").run(status);
   const r=await call(good);assert.equal(r.status,401,status);assert.equal((await r.json()).code,'AUTH_REQUIRED');
   assert.equal(limited,1,status+' spends no Places quota');assert.equal(upstream,1,status+' makes no upstream request');
  }
 }finally{globalThis.fetch=realFetch;}
}
// Build 48 B48-B: worldwide. No built-in Turkish language or region; optional device locale, validated and mapped.
{
 const {googleLanguageCode,googleRegionCode}=await import('../worker/places-api.js');
 const sent=[];const capture=async(url,opts)=>{sent.push(JSON.parse(opts.body));return{ok:true,text:async()=>JSON.stringify({suggestions:[]})};};
 // Build 47 body: still valid, and the provider gets NO languageCode/regionCode (Google defaults, no country bias).
 const legacy=parsePlaceRequest({input:'Gold Gym',sessionToken:token},'autocomplete');
 assert.deepEqual(legacy,{input:'Gold Gym',sessionToken:token});
 await googlePlacesRequest('autocomplete',legacy,'secret',capture);
 assert.deepEqual(sent.at(-1),{input:'Gold Gym',sessionToken:token},'unspecified user: no language, no region, no restriction');
 assert.ok(!('includedRegionCodes' in sent.at(-1))&&!('locationBias' in sent.at(-1))&&!('locationRestriction' in sent.at(-1)));
 const source=(await import('node:fs')).readFileSync(new URL('../worker/places-api.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/languageCode:\s*'tr'|regionCode:\s*'tr'|Istanbul|includedRegionCodes:/,'no hard-coded Turkey/Istanbul');
 // Device locale (language tag + region setting) is mapped to codes Places documents.
 for(const [input,languageCode,regionCode,expected] of [
  ['İstanbul Spor','tr-TR','TR',{languageCode:'tr',regionCode:'tr'}],
  ['ISPARTA FIT','tr','',{languageCode:'tr'}],
  ['Gold Gym Venice','en-US','US',{languageCode:'en',regionCode:'us'}],
  ['Muscle Factory','en-GB','GB',{languageCode:'en-GB',regionCode:'gb'}],
  ['ゴールドジム 渋谷','ja-JP','JP',{languageCode:'ja',regionCode:'jp'}],
  ['健身房 台北','zh-Hant-TW','TW',{languageCode:'zh-TW',regionCode:'tw'}],
  ['Фитнес Москва','ru','RU',{languageCode:'ru',regionCode:'ru'}],
  ['نادي رياضي','ar-EG','EG',{languageCode:'ar',regionCode:'eg'}],
  ['חדר כושר','he-IL','IL',{languageCode:'iw',regionCode:'il'}],
  ['Treningssenter','nb-NO','NO',{languageCode:'no',regionCode:'no'}],
  ['Academia','pt-BR','BR',{languageCode:'pt-BR',regionCode:'br'}],
  ['Gimnasio','es-419','MX',{languageCode:'es-419',regionCode:'mx'}],
  // Well-formed but unsupported/unassigned values are dropped (never an upstream INVALID_ARGUMENT, never Turkey).
  ['Some Gym','xx-YY','ZZ',{}],['Some Gym','es-ES','IC',{languageCode:'es'}],['Some Gym','nl','AN',{languageCode:'nl'}],['Some Gym','en-GB','UK',{languageCode:'en-GB'}],['Some Gym','en','AC',{languageCode:'en'}],['香港健身','zh-Hant-HK','HK',{languageCode:'zh-HK',regionCode:'hk'}],['Some Gym','tlh','EU',{}],['Some Gym','en','XK',{languageCode:'en'}],['Some Gym','en','QQ',{languageCode:'en'}],
 ]){
  const body={input,sessionToken:token,languageCode,...(regionCode?{regionCode}:{})};
  const parsed=parsePlaceRequest(body,'autocomplete');assert.deepEqual(parsed,{input:input.trim(),sessionToken:token,...expected},languageCode+'/'+regionCode);
  await googlePlacesRequest('autocomplete',parsed,'secret',capture);
  assert.deepEqual(sent.at(-1),{input,sessionToken:token,...expected},'provider body '+languageCode);
 }
 // Unicode length is in characters: 100 non-Latin characters are accepted, 101 refused.
 assert.ok(parsePlaceRequest({input:'健'.repeat(100),sessionToken:token},'autocomplete'));
 assert.equal(parsePlaceRequest({input:'健'.repeat(101),sessionToken:token},'autocomplete'),null);
 // Malicious / malformed bodies are refused (strict keys and types).
 for(const bad of [
  {input:'Gold Gym',sessionToken:token,languageCode:7},{input:'Gold Gym',sessionToken:token,regionCode:['tr']},
  {input:'Gold Gym',sessionToken:token,languageCode:'tr";drop'},{input:'Gold Gym',sessionToken:token,regionCode:'t r'},
  {input:'Gold Gym',sessionToken:token,languageCode:'a'.repeat(36)},{input:'Gold Gym',sessionToken:token,includedRegionCodes:['tr']},
  {input:'Gold Gym',sessionToken:token,locationBias:{circle:{}}},{input:'Gold\nGym',sessionToken:token},
  JSON.parse(`{"input":"Gold Gym","sessionToken":"${token}","__proto__":{"x":1}}`),{input:'Gold Gym',sessionToken:token,extra:1},{input:'Gold Gym'},{sessionToken:token,languageCode:'en'},
 ])assert.equal(parsePlaceRequest(bad,'autocomplete'),null,JSON.stringify(bad));
 // Place ID verification is unchanged: exactly {placeId,sessionToken}; locale fields are not accepted there.
 assert.deepEqual(parsePlaceRequest({placeId,sessionToken:token},'verify'),{placeId,sessionToken:token});
 assert.equal(parsePlaceRequest({placeId,sessionToken:token,languageCode:'en'},'verify'),null);
 assert.equal(googleLanguageCode('zh'),'zh-CN');assert.equal(googleLanguageCode('zh-HK'),'zh-HK');assert.equal(googleLanguageCode(null),null);
 assert.equal(googleRegionCode('TR'),'tr');for(const dropped of ['IC','EA','AC','DG','TA','CP','UK','FX','AN','CS','YU','SU','TP','DD','BU','XK','EU'])assert.equal(googleRegionCode(dropped),null,dropped);assert.equal(googleRegionCode('ax'),'ax');assert.equal(googleRegionCode('UN'),null);assert.equal(googleRegionCode(undefined),null);
}
console.log('PASS: Places proxy payloads, Google IDs only, session token and secret isolation, auth/lifecycle -> config -> body -> rate limit -> upstream order');
