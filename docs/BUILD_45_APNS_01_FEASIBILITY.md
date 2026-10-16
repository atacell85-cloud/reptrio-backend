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
  invalid token or missing `sentAt` → 400; minute step without a key → nothing claimed, `live_activity_end_unconfigured`
  logged. Re-verified after the Guardian R1 fixes (test Worker version `6f3db2e1`).

### Not yet proven (blocks the permanent architecture)
1. **ES256 auth with the real APNs key:** `/probe` must return `400 BadDeviceToken` (not 403) for both hosts.
2. **A real device token:** a sandbox `end` push dismisses a running Live Activity on the locked iPhone, incl. token
   rotation. Needs a development build with `enablePushNotifications: true` → it would replace the installed Build 44
   device build, so it waits for the Build 44 physical acceptance (user rule).

## Report contract
`POST { workoutId, pushToken (hex), environment: sandbox|production|auto, activityAt, sentAt }` — `activityAt` is the
canonical activity clock (`draftActivityAt`), `sentAt` the phone clock at sending. The server uses only
`sentAt − activityAt` (0..120 min) against its own clock, so a phone clock that is fast or slow (tested ±25 min and
3 h slow) cannot move the deadline. `cancel { workoutId }` on finish.

## Safety rules (each tested)
- Deadline = last meaningful activity + 30:00 in server time; never moves backwards (`MAX`), also when a rotated token
  arrives with an older activity time (late Watch event / reordered request). A report within 5 s of the stored
  activity is the same report (the server-time derivation absorbs network latency): no write, no re-arm, no second
  push. A replayed old request body can only postpone the end (by the replay delay), never bring it forward; the client
  therefore stamps `sentAt` per HTTP attempt, uses a short timeout and no persisted replay queue.
- Continuation of the same workout moves the deadline; a send is claimed and finalized **by revision**, so a report that
  lands during a send is never marked sent and is re-armed for its new deadline.
- **Residual (in-flight race):** a report that arrives while the end push is already on its way is re-armed correctly,
  but the push already sent still ends the activity on the phone; the app is expected to restart it at its next
  foreground (current coordinator behaviour; unverified for this path until the client is wired).
- New token → re-armed (new activity, or a dead token replaced) — the deadline still follows the last activity, so a
  Live Activity re-created without new activity after 30:00 is ended within a minute. That matches the app's local
  rule (it never shows an activity for a dormant draft); wiring must keep that invariant to avoid a re-create/end loop.
- Same token after `SENT` or `FAILED` (retries exhausted) with newer activity → re-armed (the end push may never have
  reached an offline phone). `DEAD` (APNs rejected the token) is re-armed only by a new token.
- `apns-expiration` = now + 5 min asks APNs to drop an undelivered end push; Apple treats it as best effort, so this
  lowers — does not remove — the chance that a continued activity is closed late by an old push.
- Per-activity tokens: an end push for an old activity can never close a new one (new activity = new token).
- A report whose activity is ≥ 120 min old (auto-close) is stale: it removes the row only if the stored activity is
  stale too; rows nobody updates expire 150 min after their last report.
- APNs outcomes (Apple "Handling notification responses"): 410 Unregistered/ExpiredToken, BadDeviceToken,
  DeviceTokenNotForTopic, 403 Forbidden (Apple: do not retry), any other 400/404 → `DEAD`; 403 (auth, BadEnvironmentKeyIdInToken) → retry in 15 min; 429 / 5xx → retry in
  15 min (Apple's guidance); network / 400 IdleTimeout → 1,2,4,8,15 min; max 6 attempts → `FAILED`. `auto` tries
  production, then sandbox on BadDeviceToken (development-signed builds get sandbox tokens) or
  BadEnvironmentKeyIdInToken (Sandbox-only key). Interrupted sends are swept after 2 min.
- Client wiring requirement (mobile candidate): call the report on every draft/token change **and** on foreground and
  background wakes (Live Activity intent, Watch message); the sent state lives in memory, so a report lost offline is
  otherwise not retried and the server keeps the older deadline.
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
- Account (verified 2026-10-16): 4 Workers; crons: `a2-workout-apnstest` 1, `a2-workout` 0, others 0 → 1/5. The
  Build 44 production deploy adds 3 → 4/5 (still within the Free limit).

### User step: add the APNs key (only here)
Apple Developer → Certificates, Identifiers & Profiles → Keys → a key with **Apple Push Notifications service (APNs)**,
team C4P47F32C8, environment **Sandbox & Production** (recommended; the later production use needs it). Then, in this
repo:
```
npx wrangler secret put APNS_KEY_ID      -c scripts/ops/apnstest/wrangler.apnstest.jsonc   # paste the 10-char Key ID
npx wrangler secret put APNS_PRIVATE_KEY -c scripts/ops/apnstest/wrangler.apnstest.jsonc < /path/to/AuthKey_XXXXXXXXXX.p8
```
Never commit, paste into chat or log the .p8. Then the operator runs `POST /probe`. Expected `auth: es256` results:

| Key environment | production host | sandbox host |
|---|---|---|
| Sandbox & Production | 400 BadDeviceToken | 400 BadDeviceToken |
| Sandbox only | 403 BadEnvironmentKeyIdInToken | 400 BadDeviceToken |
| Production only | 400 BadDeviceToken | 403 BadEnvironmentKeyIdInToken |

`400 BadDeviceToken` = key id, team, .p8 and topic accepted. Any other 403 (InvalidProviderToken, …) = key problem.
Then check the fake-token `auto` row: the every-minute cron processes it within a minute of the key being added, so
read `GET /rows` (expect `DEAD`, last_error `400:BadDeviceToken` after production → sandbox fallback) rather than
relying on `/run`. The row expires 150 min after its report — re-`/schedule` it first if the key arrives later.
Each Worker isolate signs its own provider token within a 40-min bucket; whether APNs counts that as too many token
updates is unverified (a 429 is retried in 15 min).

### Cleanup (when the feasibility test is over; not needed before the Build 44 deploy: 1 + 3 ≤ 5 crons)
```
npx wrangler delete a2-workout-apnstest
npx wrangler d1 delete reptrio-apnstest
```

## Cost / risk
- Money: none (Workers Free, APNs free). CPU: one ES256 sign per 40-min bucket per isolate (~1 ms) + ~0.5 ms per fetch;
  must be measured on the production minute cron before integration (10 ms limit).
- `0015` sits in the shared `migrations/` directory on this branch only; it is applied only by an explicit
  `wrangler d1 migrations apply` (no CI step applies migrations) and it reserves the 0015 slot for this feature.
- Build 44 risk: none (separate branches, separate Worker/D1, no production change).
