# REPTRIO Build 48 — Coding Agent Execution Handoff

Created: 2026-10-22
Status: READY FOR AGENT / APNs PHYSICAL OBSERVATION IN PROGRESS
Read this file and `docs/build48/DECISIONS.md` in **both** repositories before any changes.
Repos:
- `atacell85-cloud/reptrio-mobile`, branch `build48/integration` (baseline Build 47 `ea80a22192cbb02ff8b4b185bd542f70381facc9`)
- `atacell85-cloud/reptrio-backend`, branch `build48/integration` (baseline Build 47 `0dfca57c445140597bba01c3fc61e37476ac4b18`)

## Agent mission
Implement the **non-APNs Build 48 scope** now, in safe, reviewable slices. Do not repeat work already present in Build 47. Start with a read-only audit of the exact current branches, diff, decisions and tests. Use isolated worktrees if necessary; do not touch or reset the operator's existing Build 47 / installed iOS build / dirty worktrees. All code changes must remain on Build 48 branches. Tests and Guardian before marking any slice done. Explicitly separate implemented/tested from proposed/pending.

## Confirmed existing behavior to preserve
- `src/GymPickerModal.tsx`: Autocomplete **already fires automatically** for 3+ character input after a **400 ms debounce**; there is **no separate 'Ara' button** and **no visible quota counter**. Keep this; do not invent a second search control or spend time recreating it.
- `src/GymPickerModal.tsx`: Google Maps attribution/logo, service terms, privacy, manual gym creation, Place ID verify, stable existing gym ID/name, archive/reactivation and history rules already exist. Preserve policies and accessibility, including in Light/Dark.
- `worker/places-api.js`: authenticated server-side Places proxy, per-account Cloudflare rate limiter, Place ID verification, session token flow; API key stays server-side.
- `app/workout.tsx`: the entry button currently reads `Yeni salon ekle · Google Haritalar` (near line 272), which violates the approved entry label.
- `worker/places-api.js`: provider autocomplete is currently hard-coded `languageCode:'tr', regionCode:'tr'`, which violates worldwide behavior.
- `src/gyms.ts`: manual name match uses `toLocaleLowerCase('tr-TR')`. Audit the impact on worldwide names and historical identity; do not blindly change the matching identity algorithm or merge existing gyms.

## Slices (ordered for low risk)

### B48-A — Entry label / present UX
1. Replace the workout-screen **entry button** label with exactly `Salon ekle` (not `Google Haritalar`). Preserve accessibility and visual behavior.
2. Preserve existing automatic autocomplete, 3-character minimum, debounce, no `Ara` button and no visible 'remaining searches' display.
3. Ensure clearing text, dismissing the modal, changing input during network latency, choosing a result, and network errors cannot display stale results or cause unnecessary provider requests. Introduce cancellation/dedup only if tests demonstrate a gap; ensure no unintended extra API requests.
4. When quota is unavailable/exhausted, manual salon entry must remain available with useful localized explanatory text; search never blocks local manual save.
5. Google Maps logo/attribution and policy links must remain visible where Google content is rendered. Do not globally remove Google legal attribution just to simplify the entry label.
6. Tests: entry text, autocomplete trigger/debounce, stale responses, manual fallback, selection/verification, accessiblity, both themes.

### B48-B — Worldwide Places API behavior
1. Remove hardcoded Turkish `languageCode` / `regionCode` in provider autocomplete. Pick a backward-compatible, validated API contract for optional user locale and region (or omit a country restriction when not grounded); do not default every account to Turkey or Istanbul. Report precise choice and rationale.
2. Maintain compatibility with installed Build 47 clients: `{input,sessionToken}` and `{placeId,sessionToken}` remain valid. Add optional fields only if safely validated, with strict body limits, no location data without appropriate choice/permission, and no client exposure of the Places API key.
3. Keep Place Details verification independent from Autocomplete limits. Preserve ephemeral Google text vs persisted Place ID and user-entered display name; no storage/logging of provider name, address, coordinates or search text.
4. Check existing `tr-TR` case-folding in `src/gyms.ts` for cross-language collisions; preserve past IDs/history/manual labels and do not silently rewrite existing stored gyms.
5. Tests: multilingual Unicode names, e.g. Turkish I/İ, English and non-Latin text; locale validation; no country bias for unspecified users; malicious inputs; backward-compatible Build 47 requests; unchanged Place ID verification.

### B48-C — Per-user 100 Autocomplete requests/day
1. Approved allowance: **100 actually dispatched upstream Autocomplete requests per authenticated user per day, shared across devices**. Not 10. Do **not** count Place ID verification. Do not conflate Cloudflare's existing short-window limiter, global billing safety/budget and this new daily per-user limit.
2. Design persistent, **atomic race-safe** accounting in backend/D1 for concurrent devices and duplicate requests; migration must be additive and safe with currently deployed migration 0016 and account erasure. Avoid unnecessary DB writes per keystroke, but enforce the 100 ceiling before provider dispatch. Define outcomes for concurrent requests, provider timeout, upstream 429/5xx, retry and interrupted request with conservative billing-aware semantics.
3. **Unresolved product decision:** the exact per-day quota reset boundary/time zone is **NOT approved yet**. The superseded rule was Istanbul midnight; do not silently choose Istanbul **or UTC** as final policy. Propose viable globally fair policies (e.g. UTC calendar day vs rolling 24h) with cost/UX/travel edge cases. Implement quota infrastructure/testable day-bucket abstraction and non-dependent slices, but keep the reset-dependent behavior behind a safe release gate until the user approves the policy. Do not ship or deploy with an unapproved boundary.
4. Preserve provider account-wide spending protection and real provider usage monitoring distinct from individual-user quotas. Validate current Google Places (New) pricing/terms, session token billing and attribution against current official docs before asserting a cost model.
5. Tests: concurrency across two+ devices, exactly 100 admitted and 101st rejected, reset boundary once chosen, restart persistence, duplicate requests, verification untouched, legacy clients, low/free budget, account deletion, partial migration/rollout compatibility.

## APNs / Live Activity — HOLD, not a coding task yet
- Current device: physical iPhone installed `1.2.0 (47)`, local signed release `.app` verified: Voltra push enabled, `aps-environment=development` (Sandbox), `main.jsbundle` SHA matched, signature PASS.
- Production Cloudflare secret **names** `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TEAM_ID` are all present (their values/environments not yet proven).
- Production `live_activity_end` D1 row last observed: `PENDING`, `auto`, `attempts=0`, no error; last meaningful activity 2026-10-22 16:52:47 UTC and **deadline 2026-10-22 17:22:47 UTC = 20:22:47 Istanbul**. Observation was at 16:59:39 UTC, **before** deadline, so zero attempts is expected and NOT evidence of a failing cron.
- Operator is conducting physical lock-screen test. **DO NOT** edit Live Activity/Watch code, APNs keys, scheduled Workers, production D1, production Worker or device builds while this test is in progress. No diagnosis or 'fix' based on a pending pre-deadline row.
- After the user supplies post-deadline read-only evidence (row state/attempts/error + actual lock-screen result), separately analyze server scheduling, APNs acceptance and foreground local dormancy. Existing Build 45 staging APNs end test PASS is not proof of this Build 47 production end-to-end.
- Read existing Build 45 record before suggesting any reimplementation: mobile `docs/builds/BUILD_1.2.0-45.md`, backend `docs/BUILD_45_APNS_01_FEASIBILITY.md`.

## Safety / deliverables
- Keep Build 47, `main`, previous builds, user data and installed app intact. No merges, production migrations, production deploy, APNs secret edits, TestFlight/EAS, native install, or cloud resource creation without separate user approval.
- Preflight: print current repo path, branch, exact HEAD, worktree status; preserve any existing user changes; read both decision files plus relevant source/tests.
- Implement incrementally with meaningful tests. Run focused suites, typecheck and relevant repo Guardian; never report tests as run unless actual logs/results exist. Review backward compatibility and billing/policy compliance.
- Commit/push only verified Build 48 changes to the designated Build 48 branches (not any Build 47 branch); use small named commits and report SHAs. If a concurrent Build 48 update exists, fetch/reconcile safely, no force push.
- Output a final factual report: source baselines, exact changes, old behavior not modified, test evidence, unresolved quota reset decision, deferred APNs work, and the precise next physical/production acceptance checks.

## Explicit blocker handling
If policy reset remains undecided, proceed fully with B48-A and B48-B and independently testable portions of B48-C. Report the one required policy decision clearly; do not stall everything or fabricate an answer.
