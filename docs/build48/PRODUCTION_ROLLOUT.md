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
