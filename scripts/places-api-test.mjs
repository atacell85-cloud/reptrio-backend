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
 assert.ok(url.includes('?fields=id'));return{ok:true,text:async()=>JSON.stringify({id:placeId})};
};
const a=await googlePlacesRequest('autocomplete',{input:'Salon A',sessionToken:token},'secret',provider);
assert.deepEqual(a.body,{predictions:[{placeId,name:'A Spor',description:'A Spor, İstanbul'}],attribution:'Google Maps'});
const v=await googlePlacesRequest('verify',{placeId,sessionToken:token},'secret',provider);
assert.deepEqual(v.body,{placeId,verified:true});
const e=await googlePlacesRequest('verify',{placeId,sessionToken:token},'secret',async()=>({ok:false,status:403}));
assert.equal(e.status,502);
console.log('PASS: Places proxy payloads, Google IDs only, session token and secret isolation');
