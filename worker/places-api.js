// Google Places New: authenticated server-only relay; no secret in mobile, no name/cache/location logging.
import {currentUser,sameOrigin} from './account-api.js';
const BASE='https://places.googleapis.com/v1/places/';
const PID=/^[A-Za-z0-9_-]{8,250}$/;
const UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const answer=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export function parsePlaceRequest(body,mode) {
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  const keys=mode==='autocomplete'?'input,sessionToken':'placeId,sessionToken';
  if(Object.keys(body).sort().join(',')!==keys||typeof body.sessionToken!=='string'||!UUID.test(body.sessionToken))return null;
  if(mode==='autocomplete'){
    if(typeof body.input!=='string'||body.input.trim().length<3||body.input.trim().length>100||/[\x00-\x1f]/.test(body.input))return null;
    return {input:body.input.trim(),sessionToken:body.sessionToken};
  }
  return typeof body.placeId==='string'&&PID.test(body.placeId)?{placeId:body.placeId,sessionToken:body.sessionToken}:null;
}
export async function googlePlacesRequest(mode,payload,key,provider=fetch){
  // Same per-search token terminates Autocomplete at Place Details (New). IDs Only is billed per autocomplete request.
  const url=mode==='autocomplete'?'https://places.googleapis.com/v1/places:autocomplete':BASE+encodeURIComponent(payload.placeId)+'?sessionToken='+encodeURIComponent(payload.sessionToken);
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),5000);
  try{
    const response=await provider(url,{
      method:mode==='autocomplete'?'POST':'GET',
      headers:{'X-Goog-Api-Key':key,'Accept':'application/json',
        ...(mode==='verify'?{'X-Goog-FieldMask':'id'}:{}),
        ...(mode==='autocomplete'?{'Content-Type':'application/json'}:{})},
      ...(mode==='autocomplete'?{body:JSON.stringify({input:payload.input,sessionToken:payload.sessionToken,languageCode:'tr',regionCode:'tr'})}:{}),
      signal:abort.signal,
    });
    if(!response.ok)return{status:response.status===429?429:502,body:{code:response.status===429?'PLACES_RATE_LIMITED':'PLACES_UPSTREAM_ERROR'}};
    const raw=await response.text();if(raw.length>55000)return{status:502,body:{code:'PLACES_UPSTREAM_ERROR'}};
    let json;try{json=JSON.parse(raw)}catch{return{status:502,body:{code:'PLACES_UPSTREAM_ERROR'}}}
    if(mode==='verify')return json?.id===payload.placeId
      ?{status:200,body:{placeId:json.id,verified:true}}:{status:404,body:{code:'PLACE_NOT_FOUND'}};
    const predictions=Array.isArray(json?.suggestions)?json.suggestions.flatMap(s=>{
      const p=s?.placePrediction;if(typeof p?.placeId!=='string'||!PID.test(p.placeId))return[];
      const name=String(p.structuredFormat?.mainText?.text||p.text?.text||'').trim().slice(0,120);
      const description=String(p.text?.text||name).trim().slice(0,220);
      return name?[{placeId:p.placeId,name,description}]:[];
    }).slice(0,8):[];
    return{status:200,body:{predictions,attribution:'Google Maps'}};
  }catch{return{status:503,body:{code:'PLACES_UPSTREAM_UNAVAILABLE'}}}
  finally{clearTimeout(timeout)}
}
export async function handlePlacesRequest(request,env,pathname){
  const mode=pathname==='/api/places/autocomplete'?'autocomplete':pathname==='/api/places/verify'?'verify':null;
  if(!mode)return null;
  if(request.method!=='POST')return answer({code:'METHOD_NOT_ALLOWED'},405);
  if(!sameOrigin(request))return answer({code:'AUTH_ORIGIN_INVALID'},403);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return answer({code:'UNSUPPORTED_CONTENT_TYPE'},415);
  let user;try{user=await currentUser(request,env)}catch{return answer({code:'AUTH_UNAVAILABLE'},503)}
  if(!user)return answer({code:'AUTH_REQUIRED'},401);
  if(!env.GOOGLE_MAPS_PLACES_API_KEY||!env.PLACES_LIMITER)return answer({code:'PLACES_NOT_CONFIGURED'},503);
  let payload;try{
    const raw=await request.text();if(raw.length>768)return answer({code:'PLACES_BAD_REQUEST'},400);
    payload=parsePlaceRequest(JSON.parse(raw),mode);
  }catch{return answer({code:'PLACES_BAD_REQUEST'},400)}
  if(!payload)return answer({code:'PLACES_BAD_REQUEST'},400);
  try{
    const throttle=await env.PLACES_LIMITER.limit({key:'places:'+user.id});
    if(!throttle?.success)return answer({code:'PLACES_RATE_LIMITED'},429);
  }catch{return answer({code:'PLACES_UNAVAILABLE'},503)}
  const result=await googlePlacesRequest(mode,payload,env.GOOGLE_MAPS_PLACES_API_KEY);
  return answer(result.body,result.status);
}
