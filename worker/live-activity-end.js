// Build 45 B45-APNs-01 CANDIDATE (feasibility branch; NOT wired into worker/index.js or the production crons).
// Server-side end of a Live Activity ~30 minutes after the last meaningful workout activity, for a locked/suspended
// iPhone. The app reports { workoutId, pushToken, environment, activityAt }; a minute step sends the ActivityKit `end`
// push once the deadline passes. Safety rules (each is tested in scripts/live-activity-end-test.mjs):
// - The deadline never moves backwards: activity_ms = MAX(stored, reported) (late Watch events, reordered requests).
// - A new push token rearms the row (new or re-tokened activity); a send is claimed by revision and finalized only for
//   that revision, so a report that lands during a send is never marked sent.
// - Reported activity is clamped to the server clock (+2 min skew) and ignored beyond the 120-minute auto-close.
// - Dead tokens (410 / BadDeviceToken / wrong topic) stop; auth failures and 429/5xx/network retry with backoff.
// - The push expires after 5 minutes, so a phone offline at the deadline cannot be closed by it much later.
import { APNS_HOSTS, apnsConfig, classify, endPayload, postLiveActivity, providerToken, PUSH_TOKEN_PATTERN } from './apns.js';

export const LIVE_ACTIVITY_DORMANT_MS = 30 * 60 * 1000;
export const LIVE_ACTIVITY_MAX_AGE_MS = 120 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const SENDING_LEASE_MS = 2 * 60 * 1000;
export const LIVE_ACTIVITY_SENDS_PER_RUN = 5;
const MAX_ATTEMPTS = 6;
const WORKOUT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const SCHEDULE_SQL = `INSERT INTO live_activity_end(user_id,workout_id,push_token,apns_env,activity_ms,end_ms,revision,state,attempts,retry_ms,claimed_ms,last_error,updated_ms)
 VALUES (?1,?2,?3,?4,?5,?5+${LIVE_ACTIVITY_DORMANT_MS},0,'PENDING',0,NULL,NULL,NULL,?6)
 ON CONFLICT(user_id,workout_id) DO UPDATE SET
  state=CASE WHEN excluded.push_token<>push_token THEN 'PENDING'
             WHEN state='FAILED' THEN 'FAILED'
             WHEN state='SENT' AND excluded.activity_ms<=activity_ms THEN 'SENT'
             ELSE 'PENDING' END,
  attempts=CASE WHEN excluded.push_token<>push_token OR (state='SENT' AND excluded.activity_ms>activity_ms) THEN 0 ELSE attempts END,
  retry_ms=CASE WHEN excluded.push_token<>push_token THEN NULL ELSE retry_ms END,
  last_error=CASE WHEN excluded.push_token<>push_token THEN NULL ELSE last_error END,
  revision=revision+1,
  push_token=excluded.push_token, apns_env=excluded.apns_env,
  activity_ms=MAX(activity_ms,excluded.activity_ms), end_ms=MAX(activity_ms,excluded.activity_ms)+${LIVE_ACTIVITY_DORMANT_MS},
  updated_ms=excluded.updated_ms
 WHERE excluded.push_token<>push_token OR excluded.apns_env<>apns_env OR excluded.activity_ms>activity_ms`;
// Due rows (also usable as one term of the production minute probe so an idle minute costs no extra D1 trip).
export const DUE_SQL = `SELECT user_id,workout_id,push_token,apns_env,revision,attempts FROM live_activity_end
 WHERE state='PENDING' AND end_ms<=?1 AND (retry_ms IS NULL OR retry_ms<=?1) ORDER BY end_ms LIMIT ${LIVE_ACTIVITY_SENDS_PER_RUN}`;
const SWEEP_SQL = `UPDATE live_activity_end SET state='PENDING',retry_ms=?1,last_error='SEND_INTERRUPTED' WHERE state='SENDING' AND claimed_ms<=?2`;
const EXPIRE_SQL = `DELETE FROM live_activity_end WHERE updated_ms<=?1`;
const CLAIM_SQL = `UPDATE live_activity_end SET state='SENDING',claimed_ms=?1,attempts=attempts+1
 WHERE user_id=?2 AND workout_id=?3 AND revision=?4 AND state='PENDING' AND end_ms<=?1`;
const FINAL_SQL = `UPDATE live_activity_end SET state=?1,retry_ms=?2,last_error=?3,apns_env=?4,claimed_ms=NULL
 WHERE user_id=?5 AND workout_id=?6 AND revision=?7 AND state='SENDING'`;

export function parseSchedule(input, nowMs) {
  const workoutId = typeof input?.workoutId === 'string' ? input.workoutId : '';
  const pushToken = typeof input?.pushToken === 'string' ? input.pushToken.toLowerCase() : '';
  const environment = ['sandbox', 'production', 'auto'].includes(input?.environment) ? input.environment : null;
  const activity = typeof input?.activityAt === 'string' ? Date.parse(input.activityAt) : NaN;
  if (!WORKOUT_ID.test(workoutId) || !PUSH_TOKEN_PATTERN.test(pushToken) || !environment || !Number.isFinite(activity)) return { error: 'LIVE_ACTIVITY_INVALID' };
  // A phone clock ahead of the server must not postpone the end by more than the tolerated skew.
  const activityMs = Math.min(activity, nowMs + CLOCK_SKEW_MS);
  if (activityMs <= nowMs - LIVE_ACTIVITY_MAX_AGE_MS) return { stale: true, workoutId };
  return { workoutId, pushToken, environment, activityMs };
}

export async function scheduleLiveActivityEnd(env, userId, input, nowMs = Date.now()) {
  const parsed = parseSchedule(input, nowMs);
  if (parsed.error) return { status: 400, code: parsed.error };
  if (parsed.stale) {
    await env.DB.prepare('DELETE FROM live_activity_end WHERE user_id=?1 AND workout_id=?2').bind(userId, parsed.workoutId).run();
    return { status: 200, code: 'LIVE_ACTIVITY_EXPIRED' };
  }
  await env.DB.prepare(SCHEDULE_SQL).bind(userId, parsed.workoutId, parsed.pushToken, parsed.environment, parsed.activityMs, nowMs).run();
  return { status: 200, code: 'LIVE_ACTIVITY_SCHEDULED', endAt: new Date(parsed.activityMs + LIVE_ACTIVITY_DORMANT_MS).toISOString() };
}

export async function cancelLiveActivityEnd(env, userId, workoutId) {
  if (typeof workoutId !== 'string' || !WORKOUT_ID.test(workoutId)) return { status: 400, code: 'LIVE_ACTIVITY_INVALID' };
  await env.DB.prepare('DELETE FROM live_activity_end WHERE user_id=?1 AND workout_id=?2').bind(userId, workoutId).run();
  return { status: 200, code: 'LIVE_ACTIVITY_CANCELLED' };
}

// The minute step. `fetchImpl` is injectable for tests; the real step uses the Workers fetch (HTTP/2 to APNs).
export async function runLiveActivityEnds(env, { nowMs = Date.now(), fetchImpl = fetch, log = entry => console.log(JSON.stringify(entry)) } = {}) {
  const [, , due] = await env.DB.batch([
    env.DB.prepare(SWEEP_SQL).bind(nowMs, nowMs - SENDING_LEASE_MS),
    env.DB.prepare(EXPIRE_SQL).bind(nowMs - LIVE_ACTIVITY_MAX_AGE_MS - LIVE_ACTIVITY_DORMANT_MS),
    env.DB.prepare(DUE_SQL).bind(nowMs),
  ]);
  const rows = due?.results || [];
  if (!rows.length) return { sent: 0, rows: 0 };
  const config = apnsConfig(env);
  if (!config.ready) { log({ event: 'live_activity_end_unconfigured', due: rows.length }); return { sent: 0, rows: rows.length, unconfigured: true }; }
  const jwt = await providerToken(config, nowMs);
  let sent = 0;
  for (const row of rows) {
    const claim = await env.DB.prepare(CLAIM_SQL).bind(nowMs, row.user_id, row.workout_id, row.revision).run();
    if (!claim.meta?.changes) continue;
    const payload = endPayload(nowMs);
    const hosts = row.apns_env === 'auto' ? ['production', 'sandbox'] : [row.apns_env];
    let result, used;
    for (const name of hosts) {
      used = name;
      result = await postLiveActivity({ host: APNS_HOSTS[name], token: row.push_token, jwt, payload, nowMs, fetchImpl });
      if (!(result.reason === 'BadDeviceToken' && hosts.length > 1)) break;
    }
    const outcome = classify(result);
    const attempts = row.attempts + 1;
    let state = 'PENDING', retry = null;
    if (outcome === 'sent') { state = 'SENT'; sent++; }
    else if (outcome === 'dead' || attempts >= MAX_ATTEMPTS) state = 'FAILED';
    else retry = nowMs + (outcome === 'auth' ? 15 * 60 * 1000 : Math.min(2 ** attempts, 30) * 60 * 1000);
    const finalEnv = row.apns_env === 'auto' && outcome === 'sent' ? used : row.apns_env;
    await env.DB.prepare(FINAL_SQL).bind(state, retry, outcome === 'sent' ? null : `${result.status}:${result.reason || ''}`.slice(0, 80), finalEnv, row.user_id, row.workout_id, row.revision).run();
    // Never log the push token or the provider token.
    log({ event: 'live_activity_end', outcome, status: result.status, reason: result.reason, apnsId: Boolean(result.apnsId), env: used });
  }
  return { sent, rows: rows.length };
}
