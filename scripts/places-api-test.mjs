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
console.log('PASS: Places proxy payloads, Google IDs only, session token and secret isolation');
