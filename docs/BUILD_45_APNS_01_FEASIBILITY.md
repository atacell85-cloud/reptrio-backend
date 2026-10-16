# Build 45 — Live Activity end via APNs (feasibility → integration)

Status (2026-10-16): **integrated on branch `build45/live-activity-end`** in both repos (from `build45/apns-feasibility`,
which comes from `integration/build44`: backend `d1be882`, mobile `0b51e60`). Build 45's sole scope (user decision;
mobile `DECISIONS.md`). Wired into `worker/index.js` (routes) and the existing minute cron; **not** deployed to
production, migration 0015 **not** applied to the production D1. Device testing runs against the isolated staging
Worker (below). Build 44 branches and artifact are unchanged.

## Integration (Build 45)
| Piece | Where |
|---|---|
| `POST /api/live-activity/end` `{ workoutId, pushToken, environment, activityAt, sentAt }`, `POST /api/live-activity/end/cancel` `{ workoutId }` — session auth (`currentUser`, ACTIVE accounts only), JSON POST, same-origin, ≤ 2 KB body | `worker/live-activity-end.js` `handleLiveActivityRequest`, routed in `worker/index.js` after the ACTIVE-account DB gate |
| Write only for an ACTIVE account (atomic `INSERT … SELECT … WHERE EXISTS(users ACTIVE)`); at most 3 rows per user (the reported workout always kept) | `SCHEDULE_SQL`, `TRIM_SQL` |
| Minute step inside the existing `* * * * *` cron: one extra `EXISTS` term in the lifecycle minute probe (idle minute = still one D1 call); bounded (≤ 3 sends), never in the same invocation as a purge step (both due → alternate by minute), its failure never blocks the purge; no additional cron | `worker/account-lifecycle.js` `minuteProbe`, `purgeDueAccounts`; `LIVE_ACTIVITY_PROBE_SQL` |
| Before 0015 is applied: the probe falls back to the unchanged lifecycle probe (purge unaffected, retried every 15 min per isolate), routes answer 503 (the app backs off 10 min) | same |
| `claimed_ms` race closed: `FINAL_SQL` finalizes only its own claim | `FINAL_SQL` |
| Account deletion: no push for a non-ACTIVE account (`DUE_SQL`), table erased explicitly in the final purge (FK on/off) | `DUE_SQL`, `worker/account-api.js` `purgeAccountData` |
| Tests | `scripts/live-activity-end-test.mjs` (scheduler, `apns-expiration` pinned to now + 300 s), `scripts/live-activity-integration-test.mjs` (routes, cron fold, fallback, erase, claim race) |
| Mobile | `src/live-activity.ios.tsx` (token persisted with the activity, report after every coordinator pass), `src/live-activity-end-schedule.ts`, `src/api.ts`; Info.plist `Voltra_EnablePushNotifications` |

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
  logged. Re-verified on the deployed test Worker after the Guardian fixes (smoke: 401 without token, non-ISO time 400, report 200, probe 403 MissingProviderToken on both hosts); the deployed test Worker version and its commit are listed under "Isolated test Worker".

- **ES256 auth with the real APNs key (2026-10-16, Sandbox key added by the user): PASS.** `/probe` with the key:
  sandbox `400 BadDeviceToken` (key id, team, .p8 and topic accepted; only the fake device token rejected); production
  `403 BadEnvironmentKeyInToken` (expected for a Sandbox-only key). Without a token both hosts: `403 MissingProviderToken`.
- **Minute step against real APNs:** `auto` row → production 403 `BadEnvironmentKeyInToken` → sandbox fallback →
  400 `BadDeviceToken` → `DEAD`; `sandbox` row → 400 → `DEAD`; `production` row → 403 → retry in 15 min (then
  cancelled). Apple's live reason string is `BadEnvironmentKeyInToken`, not the documented `BadEnvironmentKeyIdInToken`;
  the fallback originally matched only the documented spelling and would never have fallen back — fixed, both accepted.

### Not yet proven (blocks the permanent architecture)
1. **Production pushes need a production-capable key.** The current key is Sandbox-only: TestFlight / App Store builds
   get production device tokens, which this key cannot reach. Before production: a "Sandbox & Production" key (or a
   second production key) and a probe returning `400 BadDeviceToken` on the production host.
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
  push. Side effect: a genuinely newer activity within 5 s is absorbed, so the end can come up to 5 s early (not
  cumulative; a token/environment change still writes with the maximum applied). A replayed old request body can only postpone the end (by the replay delay), never bring it forward; the client
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
  DeviceTokenNotForTopic, 403 Forbidden (Apple: do not retry), any other 400/404 → `DEAD`; 403 (auth, BadEnvironmentKeyInToken / BadEnvironmentKeyIdInToken) → retry in 15 min; 429 / 5xx → retry in
  15 min (Apple's guidance); network / 400 IdleTimeout → 1,2,4,8,15 min; max 6 attempts → `FAILED`. `auto` tries
  production, then sandbox on BadDeviceToken (development-signed builds get sandbox tokens) or
  BadEnvironmentKeyInToken / BadEnvironmentKeyIdInToken (Sandbox-only key; the first is Apple's live answer).
  Interrupted sends are swept after 2 min.
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
- Secrets: `APNSTEST_TOKEN` (random, kept only in the operator's local scratch file), `APNS_KEY_ID`,
  `APNS_PRIVATE_KEY` (Sandbox key, added by the user via `wrangler secret put` on 2026-10-16; never seen by the operator).
  `APNS_TEAM_ID` = `C4P47F32C8` (var).
- Test D1 rows after the real-APNs run: `cf-auto` and `cf-sandbox` `DEAD` (400 BadDeviceToken, fake tokens);
  `cf-production` cancelled. They expire on their own after 150 min.
- Deployed code: the test Worker is redeployed from the clean branch head after every code change; the deployment
  list (`npx wrangler deployments list -c scripts/ops/apnstest/wrangler.apnstest.jsonc`) is the record (e.g. `ce3912fc`
  = `80f7f47`, Guardian R4 verified).
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
| Sandbox only (observed) | 403 BadEnvironmentKeyInToken | 400 BadDeviceToken |
| Production only | 400 BadDeviceToken | 403 BadEnvironmentKeyInToken (expected) |

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

## Review record
- Independent HIGH Guardian: R1 DURDURULDU (2 MAJOR: slow phone clock; Sandbox-only key fallback / user step) → R2
  (MINOR: latency jitter re-armed SENT rows; Forbidden retried) → R3–R5 (test gaps only) → **R6 GEÇTİ**. Final targeted
  mutation run: 42/42 killed; remaining survivors equivalent.
- Pre-integration items — **done in Build 45 integration:** `apns-expiration` pinned (now + 300 s); claim bound in
  `FINAL_SQL`; explicit table erase in the final purge; due check folded into the minute probe. Cron CPU / D1: measured
  on the staging Worker (section "Measurements").
- Real-key run (2026-10-16): Apple's live reason `BadEnvironmentKeyInToken` fixed in the fallback set; independent HIGH
  Guardian R7 **GEÇTİ** (11 mutants; the one survivor equivalent). Test Worker redeployed from the commit.

## Staging Worker for the device test (Build 45)
`a2-workout-apnstest` now runs the unchanged production Worker (`scripts/ops/apnstest/entry.mjs` → `worker/index.js`)
on the test D1 `reptrio-apnstest`: all `/api/*` routes and the production minute cron (purge + Live Activity end). No
assets, queues, rate limiters, mail or OpenAI keys (AI import and mail flows unavailable). Accounts there are throwaway
test accounts. Operator routes need `APNSTEST_TOKEN`: `POST /apnstest/probe`, `POST /apnstest/run` (one minute cron step),
`GET /apnstest/rows` (token masked, no account ids). The device-test build sets `EXPO_PUBLIC_REPTRIO_API_BASE_URL` to
the staging URL at bundle time; production builds never set it.

## Measurements (staging on real Cloudflare, 2026-10-16, version from `2da9061`)
- Real route + real minute cron: a report 31 min old → ended by the next cron through the folded probe (`auto`:
  production 403 `BadEnvironmentKeyInToken` → sandbox 400 `BadDeviceToken` → `DEAD`, fake token); a fresh report stayed
  `PENDING`; cross-origin → 403; no session → 401. Probe unchanged (sandbox ES256 PASS).
- CPU (`wrangler tail` `cpuTime`): idle minute 1–2 ms; minute with one end push 6–9 ms (6 samples, `auto` and
  `sandbox`); first invocations after a deploy (cold isolate + ES256 signing) 12 and 15 ms — all `outcome: ok`, but at or
  above the Free 10 ms figure. Report request 7–10 ms (same order as other authenticated routes). Probe (4 APNs requests)
  5 ms warm, 8–11 ms cold.
- Consequences applied: ≤ 3 sends per minute (was 5); an end step and a purge step never share an invocation (both due →
  alternate by minute). Residual: a cold-isolate minute can exceed 10 ms; if Cloudflare ever cancels such an invocation
  the claim is swept after 2 min and retried (≤ 6 attempts), so the end comes a few minutes late; if the cancelled invocation had already sent, the retry is a second end push to an activity that is already ended (no effect).
- D1: idle minute 1 read; per end push +3 statements; per changed report 1 batch (trim + upsert) + 1 read.

## Production activation (separate explicit permission; not done)
Prerequisites: Build 44 production deploy (migrations ≤ 0014) done first; a **Sandbox & Production** APNs key (or a
production key) — TestFlight/App Store builds have production tokens, which the current Sandbox-only key cannot reach.
1. Backup: `npx wrangler d1 export a2-workout-pilot --remote --output <file>` (schema+data, operator machine only).
2. Apply only 0015: `npx wrangler d1 migrations apply a2-workout-pilot --remote` (additive: one table + one index).
   Verify: `SELECT name FROM sqlite_master WHERE name LIKE 'live_activity_end%'`.
3. Secrets on `a2-workout`: `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (user, `wrangler secret put`), var `APNS_TEAM_ID`.
   Without them the cron logs `live_activity_end_unconfigured` and sends nothing.
4. Deploy the Worker from the reviewed commit (`npm run cf:deploy`); crons stay 3.
5. Verify: `POST /api/live-activity/end` with a real session → 200; Workers Logs `live_activity_end` events; minute cron
   CPU in the dashboard.
6. Then a production-API app build (TestFlight, separate permission).

Rollback (each step independent, no user data at risk):
- Kill switch: `npx wrangler secret delete APNS_PRIVATE_KEY` → no pushes (rows stay, expire after 150 min).
- Code: `npx wrangler rollback <previous version id>` (the previous Worker ignores the table; the app backs off on 404).
- Schema: leaving `live_activity_end` in place is harmless; if it must go: `DROP TABLE live_activity_end;` (contains only
  push tokens and timestamps, no workout data) — only after the code rollback.
- Clients: an app on the new build against a backend without the route stays on the local 30-min rule.

## Build 45 integration review
Independent HIGH Guardian (both repos): round 1 DURDURULDU — MAJOR client backoff on any 503 after a successful report
(later sets unreported → possible end mid-workout); MINOR post-write 401 (app sign-out), logout cancel claim, wording,
swallowed assertions, untested production guard; LOW dead code, probe woke for deleting accounts, untested retry/timeout.
All fixed with tests; round 2 **GEÇTİ** (19/21 targeted mutants killed, two harmless LOW survivors).
