// Build 48 B48-D operator tool (local only): which APNs environment(s) does a .p8 key work on?
//   node scripts/ops/apns-key-probe.mjs --key-file /path/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --team-id C4P47F32C8
// Sends ONE request per host (production, sandbox) over HTTP/2 with a syntactically valid, UNREGISTERED device token,
// so no device is ever contacted. Apple's answer tells whether the key is accepted on that host:
//   400 BadDeviceToken                      -> key ACCEPTED on this host (only the fake token was refused)
//   403 BadEnvironmentKeyInToken / ...IdIn  -> key belongs to the OTHER environment
//   403 InvalidProviderToken                -> wrong key id / team id / key material
// Prints only key id, host and verdict: never the key material or the signed provider token. Run it rarely (Apple
// throttles provider-token churn: TooManyProviderTokenUpdates).
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import { pathToFileURL } from 'node:url';
import { APNS_HOSTS, endPayload, LIVE_ACTIVITY_TOPIC, providerToken } from '../../worker/apns.js';

const UNREGISTERED = 'ab'.repeat(32);

export function keyProbeVerdict({ status, reason }) {
  if (status === 400 && reason === 'BadDeviceToken') return 'ACCEPTED';
  if (status === 403 && (reason === 'BadEnvironmentKeyInToken' || reason === 'BadEnvironmentKeyIdInToken')) return 'WRONG_ENVIRONMENT';
  if (status === 403 && reason === 'InvalidProviderToken') return 'INVALID_KEY_OR_TEAM';
  if (status === 403 && reason === 'ExpiredProviderToken') return 'CLOCK_OR_EXPIRED_TOKEN';
  if (status === 0) return 'NETWORK_ERROR';
  return 'UNEXPECTED';
}

function post(host, jwt, nowMs) {
  return new Promise(resolve => {
    const session = connect(host);
    session.on('error', () => resolve({ status: 0, reason: 'NetworkError' }));
    const request = session.request({
      ':method': 'POST', ':path': `/3/device/${UNREGISTERED}`, authorization: `bearer ${jwt}`,
      'apns-push-type': 'liveactivity', 'apns-topic': LIVE_ACTIVITY_TOPIC, 'apns-priority': '10',
      'apns-expiration': String(Math.floor(nowMs / 1000) + 60), 'content-type': 'application/json',
    });
    let status = 0, body = '';
    request.on('response', headers => { status = Number(headers[':status']); });
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { session.close(); let reason = null; try { reason = JSON.parse(body).reason ?? null; } catch {} resolve({ status, reason }); });
    request.on('error', () => { session.close(); resolve({ status: 0, reason: 'NetworkError' }); });
    request.setTimeout(10000, () => { request.close(); session.destroy(); resolve({ status: 0, reason: 'NetworkError' }); });
    request.end(JSON.stringify(endPayload(nowMs)));
  });
}

async function main(argv) {
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const keyFile = arg('--key-file'), keyId = arg('--key-id'), teamId = arg('--team-id');
  if (!keyFile || !/^[A-Z0-9]{10}$/.test(keyId || '') || !/^[A-Z0-9]{10}$/.test(teamId || '')) {
    console.error('usage: node scripts/ops/apns-key-probe.mjs --key-file <AuthKey.p8> --key-id <10 chars> --team-id <10 chars>');
    process.exit(2);
  }
  const nowMs = Date.now();
  const jwt = await providerToken({ keyId, teamId, privateKey: readFileSync(keyFile, 'utf8') }, nowMs);
  const verdicts = {};
  for (const [name, host] of Object.entries(APNS_HOSTS)) {
    const answer = await post(host, jwt, nowMs);
    verdicts[name] = keyProbeVerdict(answer);
    console.log(`${keyId} ${name.padEnd(10)} ${String(answer.status).padEnd(3)} ${String(answer.reason).padEnd(28)} ${verdicts[name]}`);
  }
  const use = verdicts.production === 'ACCEPTED' && verdicts.sandbox === 'ACCEPTED' ? 'both environments (APNS_* and/or APNS_SANDBOX_*)'
    : verdicts.production === 'ACCEPTED' ? 'production: APNS_KEY_ID / APNS_PRIVATE_KEY'
      : verdicts.sandbox === 'ACCEPTED' ? 'sandbox: APNS_SANDBOX_KEY_ID / APNS_SANDBOX_PRIVATE_KEY' : 'neither (check key id, team id and file)';
  console.log(`=> ${keyId} usable for ${use}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main(process.argv.slice(2));
