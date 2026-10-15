// Build 45 B45-APNs-01 CANDIDATE: APNs provider API for ActivityKit Live Activity pushes (token-based auth, ES256).
// Workers `fetch` speaks HTTP/2 to APNs on the deployed edge (not under local `wrangler dev`); APNs refuses HTTP/1.1.
// The .p8 key only ever comes from the Worker secret APNS_PRIVATE_KEY; it is never logged or returned.

export const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
export const LIVE_ACTIVITY_TOPIC = 'com.reptrio.mobile.push-type.liveactivity';
// Valid Voltra ContentState for the final instant before the immediate dismissal: a Brotli/base64 render of a neutral
// "Antrenman beklemede" view (no workout data). Generated from Voltra 2.2.0 renderLiveActivityToString + Node Brotli and
// verified with Voltra's own Swift decoder (VoltraAttributes.ContentState, incl. the push JSON path) on iOS 18.
export const END_CONTENT_STATE = { uiJsonData: 'G94BoIzUVnkjBA9BAPNK/VbluEdJ8AClDkvX0/OgpVqLrS1uAXa+n+ACB7rY1S9ygkOdbPtAUGSHIBSHGyM0kbzDRg9NE/mFqerxy74Nymfjb32DLA+K4B8QNTY6qMfhoG2XdPkrmOvXFNcb6VcI+UgxQ9ejOVckpYHVOty2wrMJvu1ffA+RsINmioQTsFWVo43684dmHyL8CbE48u51zHr1SdkvDvWqZaoc' };
// A provider token is valid for one hour and must not be refreshed more often than every 20 minutes: claims are bucketed
// to 40 minutes, so every invocation inside a bucket presents the same iat (and an isolate reuses the signed string).
const TOKEN_BUCKET_SECONDS = 40 * 60;
let memo = { key: '', token: '' };

export function apnsConfig(env) {
  const config = { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKey: env.APNS_PRIVATE_KEY };
  return { ...config, ready: Boolean(/^[A-Z0-9]{10}$/.test(config.keyId || '') && /^[A-Z0-9]{10}$/.test(config.teamId || '') && config.privateKey) };
}

export async function providerToken(config, nowMs) {
  const iat = Math.floor(nowMs / 1000 / TOKEN_BUCKET_SECONDS) * TOKEN_BUCKET_SECONDS;
  const memoKey = `${config.keyId}:${config.teamId}:${iat}`;
  if (memo.key === memoKey) return memo.token;
  const input = `${b64urlJson({ alg: 'ES256', kid: config.keyId })}.${b64urlJson({ iss: config.teamId, iat })}`;
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(config.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)));
  memo = { key: memoKey, token: `${input}.${b64url(signature)}` };
  return memo.token;
}

export function endPayload(nowMs) {
  const now = Math.floor(nowMs / 1000);
  // dismissal-date in the past/now removes the Live Activity immediately (Apple: otherwise up to 4 hours later).
  return { aps: { timestamp: now, event: 'end', 'dismissal-date': now, 'content-state': END_CONTENT_STATE } };
}

// Hex of the token bytes: even length, 16..256 bytes.
export const PUSH_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){16,256}$/;

// One APNs request. Returns { status, reason, apnsId } and never throws for HTTP outcomes; a network failure is
// status 0 with reason 'NetworkError'. `jwt` null sends no authorization header (connectivity probe only).
export async function postLiveActivity({ host, token, jwt, payload, nowMs, expirationSeconds = 300, fetchImpl = fetch }) {
  if (!PUSH_TOKEN_PATTERN.test(token)) return { status: 0, reason: 'InvalidTokenFormat', apnsId: null };
  const headers = {
    'apns-push-type': 'liveactivity',
    'apns-topic': LIVE_ACTIVITY_TOPIC,
    'apns-priority': '10',
    // Short store-and-forward window: an end push that cannot reach an offline phone soon must not close a later
    // continuation of the same activity hours after; the app's local rule handles that case.
    'apns-expiration': String(Math.floor(nowMs / 1000) + expirationSeconds),
    'content-type': 'application/json',
  };
  if (jwt) headers.authorization = `bearer ${jwt}`;
  try {
    const response = await fetchImpl(`${host}/3/device/${token}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    let reason = null;
    if (response.status !== 200) { try { reason = (await response.json())?.reason ?? null; } catch { reason = null; } }
    return { status: response.status, reason, apnsId: response.headers.get('apns-id') };
  } catch {
    return { status: 0, reason: 'NetworkError', apnsId: null };
  }
}

// APNs outcome -> what the scheduler does with the row.
export function classify({ status, reason }) {
  if (status === 200) return 'sent';
  if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic' || reason === 'InvalidTokenFormat') return 'dead';
  if (status === 403 || reason === 'InvalidProviderToken' || reason === 'ExpiredProviderToken' || reason === 'MissingProviderToken') return 'auth';
  if (status === 400 || status === 413) return 'dead';
  return 'retry';
}

function pemBytes(pem) {
  const base64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer;
}
function b64url(bytes) { let text = ''; bytes.forEach(byte => { text += String.fromCharCode(byte); }); return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function b64urlJson(value) { return b64url(new TextEncoder().encode(JSON.stringify(value))); }
