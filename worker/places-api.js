// Google Places New: authenticated server-only relay; no secret in mobile, no name/cache/location logging.
import {currentUser,sameOrigin} from './account-api.js';
import {placesQuotaPolicy,reservePlacesAutocomplete} from './places-quota.js';
const BASE='https://places.googleapis.com/v1/places/';
const PID=/^[A-Za-z0-9_-]{8,250}$/;
const UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const answer=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
// Build 48 (worldwide): no built-in language or country. Clients may send the device's own language tag and region
// SETTING (never a location); both are optional, so Build 47 bodies {input,sessionToken} stay valid. The Worker maps
// the tag to a language Places documents and drops anything else, so an unusual device locale can never turn into
// an INVALID_ARGUMENT upstream: omitted fields mean Google's defaults (Accept-Language, else `en`) and no region bias.
// regionCode only biases ranking/formatting; it is never sent as includedRegionCodes (a restriction).
const GOOGLE_LANGUAGES=new Set('af sq am ar hy az eu be bn bs bg my ca zh hr cs da nl en et fa fi fil fr gl ka de el gu iw hi hu is id it ja kn kk km ko ky lo lv lt mk ms ml mr mn ne no pl pt pa ro ru sr si sk sl es sw sv ta te th tr uk ur uz vi zu'.split(' '));
const LANGUAGE_ALIASES={he:'iw',nb:'no',nn:'no',tl:'fil',in:'id'};
const LANGUAGE_TAG=/^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?$/;
// The 249 assigned ISO 3166-1 alpha-2 codes (ISO 3166 Maintenance Agency). Exceptionally/transitionally reserved
// (AC, DG, EA, IC, TA, UK, EU, ...), deprecated (AN, CS, YU, SU, ...) and user-assigned (XK, QO, ZZ, ...) codes are dropped.
const ISO_REGIONS=new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
export function googleLanguageCode(tag){
  if(typeof tag!=='string'||tag.length>16||!LANGUAGE_TAG.test(tag))return null;
  const [first,...rest]=tag.split('-'),script=rest.find(p=>p.length===4)?.toLowerCase(),region=rest.find(p=>p.length!==4)?.toUpperCase();
  const primary=LANGUAGE_ALIASES[first.toLowerCase()]||first.toLowerCase();
  if(!GOOGLE_LANGUAGES.has(primary))return null;
  if(primary==='zh')return region==='HK'||region==='MO'?'zh-HK':script==='hant'||region==='TW'?'zh-TW':'zh-CN';
  if(primary==='pt')return region==='BR'?'pt-BR':region==='PT'?'pt-PT':'pt';
  if(primary==='en')return region==='AU'?'en-AU':region==='GB'?'en-GB':'en';
  if(primary==='fr'&&region==='CA')return'fr-CA';
  if(primary==='es'&&region==='419')return'es-419';
  return primary;
}
export function googleRegionCode(code){
  if(typeof code!=='string'||!/^[A-Za-z]{2}$/.test(code))return null;
  const upper=code.toUpperCase();return ISO_REGIONS.has(upper)?upper.toLowerCase():null;
}
const OPTIONAL_LOCALE=['languageCode','regionCode'];
export function parsePlaceRequest(body,mode) {
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  const required=mode==='autocomplete'?['input','sessionToken']:['placeId','sessionToken'];
  const allowed=mode==='autocomplete'?[...required,...OPTIONAL_LOCALE]:required;
  const keys=Object.keys(body);
  if(!required.every(k=>keys.includes(k))||keys.some(k=>!allowed.includes(k)))return null;
  if(typeof body.sessionToken!=='string'||!UUID.test(body.sessionToken))return null;
  if(mode==='autocomplete'){
    if(typeof body.input!=='string'||body.input.trim().length<3||body.input.trim().length>100||/[\x00-\x1f]/.test(body.input))return null;
    // Present locale fields must be short strings; well-formed but unsupported values are dropped, not refused.
    for(const k of OPTIONAL_LOCALE)if(k in body&&(typeof body[k]!=='string'||body[k].length>35||/[^A-Za-z0-9-]/.test(body[k])))return null;
    const languageCode=googleLanguageCode(body.languageCode),regionCode=googleRegionCode(body.regionCode);
    return {input:body.input.trim(),sessionToken:body.sessionToken,...(languageCode?{languageCode}:{}),...(regionCode?{regionCode}:{})};
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
      ...(mode==='autocomplete'?{body:JSON.stringify({input:payload.input,sessionToken:payload.sessionToken,...(payload.languageCode?{languageCode:payload.languageCode}:{}),...(payload.regionCode?{regionCode:payload.regionCode}:{})})}:{}),
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
export async function handlePlacesRequest(request,env,pathname,{approvedQuotaPolicies,now=Date.now}={}){
  const mode=pathname==='/api/places/autocomplete'?'autocomplete':pathname==='/api/places/verify'?'verify':null;
  if(!mode)return null;
  if(request.method!=='POST')return answer({code:'METHOD_NOT_ALLOWED'},405);
  if(!sameOrigin(request))return answer({code:'AUTH_ORIGIN_INVALID'},403);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return answer({code:'UNSUPPORTED_CONTENT_TYPE'},415);
  let user;try{user=await currentUser(request,env)}catch{return answer({code:'AUTH_UNAVAILABLE'},503)}
  if(!user)return answer({code:'AUTH_REQUIRED'},401);
  if(!env.GOOGLE_MAPS_PLACES_API_KEY||!env.PLACES_LIMITER)return answer({code:'PLACES_NOT_CONFIGURED'},503);
  const quota=placesQuotaPolicy(env,approvedQuotaPolicies);
  // The allowance (and its gate) concern Autocomplete only; Place ID verification never depends on it.
  if(mode==='autocomplete'&&quota.misconfigured)return answer({code:'PLACES_NOT_CONFIGURED'},503);
  let payload;try{
    const raw=await request.text();if(raw.length>768)return answer({code:'PLACES_BAD_REQUEST'},400);
    payload=parsePlaceRequest(JSON.parse(raw),mode);
  }catch{return answer({code:'PLACES_BAD_REQUEST'},400)}
  if(!payload)return answer({code:'PLACES_BAD_REQUEST'},400);
  try{
    const throttle=await env.PLACES_LIMITER.limit({key:'places:'+user.id});
    if(!throttle?.success)return answer({code:'PLACES_RATE_LIMITED'},429);
  }catch{return answer({code:'PLACES_UNAVAILABLE'},503)}
  // Build 48: the daily allowance counts only Autocomplete actually sent upstream (after the burst limiter, before
  // dispatch); verification is never counted. Accounting failure fails closed with no provider request.
  if(mode==='autocomplete'&&quota.enabled){
    let admitted;try{admitted=await reservePlacesAutocomplete(env.DB,user.id,quota,now())}catch{return answer({code:'PLACES_UNAVAILABLE'},503)}
    if(!admitted)return answer({code:'PLACES_DAILY_LIMIT'},429);
  }
  const result=await googlePlacesRequest(mode,payload,env.GOOGLE_MAPS_PLACES_API_KEY);
  return answer(result.body,result.status);
}
