# Build 48 — production rollout record (backend)

User approval (2026-10-22, chat): "kotayı aç" → option 1 "Hepsini şimdi aç"; no temporary Turkish compatibility for
Build 47 clients (test phase, single test user). APNs code unchanged; no user data touched.

| Step | Result |
|---|---|
| Source | `build48/integration` `feb6afd` (= Guardian round 4 PASS runtime `cb12e4c` + `wrangler.jsonc` var `PLACES_DAILY_QUOTA_POLICY=first-use-24h`) |
| Pre-check | APNs/Live Activity/cron files (`worker/apns.js`, `worker/live-activity-end.js`, `worker/index.js`, `worker/account-lifecycle.js`, `wrangler.jsonc` triggers) identical to production `b6b379b`; previous version `8db02608` vars = config vars; full `npm test` PASS |
| Restore point | D1 Time Travel bookmark `00000270-00000000-0000510c-88be5d94922d31fc2fc28e16c4e30d87` (2026-10-22T20:27:40Z) — restore only with explicit approval |
| Migration | `0017_places_autocomplete_quota.sql` applied remote ✅; table present, 0 rows; `users` count unchanged (87) |
| Deploy | Worker `a2-workout` version **`900e5cbf-414b-4f63-83d9-fe85a3bc2dae`** (previous `8db02608-bb72-4920-bd23-9f5294db227c`); 13 secret names identical; vars + `PLACES_DAILY_QUOTA_POLICY=first-use-24h`; crons `*/15`, `* * * * *`, `0 6 * * *` |
| Post-deploy (unauthenticated) | `/api/auth/providers` 200, `/runtime-config.js` 200, `/` 200, `app.reptrio.com` 200, `/api/me` 401, `/api/places/autocomplete` + `/verify` 401 `AUTH_REQUIRED` (same as baseline) |
| Crons on new version | minute ×2 and `*/15` observed via tail: outcome `ok`, 0 exceptions |
| Authenticated canary | **PASS (after analysis)** — owner-run `logs/prod-canary-b48.mjs`, 2026-10-22T20:37:23Z–20:53:05Z, synthetic account `86ae2199-0fbc-4fc9-94d4-b1ae2d1fa71f`. 18/19 checks PASS on first evaluation: register 201; sync pull 200; manual gym push 200 + persisted (no Place ID); Build 47 body autocomplete 200/3 + `attribution:'Google Maps'`; verify 200; `tr-TR/TR` 200/3; `ja-JP/JP` 200/5; unsupported locale dropped 200; malformed locale 400; 2 chars 400; after limit: still `PLACES_DAILY_LIMIT`, verify 200, manual gym push 200; deletion link 202 → verify 200 → `DELETE_NOW` 202 → session 401. The quota check reported FAIL (`admitted 96`, `4 × 429 PLACES_RATE_LIMITED`, then `PLACES_DAILY_LIMIT`) because of a **wrong script expectation** (see below); re-evaluated: 96 ≤ 100 ≤ 96 + 4 → PASS |
| Quota analysis | The script's 96 already included the 4 searches before the quota loop. `PLACES_RATE_LIMITED` comes from two sources: the Worker burst limiter (refused before counting) and a **Google upstream 429** (dispatched, unit kept by design). Replaying the run on the real route: burst-limiter hypothesis → refusal at client count 100; Google-429 hypothesis → refusal at **96** = observed. Conclusion: Google returned 4 × 429 during ~10 req/min pacing; backend accounting correct (server = 100). Pinned by `places-quota-test` §4b; canary now asserts `admitted ≤ 100 ≤ admitted + rateLimited` |
| Erasure (D1 read-only, after canary) | `users` row and all 27 `user_id` tables: 0 rows for `86ae2199…` (incl. `places_autocomplete_usage`, `auth_sessions`, `sync_*`); `places_autocomplete_usage` total 0 rows; users total 87 (unchanged from before the canary) |
| Open (not code) | Why Google answered 429 at ~10 req/min: check Google Cloud console → Places API (New) → Metrics (response code 429, 20:37–20:50 UTC) and Quotas (Autocomplete per-minute / per-minute-per-user limits). Follow-up proposal (needs approval + deploy): distinct code for upstream 429 and decide whether a Google 429 should keep the user's unit |

Rollback: previous version `8db02608…` via `wrangler rollback` (0017 is additive and harmless to it), or remove the
`wrangler.jsonc` var and redeploy to disable only the quota.

## B48-D — per-host APNs credentials (2026-10-23)

User approvals (chat, one per step): 1 key probe, 2 secret staging without deploy, 3a version upload without deploy,
3b deploy of the verified version at 100%. No key material, JWT or push token was printed, logged or committed.

| Step | Result |
|---|---|
| 1 Key probe (`scripts/ops/apns-key-probe.mjs`, team `C4P47F32C8`) | `U3823N4ZK5`: production ACCEPTED, sandbox WRONG_ENVIRONMENT. `6WD2B976UM`: sandbox ACCEPTED, production WRONG_ENVIRONMENT. `4WQVKDCLV3` (App Store Connect key): invalid on both, not an APNs key. Installed `APNS_KEY_ID` inferred Production-only from the 2026-10-22 record (accepted on production, `403:BadEnvironmentKeyInToken` on sandbox); value not readable |
| 2 Secrets staged | `wrangler versions secret bulk` (stdin, no file): `APNS_SANDBOX_KEY_ID`, `APNS_SANDBOX_PRIVATE_KEY` → version `03113e98-4c64-437d-b369-182b6bbe5ec5` (code = `900e5cbf`), not deployed. Note: `wrangler secret list` reads the latest version; `wrangler versions secret list` shows the deployed one |
| 3a Upload | `wrangler versions upload` from `0b3e408` (clean tree) → **`2d52c211-665e-418a-9d60-d7d952576596`**; 15 secrets inherited (13 + 2 sandbox); non-secret bindings fingerprint identical to `900e5cbf` (vars incl. `PLACES_DAILY_QUOTA_POLICY=first-use-24h`, D1 `a2-workout-pilot`, queue, 4 rate limiters, assets); bundle diff vs `feb6afd` only in `worker/apns.js`, `worker/live-activity-end.js` and an esbuild rename (`credential`→`credential2`) in `worker/account-lifecycle.js`; 481 assets hash-identical; backend `npm test` PASS |
| 3b Deploy | Pre-check repeated (no newer version, same fingerprints, live crons `* * * * *`, `0 6 * * *`, `*/15 * * * *` via API). `wrangler versions deploy 2d52c211…@100%` at 2026-10-23T19:08:42Z; previous `900e5cbf` |
| Post-deploy | `/api/auth/providers` 200, `/runtime-config.js` 200, `/` 200, `app.reptrio.com` 200, `/api/me` 401, `/api/places/autocomplete` + `/verify` 401 `AUTH_REQUIRED` (same as baseline). Tail on `2d52c211`: minute cron ×7 and `*/15` ok, 0 exceptions, 0 error logs. D1 read-only: `live_activity_end` 0 rows, users 87, `places_autocomplete_usage` 0. No 100-search Places canary (not repeated by decision) |
| APNs | **Not yet verified on a device**: no Live Activity row existed, so no APNs send happened after deploy. Acceptance = physical locked-iPhone test (row `SENT`, `apns_env='sandbox'`, legs production 400 `BadDeviceToken` → sandbox 200) plus a separate TestFlight/production check |

Rollback: `wrangler versions deploy 900e5cbf-414b-4f63-83d9-fe85a3bc2dae@100%` (no schema change in B48-D; the
sandbox secrets stay on `03113e98`/`2d52c211`). Staging Worker `a2-workout-apnstest` still lacks `APNS_SANDBOX_*`.

### B48-D physical acceptance — locked dev iPhone, Build 47 app (2026-10-23)

Owner ran the workout; the agent only observed (read-only D1, redacted `wrangler tail`). No code, config, secret or
deploy change during the test; live Worker `2d52c211-665e-418a-9d60-d7d952576596` at 100% throughout.

| Check | Result |
|---|---|
| Schedule | `POST /api/live-activity/end` 200 at 20:20:38 UTC; row `PENDING`, `apns_env=auto`, `revision=0` |
| Clock | last meaningful activity 20:20:36 UTC → server end 20:50:36 UTC (exactly +30 min); app was not opened before the end |
| APNs legs | cron 20:51:21 UTC: production `400 BadDeviceToken` → sandbox `200` (apns-id present); no 403, so installed `APNS_KEY_ID` is the Production key and `APNS_SANDBOX_*` is accepted on sandbox |
| D1 | `SENT`, `apns_env='sandbox'`, `attempts=1`, `last_error` null |
| Worker health | 0 exceptions, 0 error logs for the whole window |
| Lock screen (owner-reported) | Live Activity **disappeared** after the end push |

Verdict: **B48-D sandbox path ACCEPTED** (physical, locked, development-signed iPhone). Not covered: TestFlight /
App Store (`apns_env='production'`) send, staging Worker secrets, foreground local dormancy, Apple Watch dormancy.
The exact wall-clock time of disappearance was not recorded.
