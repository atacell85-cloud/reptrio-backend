# REPTRIO Build 57 — Combined backend release readiness (19 November 2026)

**STATUS: INTEGRATED SOURCE ONLY — COMBINED TESTS AND DEPLOY NOT DONE.**

## Exact inputs and candidate

- Production source baseline reported: `8f49687dea8ee21788b7aad42750cc1485022be5` (reconfirm actual deployed Worker version before deploying).
- Data Level 3 / B57-002 backend commit: `7ff9d11196a2939c20d9b9090144f62c58e94339` — HIGH Guardian PASS on that isolated branch (reported).
- AI import matching / B57-007 backend head: `a555d892ac65abca1f9dc5708ed02ae2882d74b8` — HIGH Guardian PASS on isolated branch (reported).
- Combined merge commit: `31b7bcfa2143765c00e74bdde62317ce7f99e6cb` — two parent SHAs above; imported B57-007-only files integrated without replacing any B57-002 code. Overlapping `package.json` manually reconciled, preserving `test:draft-exercise-removal`, `test:pwa-upgrade-required`, `test:import-catalog-match` in full `npm test`.
- Feature safety configuration added on **this candidate branch only**: `wrangler.jsonc` has `DRAFT_EXERCISE_REMOVAL_ENABLED: "false"`, so capability `draftExerciseRemoval` must be absent until separately approved for activation. Do not treat config presence as runtime proof: verify deployment bindings and actual capabilities endpoint.
- Mobile Build 57 integration branch: `atacell85-cloud/reptrio-mobile:build57/implementation`, expected head `a32210f0c8369bd996c9da7af98b0378046f049d`.

## Mandatory **pre-deploy** checks on combined code (not yet run)

1. Clone or fetch this **combined candidate branch** in an isolated, clean worktree. Do not rewrite original B57-002/B57-007 branches, local source trees, or the production Worker.
2. Run `npm ci` if a project lockfile is present, otherwise the repository's existing documented install method; then `npm test`, `npm run cf:build`, and `npx wrangler deploy --dry-run`. Verify no unrelated modifications and no secrets in logs.
3. Run actual cross-repo B57-002 and B57-007 tests from the mobile integrated branch against **this candidate**, not against each old branch in isolation. Use synthetic accounts and nonproduction SQLite/D1 only. Verify the combined import endpoint and Data Level 3 capabilities both respond as designed.
4. Explicitly test that the Worker with `DRAFT_EXERCISE_REMOVAL_ENABLED=false` omits `draftExerciseRemoval`; the mobile Build 57 then hides the remove action. Also verify settings do not disable unrelated `draftSetDeletion`.
5. Validate additive migration `migrations/0019_import_catalog_match.sql` on an isolated DB that reflects production migrations. Verify the import jobs table gains exactly one nullable column `catalog_match_json`; no existing jobs/rows deleted.
6. Check deployed D1 migration state **read-only** first (0016–0018 prerequisite, 0019 pending). Do not assume statuses from older reports. Production apply of 0019 is a separate privileged write operation and not authorized by this document.
7. Review Service Worker/PWA cache update and Data Level 3 behavior: users with older mobile versions and the web app will permanently lose read/write sync on a level-3 account until supported clients update. Read-only capability query remains available. First-load PWA old-cache risk remains documented.
8. Confirm branch integration has not weakened user data protections, account ownership, auth, reset, backup/restore and record sync; review combined diff and test results. Record specific passing evidence rather than borrowing isolated HIGH Guardian PASS as combined-code certification.

## Controlled release order — only after a separate explicit production approval

1. Back up / snapshot D1 and record real production counters, queue/cron status and current Worker hash. Verify that migration 0019 has **not** already been applied; prevent double-apply. Confirm 0016–0018 already exist.
2. Apply only 0019 to the **authorized** production D1 using reviewed change process; verify column and pre/post counts before proceeding. Do not apply on staging and assume production is equivalent.
3. Deploy **this tested combined Worker + PWA assets** with `DRAFT_EXERCISE_REMOVAL_ENABLED=false`. Confirm Cloudflare actual env/bindings and that `draftExerciseRemoval` is absent. Verify AI catalog match capability/endpoint, current account data, HTTP health, auth, old clients and import failures. Roll out mobile only after backend acceptance.
4. Build and install mobile Build 57 using the approved physical-install safety wrapper with preservation of local data. Run physical iPhone/Watch/Live Activity acceptance. Do not auto-publish TestFlight/App Store or merge main.
5. Only after **all devices** expected to share accounts are upgraded and physical checks pass, obtain separate user approval to enable removal, verify capability and race behavior on designated synthetic multi-device QA accounts. First exercise removal upgrades account data to level 3 permanently, so disabling capability later does not downgrade existing accounts.

## Rollback / failure warning

- Disable the capability flag first; **do not naively revert to the older level-2 Worker after any level-3 write**. It can allow legacy reads/writes and schema-loss risk. Prefer a forward fix with the level-3 read/write gate retained.
- If 0019 is applied, treat it as an additive existing column; do **not** remove it in a hasty rollback. Review migration and import job compatibility before rolling Worker code back.
- Do not promise that the old Build ≤56 mobile will explain 'upgrade required'; it shows generic waiting/failure while preserving local data. Phone removal/reset before upgrade may lose unsynced local-only data.
- Current PWA is intentionally read/write blocked for Data Level 3 accounts. Not an acceptable claim of full web compatibility.

## Authorization boundary

This is a source-preparation artifact, **not** evidence of combined test PASS or permission for production migration/deploy, physical install, TestFlight, App Store submission, feature enablement or main merge. Review both integrated functionality and physical UX before release. No customer-account data should be modified by the preparation tasks.
