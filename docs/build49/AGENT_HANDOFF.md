# REPTRIO Backend Build 49 — agent handoff

**Durum:** B49-001 QUEUED (UX APPROVED) / NO RUNTIME IMPLEMENTATION AUTHORIZED.

Branch: `atacell85-cloud/reptrio-backend:build49/integration` from frozen Build 48 `f05401234af0ebd92dbadaf4c35a7270b04a1a05`. Paired mobile branch: `atacell85-cloud/reptrio-mobile:build49/integration` from `e4019edbd145a8cd0675faf659ef5c966a94619b`.

Read the Build 48 production rollout and Sandbox APNs physical result, current `docs/build48/AGENT_HANDOFF.md`, `docs/build49/DECISIONS.md`, and mobile `BUILD_49.md` before planning. Build 48 test status: user PASS for 5/7 mobile controls; Build 48 Watch and Live Activity are pending, not PASS. Sandbox APNs real-device closure PASS on Build 47 is separate.

Preserve live Worker `2d52c211-665e-418a-9d60-d7d952576596`, existing 15 secret names, D1 schema and bindings, APNs environment routing and first-use-24h quota. No deployment/migration/secret changes without explicit approval.

Queued independent operations item: OPS-PREFLIGHT — fail-closed, secret-value-safe verification before the *next backend deployment*. Plan and review before coding. `prelaunch/topics` AS-PRE-001 is reserved for first public App Store readiness; it does not block current device/TestFlight activity by itself.

**B49-001 selected for development queue:** Location-aware gym autocomplete and an explicitly user-triggered, distance-ranked Nearby Search only inside **Yeni salon ekle**. Permission is requested on entering that screen; absent usable authorization means **manual-only** (no Google search). Existing saved gyms require no location and generate no Nearby charges. Full mobile specification: `atacell85-cloud/reptrio-mobile:build49/integration/docs/build49/B49_001_LOCATION_AWARE_GYM_DISCOVERY.md`. Before any coding define API contract, mobile/back-end rollout order, privacy, input validation, strict per-user AND provider budget limits, field masks/SKU pricing, race control, compatibility, tests, rollback, Guardian and physical acceptance. No exact Nearby quota or spending cap approved yet. This is not runtime or deploy permission.
