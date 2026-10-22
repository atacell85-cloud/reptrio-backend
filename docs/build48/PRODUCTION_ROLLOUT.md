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
| Authenticated canary | PENDING — `logs/prod-canary-b48.mjs` (owner-run synthetic account; search, locale, verify, manual gym, 100/101 quota, deletion) |

Rollback: previous version `8db02608…` via `wrangler rollback` (0017 is additive and harmless to it), or remove the
`wrangler.jsonc` var and redeploy to disable only the quota.
