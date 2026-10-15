// Build 45 B45-APNs-01 isolated APNs feasibility Worker (`a2-workout-apnstest`, D1 `reptrio-apnstest`). Never the
// production Worker/D1. Every HTTP route needs `Authorization: Bearer <APNSTEST_TOKEN>` (Worker secret).
// - POST /probe     HTTP/2 + auth check against both APNs hosts with a syntactically valid but unregistered token:
//                   without a provider token APNs answers 403 MissingProviderToken (proves the HTTP/2 path reached
//                   APNs; APNs does not speak HTTP/1.1); with APNS_* configured it answers 400 BadDeviceToken (proves
//                   key id, team id, .p8 and topic are accepted). No device is contacted.
// - POST /schedule  { workoutId, pushToken, environment, activityAt } for the fixed test user (real D1 path).
// - POST /cancel    { workoutId }
// - POST /run       one minute step now (same code as the cron).
// - GET  /rows      scheduler rows with the push token masked.
// The cron runs the same minute step.
import { runLiveActivityEnds, scheduleLiveActivityEnd, cancelLiveActivityEnd } from '../../../worker/live-activity-end.js';
import { APNS_HOSTS, apnsConfig, providerToken, postLiveActivity, endPayload } from '../../../worker/apns.js';

const TEST_USER = 'apnstest-user';
const UNREGISTERED = 'ab'.repeat(32);

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runLiveActivityEnds(env)); },
  async fetch(request, env) {
    if (!(await authorized(request, env))) return json({ code: 'UNAUTHORIZED' }, 401);
    const { pathname } = new URL(request.url);
    const now = Date.now();
    if (pathname === '/probe' && request.method === 'POST') {
      const config = apnsConfig(env);
      const jwt = config.ready ? await providerToken(config, now) : null;
      const results = [];
      for (const [name, host] of Object.entries(APNS_HOSTS)) {
        const started = Date.now();
        const anonymous = await postLiveActivity({ host, token: UNREGISTERED, jwt: null, payload: endPayload(now), nowMs: now });
        results.push({ host: name, auth: 'none', ...anonymous, apnsId: Boolean(anonymous.apnsId), ms: Date.now() - started });
        if (jwt) {
          const signed = await postLiveActivity({ host, token: UNREGISTERED, jwt, payload: endPayload(now), nowMs: now });
          results.push({ host: name, auth: 'es256', ...signed, apnsId: Boolean(signed.apnsId) });
        }
      }
      return json({ configured: config.ready, results });
    }
    if (pathname === '/schedule' && request.method === 'POST') {
      await ensureUser(env);
      const result = await scheduleLiveActivityEnd(env, TEST_USER, await request.json().catch(() => ({})), now);
      return json(result, result.status);
    }
    if (pathname === '/cancel' && request.method === 'POST') {
      const result = await cancelLiveActivityEnd(env, TEST_USER, (await request.json().catch(() => ({}))).workoutId);
      return json(result, result.status);
    }
    if (pathname === '/run' && request.method === 'POST') {
      const logs = [];
      const result = await runLiveActivityEnds(env, { log: entry => { logs.push(entry); console.log(JSON.stringify(entry)); } });
      return json({ ...result, logs });
    }
    if (pathname === '/rows' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT workout_id,substr(push_token,1,6)||\'…\' AS token,apns_env,activity_ms,end_ms,revision,state,attempts,retry_ms,last_error FROM live_activity_end').all();
      return json({ now, rows: results });
    }
    return json({ code: 'NOT_FOUND' }, 404);
  },
};

async function ensureUser(env) {
  await env.DB.prepare("INSERT OR IGNORE INTO users(id,email,password_hash,password_salt,created_at) VALUES (?1,'apnstest@example.invalid','x','x',?2)").bind(TEST_USER, new Date().toISOString()).run();
}
async function authorized(request, env) {
  const expected = env.APNSTEST_TOKEN || '';
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (expected.length < 32 || given.length !== expected.length) return false;
  const [a, b] = await Promise.all([given, expected].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
