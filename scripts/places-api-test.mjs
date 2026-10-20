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
console.log('PASS: Places proxy payloads, Google IDs only, session token and secret isolation, auth/lifecycle -> config -> body -> rate limit -> upstream order');
