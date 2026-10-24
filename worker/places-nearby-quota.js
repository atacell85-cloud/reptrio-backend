// Build 49 B49-001: Nearby Search (New) is the expensive Places call, so it has its OWN allowance, separate from the
// Autocomplete one (worker/places-quota.js), plus a project-wide daily ceiling.
// User decision 2026-10-24 (docs/build49/DECISIONS.md): per account 5 requests per 24 hours from the first counted request
// (`first-use-24h`, shared by all devices), 5 km radius, at most 20 results. Opt-in and fail closed: both
// PLACES_NEARBY_QUOTA_POLICY='first-use-24h' and a positive integer PLACES_NEARBY_PROJECT_DAILY_CAP are required, otherwise
// the route answers 503 PLACES_NOT_CONFIGURED before touching D1 or Google. A reserved unit is never refunded (the
// request may have been billed). The per-account unit is taken first, then the project unit; a project-cap refusal
// therefore costs the account one unit, which errs on the side of spending less.
export const PLACES_NEARBY_DAILY_LIMIT=5;
export const PLACES_NEARBY_RADIUS_METERS=5000;
export const PLACES_NEARBY_MAX_RESULTS=20;
const DAY_MS=86_400_000;
export const PLACES_NEARBY_PROJECT_CAP_MAX=100_000;
export function placesNearbyConfig(env){
  if(env?.PLACES_NEARBY_QUOTA_POLICY!=='first-use-24h')return{enabled:false};
  const raw=env?.PLACES_NEARBY_PROJECT_DAILY_CAP;
  const cap=typeof raw==='number'?raw:typeof raw==='string'&&/^\d{1,6}$/.test(raw)?Number(raw):NaN;
  return Number.isInteger(cap)&&cap>0&&cap<=PLACES_NEARBY_PROJECT_CAP_MAX?{enabled:true,projectCap:cap}:{enabled:false};
}
const USER_SQL=`INSERT INTO places_nearby_usage(user_id,window_start_ms,window_end_ms,dispatched,updated_ms)
 VALUES(?1,?2,?3,1,?4)
 ON CONFLICT(user_id) DO UPDATE SET
  dispatched=CASE WHEN ?4>=window_end_ms THEN 1 ELSE dispatched+1 END,
  window_start_ms=CASE WHEN ?4>=window_end_ms THEN ?2 ELSE window_start_ms END,
  window_end_ms=CASE WHEN ?4>=window_end_ms THEN ?3 ELSE window_end_ms END,
  updated_ms=?4
 WHERE ?4>=places_nearby_usage.window_end_ms
  OR places_nearby_usage.dispatched<?5
 RETURNING dispatched`;
const PROJECT_SQL=`INSERT INTO places_nearby_project_usage(day_start_ms,dispatched) VALUES(?1,1)
 ON CONFLICT(day_start_ms) DO UPDATE SET dispatched=dispatched+1
 WHERE places_nearby_project_usage.dispatched<?2
 RETURNING dispatched`;
// 'ok' | 'USER_LIMIT' | 'PROJECT_CAP'. Throws on D1 failure (the caller fails closed without contacting Google).
export async function reservePlacesNearby(db,userId,config,nowMs=Date.now()){
  const user=await db.prepare(USER_SQL).bind(userId,nowMs,nowMs+DAY_MS,nowMs,PLACES_NEARBY_DAILY_LIMIT).first();
  if(!user||Number(user.dispatched)>PLACES_NEARBY_DAILY_LIMIT)return'USER_LIMIT';
  const day=Math.floor(nowMs/DAY_MS)*DAY_MS;
  const project=await db.prepare(PROJECT_SQL).bind(day,config.projectCap).first();
  return project&&Number(project.dispatched)<=config.projectCap?'ok':'PROJECT_CAP';
}
