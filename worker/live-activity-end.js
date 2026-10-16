// Build 45: server-side end of a Live Activity ~30 minutes after the last meaningful workout activity, for a locked/suspended
// iPhone. The app reports { workoutId, pushToken, environment, activityAt }; a minute step sends the ActivityKit `end`
// push once the deadline passes. Safety rules (each is tested in scripts/live-activity-end-test.mjs):
// - The deadline never moves backwards: activity_ms = MAX(stored, reported) (late Watch events, reordered requests);
//   a report within 5 s of the stored activity is the same report (latency jitter) and writes nothing.
// - A new push token rearms the row (new or re-tokened activity); a send is claimed by revision and finalized only for
//   that revision, so a report that lands during a send is never marked sent.
// - Phone clocks are never trusted as absolute times: the client sends activityAt AND its own sentAt; the server uses
//   only the elapsed time between them (0..120 min) against its own clock, so a fast or slow phone clock cannot move
//   the deadline. A report is stale only if that elapsed time exceeds the 120-minute auto-close.
// - Dead tokens (410 / BadDeviceToken / wrong topic) stop for that token (DEAD); exhausted retries (FAILED) re-arm on
//   newer activity; auth failures retry in 15 min, 429/5xx in 15 min (Apple), network/IdleTimeout with short backoff.
// - The push asks APNs to drop it after 5 minutes (best effort per Apple), lowering the chance that a phone offline at
//   the deadline is closed by it much later.
// Wiring: `POST /api/live-activity/end` and `/api/live-activity/end/cancel` (session auth, handleLiveActivityRequest);
// the minute step runs inside the existing `* * * * *` cron only when the minute probe (LIVE_ACTIVITY_PROBE_SQL folded
// into account-lifecycle.js MINUTE_PROBE_SQL) reports work, so an idle minute costs no extra D1 call.
import { APNS_HOSTS, apnsConfig, classify, endPayload, postLiveActivity, providerToken, PUSH_TOKEN_PATTERN } from './apns.js';
import { currentUser, error, isJsonPost, json, methodOrTypeError, sameOrigin } from './account-api.js';

export const LIVE_ACTIVITY_DORMANT_MS = 30 * 60 * 1000;
export const LIVE_ACTIVITY_MAX_AGE_MS = 120 * 60 * 1000;
const SENDING_LEASE_MS = 2 * 60 * 1000;
// Workers Free cron CPU (staging, Cloudflare): 1 send 6-9 ms (cold 12-15), 3 sends 9-22 ms. At most 2 per minute; more
// wait for the next minute (a burst of N simultaneous ends finishes within N/2 minutes).
export const LIVE_ACTIVITY_SENDS_PER_RUN = 2;
const MAX_ATTEMPTS = 6;
// The server derives activity time from the request (server now - elapsed), so the same report re-sent differs by its
// network latency. Changes below this tolerance are the same activity (no write, no re-arm, no second push).
export const SAME_ACTIVITY_TOLERANCE_MS = 5000;
// 'auto' falls back to sandbox on these production answers. Apple's live answer for a Sandbox-only key is
// BadEnvironmentKeyInToken (observed from the test Worker, 2026-10-16); the documented spelling is kept as well.
export const FALLBACK_REASONS = new Set(['BadDeviceToken', 'BadEnvironmentKeyInToken', 'BadEnvironmentKeyIdInToken']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const WORKOUT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// Rows kept per user: the current workout plus the two most recently reported others (a finished workout is cancelled
// by the app; this bound only caps abuse and multi-device leftovers, it never drops the reported workout).
const ROWS_PER_USER = 3;
const MAX_BODY_BYTES = 2048;

// Written only for an ACTIVE account, atomically with the account check (a deleting account never gains a row).
export const SCHEDULE_SQL = `INSERT INTO live_activity_end(user_id,workout_id,push_token,apns_env,activity_ms,end_ms,revision,state,attempts,retry_ms,claimed_ms,last_error,updated_ms)
 SELECT ?1,?2,?3,?4,?5,?5+${LIVE_ACTIVITY_DORMANT_MS},0,'PENDING',0,NULL,NULL,NULL,?6
 WHERE EXISTS(SELECT 1 FROM users WHERE id=?1 AND account_status='ACTIVE' AND deleted_at IS NULL)
 ON CONFLICT(user_id,workout_id) DO UPDATE SET
  state=CASE WHEN excluded.push_token<>push_token THEN 'PENDING'
             WHEN state='DEAD' THEN 'DEAD'
             WHEN state IN ('SENT','FAILED') AND excluded.activity_ms<=activity_ms+${SAME_ACTIVITY_TOLERANCE_MS} THEN state
             ELSE 'PENDING' END,
  attempts=CASE WHEN excluded.push_token<>push_token OR (state IN ('SENT','FAILED') AND excluded.activity_ms>activity_ms+${SAME_ACTIVITY_TOLERANCE_MS}) THEN 0 ELSE attempts END,
  retry_ms=CASE WHEN excluded.push_token<>push_token THEN NULL ELSE retry_ms END,
  last_error=CASE WHEN excluded.push_token<>push_token THEN NULL ELSE last_error END,
  revision=revision+1,
  push_token=excluded.push_token, apns_env=excluded.apns_env,
  activity_ms=MAX(activity_ms,excluded.activity_ms), end_ms=MAX(activity_ms,excluded.activity_ms)+${LIVE_ACTIVITY_DORMANT_MS},
  updated_ms=excluded.updated_ms
 WHERE excluded.push_token<>push_token OR excluded.apns_env<>apns_env OR excluded.activity_ms>activity_ms+${SAME_ACTIVITY_TOLERANCE_MS}`;
const TRIM_SQL = `DELETE FROM live_activity_end WHERE user_id=?1 AND workout_id<>?2 AND workout_id NOT IN
 (SELECT workout_id FROM live_activity_end WHERE user_id=?1 AND workout_id<>?2 ORDER BY updated_ms DESC LIMIT ${ROWS_PER_USER - 1})`;
// Due rows of ACTIVE accounts only: an account in deletion (sessions revoked) is never pushed; its rows go with the
// final erase or the 150-minute expiry.
export const DUE_SQL = `SELECT user_id,workout_id,push_token,apns_env,revision,attempts FROM live_activity_end
 WHERE state='PENDING' AND end_ms<=?1 AND (retry_ms IS NULL OR retry_ms<=?1)
  AND EXISTS(SELECT 1 FROM users WHERE users.id=live_activity_end.user_id AND users.account_status='ACTIVE' AND users.deleted_at IS NULL)
 ORDER BY end_ms LIMIT ${LIVE_ACTIVITY_SENDS_PER_RUN}`;
// The minute probe term (bound: now, now - send lease, now - expiry age): due sends, interrupted sends to sweep, rows
// to expire. True only when the step has something to do.
// Due PENDING rows count only for ACTIVE accounts (as DUE_SQL), so a deleting account's row does not wake the step
// every minute. With APNs unconfigured, a due row still wakes it (logged `live_activity_end_unconfigured`) until the
// row expires (150 min after its last report): one extra D1 batch per minute, bounded.
export const LIVE_ACTIVITY_PROBE_SQL = `EXISTS(SELECT 1 FROM live_activity_end WHERE (state='PENDING' AND end_ms<=? AND (retry_ms IS NULL OR retry_ms<=?)
  AND EXISTS(SELECT 1 FROM users WHERE users.id=live_activity_end.user_id AND users.account_status='ACTIVE' AND users.deleted_at IS NULL))
  OR (state='SENDING' AND claimed_ms<=?) OR updated_ms<=?)`;
export function liveActivityProbeBindings(nowMs) { return [nowMs, nowMs, nowMs - SENDING_LEASE_MS, nowMs - LIVE_ACTIVITY_MAX_AGE_MS - LIVE_ACTIVITY_DORMANT_MS]; }
const SWEEP_SQL = `UPDATE live_activity_end SET state='PENDING',retry_ms=?1,last_error='SEND_INTERRUPTED' WHERE state='SENDING' AND claimed_ms<=?2`;
const EXPIRE_SQL = `DELETE FROM live_activity_end WHERE updated_ms<=?1`;
const CLAIM_SQL = `UPDATE live_activity_end SET state='SENDING',claimed_ms=?1,attempts=attempts+1
 WHERE user_id=?2 AND workout_id=?3 AND revision=?4 AND state='PENDING' AND end_ms<=?1`;
// Finalized only by the claim that sent: a send that outlived its lease (swept, re-claimed at the same revision by a
// later run) can no longer overwrite that newer claim.
const FINAL_SQL = `UPDATE live_activity_end SET state=?1,retry_ms=?2,last_error=?3,apns_env=?4,claimed_ms=NULL
 WHERE user_id=?5 AND workout_id=?6 AND revision=?7 AND state='SENDING' AND claimed_ms=?8`;

export function parseSchedule(input, nowMs) {
  const workoutId = typeof input?.workoutId === 'string' ? input.workoutId : '';
  const pushToken = typeof input?.pushToken === 'string' ? input.pushToken.toLowerCase() : '';
  const environment = ['sandbox', 'production', 'auto'].includes(input?.environment) ? input.environment : null;
  // ISO instants with an explicit zone only (no runtime-local parsing).
  const instant = value => typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : NaN;
  const activity = instant(input?.activityAt);
  const sent = instant(input?.sentAt);
  if (!WORKOUT_ID.test(workoutId) || !PUSH_TOKEN_PATTERN.test(pushToken) || !environment || !Number.isFinite(activity) || !Number.isFinite(sent)) return { error: 'LIVE_ACTIVITY_INVALID' };
  // Both times come from the same phone clock: their difference is how long ago the activity happened, whatever the
  // phone's offset. Negative (activity "after" sending) counts as now.
  const elapsed = Math.max(0, sent - activity);
  if (elapsed >= LIVE_ACTIVITY_MAX_AGE_MS) return { stale: true, workoutId };
  return { workoutId, pushToken, environment, activityMs: nowMs - elapsed };
}

// auth (403) and throttling/server errors (429/5xx): 15 min, as Apple advises; network/IdleTimeout: 1,2,4,8,15 min.
export function retryDelayMs(outcome, attempts) {
  if (outcome === 'auth' || outcome === 'throttled') return 15 * 60 * 1000;
  return Math.min(2 ** (attempts - 1), 15) * 60 * 1000;
}

export async function scheduleLiveActivityEnd(env, userId, input, nowMs = Date.now()) {
  const parsed = parseSchedule(input, nowMs);
  if (parsed.error) return { status: 400, code: parsed.error };
  if (parsed.stale) {
    // A late, stale report must not delete a row that holds newer activity.
    await env.DB.prepare('DELETE FROM live_activity_end WHERE user_id=?1 AND workout_id=?2 AND activity_ms<=?3').bind(userId, parsed.workoutId, nowMs - LIVE_ACTIVITY_MAX_AGE_MS).run();
    return { status: 200, code: 'LIVE_ACTIVITY_EXPIRED' };
  }
  const [, written] = await env.DB.batch([
    env.DB.prepare(TRIM_SQL).bind(userId, parsed.workoutId),
    env.DB.prepare(SCHEDULE_SQL).bind(userId, parsed.workoutId, parsed.pushToken, parsed.environment, parsed.activityMs, nowMs),
  ]);
  // No write = the same activity again (tolerance) or an inactive account; both answer with the stored deadline.
  const row = await env.DB.prepare('SELECT end_ms FROM live_activity_end WHERE user_id=?1 AND workout_id=?2').bind(userId, parsed.workoutId).first();
  // Never 401 here: the session is valid (the app would sign the user out). No row = the account is not ACTIVE (the
  // route's session check already excludes that) or a concurrent cancel/expiry removed it; nothing is scheduled.
  if (!row) return { status: 200, code: 'LIVE_ACTIVITY_NOT_SCHEDULED' };
  return { status: 200, code: 'LIVE_ACTIVITY_SCHEDULED', endAt: new Date(row.end_ms).toISOString(), changed: Boolean(written?.meta?.changes) };
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
      // A sandbox token on production is BadDeviceToken; a Sandbox-only key on production is a wrong-environment key.
      if (!(hosts.length > 1 && FALLBACK_REASONS.has(result.reason))) break;
    }
    const outcome = classify(result);
    const attempts = row.attempts + 1;
    let state = 'PENDING', retry = null;
    if (outcome === 'sent') { state = 'SENT'; sent++; }
    else if (outcome === 'dead') state = 'DEAD';
    else if (attempts >= MAX_ATTEMPTS) state = 'FAILED';
    else retry = nowMs + retryDelayMs(outcome, attempts);
    const finalEnv = row.apns_env === 'auto' && outcome === 'sent' ? used : row.apns_env;
    await env.DB.prepare(FINAL_SQL).bind(state, retry, outcome === 'sent' ? null : `${result.status}:${result.reason || ''}`.slice(0, 80), finalEnv, row.user_id, row.workout_id, row.revision, nowMs).run();
    // Never log the push token or the provider token.
    log({ event: 'live_activity_end', outcome, status: result.status, reason: result.reason, apnsId: Boolean(result.apnsId), env: used });
  }
  return { sent, rows: rows.length };
}

// HTTP: the session identifies the user; nothing in the body can name another account. Native app requests carry no
// Origin; a browser request must be same-origin (as every other authenticated JSON POST).
export async function handleLiveActivityRequest(request, env, pathname) {
  const action = ({ '/api/live-activity/end': 'schedule', '/api/live-activity/end/cancel': 'cancel' })[pathname];
  if (!action) return null;
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  const user = await currentUser(request, env);
  if (!user) return error('AUTH_REQUIRED', 401);
  let input;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return error('LIVE_ACTIVITY_INVALID', 413);
    input = JSON.parse(text);
  } catch { return error('LIVE_ACTIVITY_INVALID', 400); }
  try {
    const result = action === 'schedule' ? await scheduleLiveActivityEnd(env, user.id, input) : await cancelLiveActivityEnd(env, user.id, input?.workoutId);
    const { status, ...rest } = result;
    return json(rest, status);
  } catch (cause) {
    // Migration 0015 not applied yet: a distinct code, the only 503 on which the app backs off (and only before its
    // first accepted report). Any other failure (D1 outage): generic 503, retried on the app's next sync.
    const missing = /no such table: live_activity_end/.test(String(cause?.message || ''));
    console.warn(JSON.stringify({ event: 'live_activity_end_request_failed', code: missing ? 'LIVE_ACTIVITY_NOT_MIGRATED' : cause?.code || 'DATABASE_UNAVAILABLE' }));
    return error(missing ? 'LIVE_ACTIVITY_NOT_MIGRATED' : 'LIVE_ACTIVITY_UNAVAILABLE', 503);
  }
}
