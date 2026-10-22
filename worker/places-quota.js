// Build 48 B48-C: per-account daily Google Places Autocomplete allowance, shared by all of the user's devices.
// Distinct from PLACES_LIMITER (short-window burst limiter) and from provider-side billing/quotas (Google Cloud quota
// caps and budget alerts): this only bounds how many Autocomplete requests ONE account sends upstream per window.
//
// Accounting: one conditional upsert per Autocomplete, run after the burst limiter and BEFORE the provider is called.
// D1 serializes writes, so the statement is atomic: concurrent devices and duplicate requests each take one unit and
// exactly PLACES_DAILY_AUTOCOMPLETE_LIMIT are admitted per window. A reserved unit is never refunded (timeout, upstream
// 429/5xx, client abort): the request may have been billed, and errors cannot be provoked to buy extra searches.
// Place ID verification never touches this.
//
// RESET POLICY (user decision 2026-10-22): `first-use-24h`, a 24-hour window starting at the first counted request.
// It is the only approved policy. Enabling still needs migration 0017 and PLACES_DAILY_QUOTA_POLICY='first-use-24h' on
// the Worker (separately approved production steps). With the variable unset the Worker behaves exactly like Build 47
// (no D1 access); set to any other value (e.g. the rejected `utc-day`), Autocomplete fails closed (503
// PLACES_NOT_CONFIGURED; Place ID verification and manual gym entry still work).
export const PLACES_DAILY_AUTOCOMPLETE_LIMIT=100;
const DAY_MS=86_400_000;
export const PLACES_QUOTA_POLICIES=Object.freeze({
  // Not approved (kept for comparison tests only): UTC calendar day. Same reset instant for everyone; local reset hour varies by place (e.g. 03:00 in
  // Istanbul, 19:00/20:00 in New York); travel never changes the boundary.
  'utc-day':nowMs=>{const start=Math.floor(nowMs/DAY_MS)*DAY_MS;return{start,end:start+DAY_MS};},
  // APPROVED: 24 hours from the first counted request of a window. No time zone at all; a fresh window only opens
  // once the previous one expired (the stored window is kept until then).
  'first-use-24h':nowMs=>({start:nowMs,end:nowMs+DAY_MS}),
});
// User decision 2026-10-22 (docs/build48/DECISIONS.md, B48-C): "ilk aramadan sonra 24 saat".
export const APPROVED_PLACES_QUOTA_POLICIES=Object.freeze(['first-use-24h']);

export function placesQuotaPolicy(env,approved=APPROVED_PLACES_QUOTA_POLICIES){
  const name=env?.PLACES_DAILY_QUOTA_POLICY;
  if(name===undefined||name===null||name==='')return{enabled:false};
  return typeof name==='string'&&Object.hasOwn(PLACES_QUOTA_POLICIES,name)&&approved.includes(name)
    ?{enabled:true,name,window:PLACES_QUOTA_POLICIES[name]}:{enabled:false,misconfigured:true};
}
// The window is replaced only once the stored one has ended; every SET expression reads the old row values. A clock
// that reads earlier than the stored window (skew between Worker instances) counts in the current window, never resets it.
const RESERVE_SQL=`INSERT INTO places_autocomplete_usage(user_id,window_start_ms,window_end_ms,dispatched,updated_ms)
 VALUES(?1,?2,?3,1,?4)
 ON CONFLICT(user_id) DO UPDATE SET
  dispatched=CASE WHEN ?4>=window_end_ms THEN 1 ELSE dispatched+1 END,
  window_start_ms=CASE WHEN ?4>=window_end_ms THEN ?2 ELSE window_start_ms END,
  window_end_ms=CASE WHEN ?4>=window_end_ms THEN ?3 ELSE window_end_ms END,
  updated_ms=?4
 WHERE ?4>=places_autocomplete_usage.window_end_ms
  OR places_autocomplete_usage.dispatched<?5
 RETURNING dispatched`;
// true: one unit reserved, dispatch allowed. false: allowance used up for this window. Throws on D1 failure (the
// caller fails closed without contacting the provider).
export async function reservePlacesAutocomplete(db,userId,policy,nowMs=Date.now(),limit=PLACES_DAILY_AUTOCOMPLETE_LIMIT){
  const {start,end}=policy.window(nowMs);
  const row=await db.prepare(RESERVE_SQL).bind(userId,start,end,nowMs,limit).first();
  return Boolean(row&&Number(row.dispatched)<=limit);
}
