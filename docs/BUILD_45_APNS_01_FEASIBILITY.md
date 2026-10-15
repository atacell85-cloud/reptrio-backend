# Build 45 · B45-APNs-01 — Live Activity end via APNs: isolated feasibility

Status: **FEASIBILITY IN PROGRESS — not a permanent architecture.** Branch `build45/apns-feasibility` in both repos
(backend from `integration/build44` `d1be882`, mobile from `0b51e60`). Nothing here is wired into the production Worker
(`worker/index.js`), its crons, the production D1 or the shipped app. Build 44 branches and the installed device build
are unchanged.

## Goal
End the Live Activity ~30 minutes after the last meaningful workout activity while the iPhone is locked and the app is
suspended (iOS gives the app no timed wake-up; `staleDate` only marks it stale). Only an ActivityKit `end` push can.

## Candidate code (this branch)
| Piece | File |
|---|---|
| APNs provider API: ES256 provider token (40-min iat buckets), `liveactivity` request, `end` payload, outcome classes | `worker/apns.js` |
| Scheduler: report/cancel, minute step (sweep → expiry → due → claim by revision → send → finalize by revision) | `worker/live-activity-end.js` |
| Candidate table `live_activity_end` (additive, user FK `ON DELETE CASCADE`) | `migrations/0015_live_activity_end.sql` |
| Tests (real SQLite + repo migrations, fake APNs) | `scripts/live-activity-end-test.mjs` (`npm run test:live-activity-end`) |
| Isolated test Worker | `scripts/ops/apnstest/entry.mjs`, `scripts/ops/apnstest/wrangler.apnstest.jsonc` |
| Mobile client half (not wired) | mobile `src/live-activity-end-schedule.ts`, `scripts/test-live-activity-end-schedule.mjs` |

### Verified facts
- **Voltra 2.2.0:** per-activity push tokens exist (`Activity.pushTokenUpdates` → JS event `activityTokenReceived`
  `{ activityName, pushToken }`, re-emitted on rotation). Requested only when `enablePushNotifications: true` in the
  Voltra plugin config (Info.plist `Voltra_EnablePushNotifications` + `aps-environment`); today it is `false`. No Swift
  work, but a native config change + new build. The event carries the stable activity name only, not an instance id.
- **`end` push format:** `apns-push-type: liveactivity`, topic `com.reptrio.mobile.push-type.liveactivity`, priority 10,
  body `{ aps: { timestamp, event: "end", "dismissal-date": now, "content-state": { uiJsonData } } }`. Voltra's
  ContentState requires Brotli+base64 `uiJsonData`; the embedded neutral state (228 B) was decoded by Voltra's own Swift
  `VoltraAttributes.ContentState` (direct and via the push JSON path) on the iOS 18 simulator.
- **Workers → APNs HTTP/2 (real Cloudflare, 2026-10-16):** the deployed test Worker reached both hosts and got APNs'
  own answer: `403 MissingProviderToken` with an `apns-id` header from `api.push.apple.com` (900 ms) and
  `api.sandbox.push.apple.com` (424 ms). APNs does not accept HTTP/1.1, so the HTTP/2 path works from Workers.
- **Real D1 path (test D1):** report → row `PENDING`, end = activity + 30:00; identical repeat → no write (revision 0);
  invalid token → 400; minute step without a key → nothing claimed, `live_activity_end_unconfigured` logged.

### Not yet proven (blocks the permanent architecture)
1. **ES256 auth with the real APNs key:** `/probe` must return `400 BadDeviceToken` (not 403) for both hosts.
2. **A real device token:** a sandbox `end` push dismisses a running Live Activity on the locked iPhone, incl. token
   rotation. Needs a development build with `enablePushNotifications: true` → it would replace the installed Build 44
   device build, so it waits for the Build 44 physical acceptance (user rule).

## Safety rules (each tested)
- Deadline = last meaningful activity + 30:00; never moves backwards (`MAX`), also when a rotated token arrives with an
  older activity time (late Watch event / reordered request). Identical reports write nothing.
- Continuation of the same workout moves the deadline; a send is claimed and finalized **by revision**, so a report that
  lands during a send is never marked sent and is re-armed for its new deadline.
- New token → re-armed (new activity, or a dead token replaced). Same token after `SENT` with newer activity → re-armed
  (the end push may never have reached an offline phone).
- `apns-expiration` = now + 5 min: an undelivered end push cannot close a continued activity much later.
- Per-activity tokens: an end push for an old activity can never close a new one (new activity = new token).
- Reported activity clamped to server time + 2 min; reports older than the 120-min auto-close delete the row; rows
  nobody updates expire 150 min after their last report.
- APNs outcomes: 410 / BadDeviceToken / DeviceTokenNotForTopic → `FAILED` (no retry); 403 auth → retry in 15 min;
  429 / 5xx / network → backoff 2,4,8,16,30 min, max 6 attempts; `auto` env tries production then sandbox on
  BadDeviceToken (development-signed Release builds get sandbox tokens). Interrupted sends are swept after 2 min.
- Logs never contain the push token or the provider token; the .p8 exists only as a Worker secret.
- Account deletion: rows cascade with the user (tested); production integration must still add the table to the final
  erase explicitly (FK-OFF paths exist).
- D1 cost: idle minute = 1 batch / 3 statements (production: fold `DUE_SQL` into the existing minute probe → 0 extra
  trips); per send + 2 statements. Writes: ≤ 1 row per changed report.

## Isolated test Worker (state 2026-10-16)
- Worker `a2-workout-apnstest` (workers.dev URL only, 1 cron `* * * * *`), D1 `reptrio-apnstest`
  (`eeff9885-3413-4ae6-a232-3b7d2324a65a`, migrations 0001–0015). No routes, queues, rate limiters, mail or OpenAI keys.
- Secrets: `APNSTEST_TOKEN` (random, kept only in the operator's local scratch file). `APNS_TEAM_ID` = `C4P47F32C8` (var).
  **Missing (user action): `APNS_KEY_ID`, `APNS_PRIVATE_KEY`.**
- Account after deploy: 4 Workers, crons 1/5 (production a2-workout 0; Build 44 deploy adds 3 → 4/5).

### User step: add the APNs key (only here)
Apple Developer → Certificates, Identifiers & Profiles → Keys → a key with **Apple Push Notifications service (APNs)**
(Sandbox or Sandbox & Production, team C4P47F32C8). Then, in this repo:
```
npx wrangler secret put APNS_KEY_ID      -c scripts/ops/apnstest/wrangler.apnstest.jsonc   # paste the 10-char Key ID
npx wrangler secret put APNS_PRIVATE_KEY -c scripts/ops/apnstest/wrangler.apnstest.jsonc < /path/to/AuthKey_XXXXXXXXXX.p8
```
Never commit, paste into chat or log the .p8. Then the operator runs `POST /probe` (expect `400 BadDeviceToken` with
`auth: es256` on both hosts) and `POST /run` on a fake-token row (expect production → sandbox fallback → `FAILED`).

### Cleanup (after the feasibility test, before the Build 44 production deploy is not required: 1 + 3 ≤ 5 crons)
```
npx wrangler delete a2-workout-apnstest
npx wrangler d1 delete reptrio-apnstest
```

## Cost / risk
- Money: none (Workers Free, APNs free). CPU: one ES256 sign per 40-min bucket per isolate (~1 ms) + ~0.5 ms per fetch;
  must be measured on the production minute cron before integration (10 ms limit).
- Build 44 risk: none (separate branches, separate Worker/D1, no production change).
