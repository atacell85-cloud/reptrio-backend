# REPTRIO Build 48 — Coding Agent Execution Handoff

Created: 2026-10-22
Status: READY FOR AGENT / B48-D AND B48-E QUEUED (NO CODE CHANGE BY THIS DOC)
Read this file and `docs/build48/DECISIONS.md` in **both** repositories before any changes.
Repos:
- `atacell85-cloud/reptrio-mobile`, branch `build48/integration` (baseline Build 47 `ea80a22192cbb02ff8b4b185bd542f70381facc9`)
- `atacell85-cloud/reptrio-backend`, branch `build48/integration` (baseline Build 47 `0dfca57c445140597bba01c3fc61e37476ac4b18`)

## Agent mission
Implement approved Build 48 work in safe, reviewable slices: B48-A/B/C first, then queued backend APNs credential routing B48-D and legacy catalog-link compatibility B48-E (mobile). Do not repeat work already present in Build 47. Start with a read-only audit of the exact current branches, diff, decisions and tests. Use isolated worktrees if necessary; do not touch or reset the operator's existing Build 47 / installed iOS build / dirty worktrees. All code changes must remain on Build 48 branches. Tests and Guardian before marking any slice done. Explicitly separate implemented/tested from proposed/pending.

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
3. **Superseded 2026-10-22 — decided `first-use-24h` (see DECISIONS.md).** Original text: the exact per-day quota reset boundary/time zone is **NOT approved yet**. The superseded rule was Istanbul midnight; do not silently choose Istanbul **or UTC** as final policy. Propose viable globally fair policies (e.g. UTC calendar day vs rolling 24h) with cost/UX/travel edge cases. Implement quota infrastructure/testable day-bucket abstraction and non-dependent slices, but keep the reset-dependent behavior behind a safe release gate until the user approves the policy. Do not ship or deploy with an unapproved boundary.
4. Preserve provider account-wide spending protection and real provider usage monitoring distinct from individual-user quotas. Validate current Google Places (New) pricing/terms, session token billing and attribution against current official docs before asserting a cost model.
5. Tests: concurrency across two+ devices, exactly 100 admitted and 101st rejected, reset boundary once chosen, restart persistence, duplicate requests, verification untouched, legacy clients, low/free budget, account deletion, partial migration/rollout compatibility.

### B48-D — APNs Sandbox/Production credential separation (backend, after A/B and unblocked C slices)
**New verified defect (2026-10-22):** physical iPhone runs development-signed 1.2.0 (47), `aps-environment=development`; production D1 recorded `live_activity_end` `PENDING`, `auto`, deadline **2026-10-22 17:22:47 UTC**, and **after deadline** at 17:26:41 UTC: `attempts=1`, `last_error=403:BadEnvironmentKeyInToken`. Thus mobile scheduling, 30-min server deadline and cron send attempt are observed working; APNs environment/credential mismatch is the confirmed **remote-end delivery** blocker. Do not claim the foreground/local or Watch dormancy problem is fixed by this.

Apple Developer UI shows distinct Team Scoped keys: **REPTRIO Production APNs** (Production, created Oct 18) and **Reptrio Live Activity APNs** (Sandbox, created Oct 16), plus an unrelated Expo key supporting Sandbox & Production. Production Worker has `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TEAM_ID` **secret names** present; the secret *values* / which key ID is actually installed have not been read or proven. Current `worker/apns.js` / `worker/live-activity-end.js` reuse the same credential/JWT for both hosts, despite host fallback on `BadEnvironmentKeyInToken`.

**Scope and order:**
1. First confirm code paths, historical Build 45 sandbox acceptance and current Build 47 production send error. Preserve Build 45 scheduler architecture, cron schedule, 30m event semantics, existing D1 data and backward compatibility.
2. Implement separate **environment-specific credentials** for Apple provider token generation on Build 48 backend. **Keep existing** `APNS_KEY_ID` + `APNS_PRIVATE_KEY` as the production credential *only after validating its environment via safe metadata/probe*; add separate `APNS_SANDBOX_KEY_ID` + `APNS_SANDBOX_PRIVATE_KEY` for Sandbox. Existing team ID can be shared if valid for both keys; do not assume if accounts/teams differ. JWT cache and token selection must be scoped by credential/environment; never reuse a production-only token on the sandbox host. For `apns_env=auto`, preserve safe host fallback and make each host use its matching credential. Prefer missing-credential fail-closed handling that does not drop a valid pending activity prematurely.
3. Do not rotate/delete/overwrite production APNs secrets or touch Expo/Apple OAuth keys. Do not print private keys, live activity tokens, device IDs or JWTs in tests/logs. Never put secrets in Git.
4. Test sandbox and production separate keys, auto fallback `BadEnvironmentKeyInToken`/`BadDeviceToken`, explicit environments, invalid/missing host credential, retry/expiration, race/revision guard, APNs 200 and 403 responses, cron/resource budgets and no regression to production push or Build 47 client payloads. Document how to identify the currently deployed Key ID safely without reading its private key.
5. Have independent HIGH Guardian review focused on credentials, auth, push correctness and regressions; commit/push tested code to **Build 48 backend only**. Prepare an operator runbook for adding the new **Sandbox secret names**, verifying both environments and observing physical 30-minute Live Activity dismissal.
6. **Release gate:** no `wrangler secret put/delete`, key uploads, production deployments, D1 writes/migrations, iOS builds, TestFlight or device install without a separate explicit approval. After backend release, validate real locked iPhone (Sandbox) and separate production/TestFlight APNs behavior. Independently investigate app foreground-local dormancy and Watch return-to-watch-face; do not claim this credential fix solves them.

**Scheduling:** This is newly queued after B48-A/B and the independently implementable B48-C work. Since the C daily reset policy is unresolved, **do not block D solely on that product decision**. Other already-started Build 48 work should continue without interruption.

### B48-E — Legacy RepDB IDs in routine-to-catalog linking (mobile; detailed investigation and safe migration)
**Status: IMPLEMENTED 2026-10-23 (mobile `build48/integration`, tests + HIGH Guardian PASS); installed user's exact row ID still needs physical confirmation.** Full engineering contract and regression matrix: **mobile `docs/build48/B48_E_LEGACY_CATALOG_LINK.md`**. READ IT IN FULL BEFORE CODING. This entry is not a one-line UI change and does not authorize automatic migration.

**Observed:** On physical Build 47, user sees an exercise named `glute-bridge` in routine edit but **"Katalogdaki hareketle eşleştir"** is absent. The *old* RepDB catalog includes canonical ID `glute-bridge` (`data/exercise-analytics.v1.json`), whereas the *new* 302-exercise catalog has `ex_000123` with `nameTr/nameEn: 'Glute Bridge'` and `sourceSlug: 'glute-bridge'` (`data/exercises.v2.json`). The newer importer makes `custom:name:glute-bridge-<hash>` and should already expose the action. The installed row's **actual** `exerciseId` was not read: reproduce with a synthetic legacy-ID fixture before claiming that particular row's root cause.

**True code root cause:** `isCustomExerciseId(x)` in `src/model.ts` accepts ONLY `custom:` prefix. This gate blocks legacy canonicals in (i) `app/builder.tsx` edit-modal button visibility, (ii) its `onReplace` callback, (iii) `chooseReplacement`, and (iv–v) `src/routine-catalog-link.ts` `previewRoutineCatalogLink` and `linkRoutineCatalogExercise`. Fixing just the button will still fail at confirmation/commit. The catalog query normalizer `src/exercises.ts` **already turns hyphens into spaces**, so replacing punctuation or fuzzy search globally is the wrong fix.

**Authorized behavior/design:** In all five gates, consistently allow *existing custom IDs* OR *known frozen pre-Build-46 RepDB canonical IDs* (validated by exact membership, e.g. the legacy metadata ID registry), with **no existing `catalogLink`**; keep modern `ex_######` IDs, unknown hyphenated IDs and malformed IDs ineligible. Do not broaden `isCustomExerciseId` globally, collapse historical alias identities, or use a separator check. Create one pure shared eligibility predicate and re-check against persisted row at commit. Require the user's **explicit** choice of a real active 302-catalog target and confirmation with exact matching/skipped historical counts; never auto-map `glute-bridge` to `ex_000123` from name alone. Preserve source ID and labels in reversible `catalogLink` journal.

**Data integrity:** Link only the chosen program/day/item and historical rows proved by matching `programId`, `dayId`, `itemId`, row's own `exerciseId` and exact pre-link `canonicalExerciseId`; skip ambiguous/unmatched data. Preserve independent routines, days, identical-name exercises, weights/reps/time, deleted history, 1.2 MB program-record limit, current Undo semantics and null-vs-absent label restoration. Old RepDB IDs remain standalone statistics identities except rows explicitly reclassified by this user action. Verify normalize/sync/backups and current Build 47 clients before release.

**Required tests:** `glute-bridge` legacy ID -> button -> picker `Glute Bridge (ex_000123)` -> explicit preview/confirm -> isolated history -> **exact Undo**. Also custom-ID unchanged, modern ex-ID no button, unknown hyphen ID no button, variants `glute bridge`/`Glute-Bridge` as search text, distinct barbell/single-leg candidates, cross-routine/date collisions, partial/foreign records, deleted history, null/absent fields, stale writes, backup/restore, stats and accessibility. Run `scripts/test-routine-catalog-link.mjs` plus new **red-before/green-after** tests and HIGH Guardian. Do not alter production data or installed Build 47.

**Queue:** follow B48-D in the ordered backlog, but this is a standalone mobile slice and is not blocked by the undecided B48-C daily-reset policy. No iOS installation, TestFlight, production deploy, migration or main merge without separate authorization.

## Physical APNs follow-up — remote-end evidence captured; no device mutation
- Latest post-deadline production read is `PENDING`, `auto`, `attempts=1`, `last_error=403:BadEnvironmentKeyInToken` (2026-10-22 17:26:41 UTC), after scheduled 17:22:47 UTC. Earlier `attempts=0` was a valid pre-deadline state; do not perpetuate it as the latest evidence.
- The user confirmed the development-signed physical Build 47 binary has Voltra push enabled and matching local JS bundle/signature. Production Worker contains all three APNs secret *names*, but the actual key identities are not verified; Apple Developer lists distinct Production and Sandbox APNs keys.
- The new credential-routing **code task** is B48-D above. Device-side local foreground timeout and Apple Watch returning to the watch face must be independently investigated after explicit device test evidence. Keep the current user device/build and production configuration untouched until separately approved.
- Prior Build 45 locked-iPhone staging APNs end push passed. Preserve it; do not reimplement an already shipped design. Read mobile `docs/builds/BUILD_1.2.0-45.md` and backend `docs/BUILD_45_APNS_01_FEASIBILITY.md`.

## Safety / deliverables
- Keep Build 47, `main`, previous builds, user data and installed app intact. No merges, production migrations, production deploy, APNs secret edits, TestFlight/EAS, native install, or cloud resource creation without separate user approval.
- Preflight: print current repo path, branch, exact HEAD, worktree status; preserve any existing user changes; read both decision files plus relevant source/tests.
- Implement incrementally with meaningful tests. Run focused suites, typecheck and relevant repo Guardian; never report tests as run unless actual logs/results exist. Review backward compatibility and billing/policy compliance.
- Commit/push only verified Build 48 changes to the designated Build 48 branches (not any Build 47 branch); use small named commits and report SHAs. If a concurrent Build 48 update exists, fetch/reconcile safely, no force push.
- Output a final factual report: source baselines, exact changes, old behavior not modified, test evidence, unresolved quota reset decision, B48-D APNs key-separation evidence/gates, B48-E legacy-linking verification and history/Undo test evidence, and the precise next physical/production acceptance checks.

## Explicit blocker handling
If policy reset remains undecided, proceed fully with B48-A and B48-B and independently testable portions of B48-C. Report the one required policy decision clearly; do not stall everything or fabricate an answer.
