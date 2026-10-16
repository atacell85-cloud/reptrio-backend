// Build 45 isolated STAGING Worker (`a2-workout-apnstest`, D1 `reptrio-apnstest`). Never the production Worker/D1.
// It runs the unchanged production Worker (worker/index.js: every /api route, the `* * * * *` minute cron with account
// purge + Live Activity end) on the test D1, so the device-test build (API base set at build time) exercises exactly the
// production code path without touching production. Accounts here are throwaway test accounts.
// Operator routes (need `Authorization: Bearer <APNSTEST_TOKEN>`, a Worker secret):
// - POST /apnstest/probe  HTTP/2 + ES256 check against both APNs hosts with a syntactically valid, unregistered token
//                         (no device is contacted): 403 MissingProviderToken without a provider token, 400 BadDeviceToken
//                         with an accepted key.
// - POST /apnstest/run    one minute cron step now (the production `scheduled` handler).
// - GET  /apnstest/rows   Live Activity end rows with the push token masked and no account identifiers.
// Anything outside /api/* that the production Worker would serve from static assets answers 404 here (no assets).
import worker from '../../../worker/index.js';
import { APNS_HOSTS, apnsConfig, providerToken, postLiveActivity, endPayload } from '../../../worker/apns.js';

const UNREGISTERED = 'ab'.repeat(32);
const MINUTE_CRON = '* * * * *';

export default {
  scheduled(event, env, ctx) { return worker.scheduled(event, env, ctx); },
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/apnstest/')) return operator(request, env, pathname);
    if (!pathname.startsWith('/api/') && pathname !== '/runtime-config.js' && pathname !== '/account-deletion-link') return json({ code: 'NOT_FOUND' }, 404);
    return worker.fetch(request, env, ctx);
  },
};

async function operator(request, env, pathname) {
  if (!(await authorized(request, env))) return json({ code: 'UNAUTHORIZED' }, 401);
  const now = Date.now();
  if (pathname === '/apnstest/probe' && request.method === 'POST') {
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
  if (pathname === '/apnstest/run' && request.method === 'POST') {
    const waits = [];
    await worker.scheduled({ cron: MINUTE_CRON, scheduledTime: now }, env, { waitUntil: promise => waits.push(promise) });
    await Promise.all(waits);
    return json({ ok: true });
  }
  if (pathname === '/apnstest/rows' && request.method === 'GET') {
    const { results } = await env.DB.prepare("SELECT substr(workout_id,1,8)||'…' AS workout,substr(push_token,1,6)||'…' AS token,apns_env,activity_ms,end_ms,revision,state,attempts,retry_ms,last_error,updated_ms FROM live_activity_end ORDER BY updated_ms DESC LIMIT 20").all();
    return json({ now, rows: results });
  }
  return json({ code: 'NOT_FOUND' }, 404);
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
