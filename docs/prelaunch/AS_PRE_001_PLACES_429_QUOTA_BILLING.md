# AS-PRE-001 — Google Places 429 source, rate limits, cost and quota audit

**Milestone:** PRE–APP STORE PUBLIC LAUNCH (before first public App Store release).
**Status:** OPEN / DEFERRED; not a blocker for current developer-only physical testing or TestFlight by itself.
**Priority:** P1 for App Store launch readiness; assess severity again if a real reliability/billing issue is proven.
**Owner:** REPTRIO backend + mobile (cross-repo investigation); technical implementation requires a separate plan/review.
**Recorded:** 2026-10-23.
**Important:** This branch contains **planning only**. No production code, rate-limit setting, Cloudflare secret, D1 record, rollout or mobile build is changed or authorized by this task.

## Purpose

Resolve the ambiguity of `429 PLACES_RATE_LIMITED`, establish defensible Google Places API (New) quotas and spending controls for public users, and verify that the **per-user 100-request allowance for 24 hours starting with the first counted upstream Autocomplete attempt** is appropriate and explainable under real-world usage. The scope is **App Store public release preparation**, not an emergency Build 48 fix.

The existing production quota and manual gym fallback should continue operating under the previously accepted Build 48 policy unless separate evidence and user approval justify a change. Keep B48-D APNs and B48-E legacy exercise linking in their current Build 48 development queue.

## Observed evidence (2026-10-22 Build 48 production canary)

- Production Worker version reported at rollout: `900e5cbf-414b-4f63-83d9-fe85a3bc2dae`, source `build48/integration` at `feb6afd`, migration `0017_places_autocomplete_quota.sql` applied and `PLACES_DAILY_QUOTA_POLICY=first-use-24h` enabled.
- Logged result: `FAIL quota-101st-refused {"admitted":96,"earlyLimitAt":96,"status":429,"code":"PLACES_DAILY_LIMIT","burstLimited":4,"otherErrors":0}`.
- Canary's test code was corrected (backend regression test and mobile cross-repo test updated); the corrected acceptance criterion accounts for the fact that a returned `PLACES_RATE_LIMITED` could have originated **either** before a dispatch (Cloudflare limiter; no quota unit spent) **or** after it (Google's 429; a quota unit already reserved).
- Under the two simulated explanations, the old script's apparent `admitted=96` is consistent with 100 reserved units if those four 429s were upstream. **The original log alone does not independently prove Google issued each of the four 429s.** Do not declare their actual source conclusively without logs/Google Cloud metrics.
- Other authenticated checks passed: legacy Build 47 request body, Turkish and Japanese locale inputs, Place ID verification, manual gym persistence, refusal after quota, manual gym and verification after exhaustion, account deletion. The canary account and its `places_autocomplete_usage` D1 row were subsequently reported absent by read-only checks.
- This is **not** evidence that the production Worker has a counting defect; avoid re-running another 100 real Google calls unless an explicitly approved minimal test is indispensable.

## Technical root of the ambiguity (source-backed)

Read these current **Build 48 sources** before coding:

1. `worker/places-api.js`, `handlePlacesRequest`: `env.PLACES_LIMITER.limit({key:'places:'+user.id})` runs **before** daily quota reservation. On rejection it returns HTTP 429 with `code: "PLACES_RATE_LIMITED"` without sending to Google.
2. Same file, `googlePlacesRequest`: a Google Places API **upstream** HTTP 429 also becomes HTTP 429 with the **same** `code: "PLACES_RATE_LIMITED"`, but only **after** daily quota reservation. The quota unit is not refunded on provider failure, by a conservative billing/at-least-once interpretation.
3. `worker/places-quota.js`: atomic D1 reservation `reservePlacesAutocomplete` limits each account to 100 *attempted upstream dispatches*, not 100 successful autocomplete result pages, over the chosen first-use-24h window.
4. `wrangler.jsonc`: `PLACES_LIMITER` is a separate per-account short-window limiter (at time of review: `limit:12, period:60`). It is not the 100-per-24-hour allowance or a Google-side quota.
5. Mobile `src/GymPickerModal.tsx`: maps `PLACES_RATE_LIMITED` to a short-window-style explanation; an upstream Google 429 may need a distinct explanation, but new UX must be assessed rather than assumed.
6. `migrations/0017_places_autocomplete_quota.sql` and `worker/account-api.js`: account-based accounting and account deletion are already implemented. Do not duplicate migrations or weaken data-erasure logic.

## Investigation scope (App Store readiness)

### A. Attribute the four 429 responses using authoritative evidence

- In **Google Cloud Console → Google Maps Platform → Places API (New) → Metrics / Quotas**, perform **read-only** analysis of **2026-10-22 20:37–20:50 UTC** (also inspect adjacent minutes for propagation or timezone offsets). Look at method `places:autocomplete` request count, response classes, 429/`RESOURCE_EXHAUSTED` if available and actual quota usage.
- Identify whether Google imposes a project-level / API-method / per-minute / per-user-per-minute quota relevant to this project. Record exact metric names, limits, units, date of observation, and credible proof (redacted screenshots / documented query, not credentials).
- Correlate with Cloudflare Workers request/counter evidence where available. Avoid relying on a single API code which currently conflates provider and edge denial. If precise reconstruction is impossible, **record it as unverified** and design future observability to disambiguate.
- Be clear about the difference between a Google 429, a Google API timeout, the per-account burst limiter, `PLACES_DAILY_LIMIT`, and project-wide budget/quota exhaustion.
- Do not alter Cloud project quotas while investigating. Do not expose API keys, tokens, user IDs, query strings, precise locations or other personal data in any reporting.

### B. Separate error types safely

Propose and, only **after separate approval**, implement two compatible response codes:
- Existing `429 PLACES_RATE_LIMITED` remains reserved for the **Worker/Cloudflare short-window pre-dispatch** limiter, where a 24h unit is not consumed.
- A separately named `429 PLACES_UPSTREAM_RATE_LIMITED` (working proposal; finalize API contract after review) identifies **Google's post-dispatch 429**, where a 24h unit was reserved.
- Keep `429 PLACES_DAILY_LIMIT` exclusively for the 100-unit gate.

Regression and backwards compatibility requirements:
- Legacy/current Build 47/48 clients that understand only `PLACES_RATE_LIMITED` must not break or expose raw errors; version/backward-compatible rollout sequence and mobile fallback must be explicitly designed. Do **not** silently rename the old error in production first.
- Map upstream 429 to a useful, accurate, localized user message. Avoid promising that an upstream error is resolved by merely waiting a fixed number of seconds unless verified.
- Keep manual gym creation and Place ID verification available and independent of Autocomplete errors/allowance. Preserve language/region input validation, Google Maps attribution, session tokens, authentication and API-key secrecy.
- Consider safe structured telemetry that distinguishes **upstream request attempted / provider 429 / edge burst rejection / quota exhausted** without logging the user's search term or identifiers. Metrics must have bounded cardinality, appropriate retention and privacy review.
- Test each response branch with mocked provider + Cloudflare limiter, and verify D1 count on every branch including provider timeout/5xx, aborted requests and concurrent devices.

### C. Confirm cost and policy with current official documentation

- Independently check **Google Places API (New)** pricing, SKU tiers, monthly free usage / credits, Autocomplete (New) billing, session tokens, Place Details (New) requests and Google quotas using **current Google documentation and actual Cloud Billing metrics**. Earlier reports cited **10,000 free requests/month and $2.83 per 1,000 afterward**; do **not** treat these quoted values as verified or permanent without confirming the precise SKU, tier and date.
- Explicitly distinguish **reserved REPTRIO quota units**, **upstream requests**, **successful Google results**, **Google-billed events**, and **billing alerts**. A reserved unit does not prove a fee; an upstream 429 may or may not be billed depending on terms.
- Analyze what counts as fair quota usage when Google returns 429/5xx or times out. **Current Build 48 decision:** reserve before outbound dispatch, **no refund** for uncertain outcomes. Document pros/cons and abuse/billing trade-offs of refunds, optional retry-safe reservation, and user perception; do not change without a fresh product decision.
- Review app-level 100/account/first-use-24h ceiling separately from Cloudflare short-window limits and Google Cloud budget/quota caps. A **budget alert is not a hard spend cap**. Define actionable alerts, hard caps where supported, response if Google quota exhausted, and safe manual fallback.
- Estimate App Store launch cost/usage scenarios with realistic user-count and search-session distributions. Do not fabricate Google billing usage or assume that a per-user limit provides a global monthly budget ceiling.

### D. App Store public-launch acceptance and rollout plan

Before marking this issue complete, deliver:
1. A dated, source-linked and redacted evidence report on the 2026-10-22 429s or a clear statement that attribution could not be proven retrospectively.
2. A documented API/mobile compatibility contract for distinct 429 codes and an implementation/release order if changes are approved.
3. Automated red-before/green-after tests for quota reservation, 429 sources, high-frequency concurrency, 100/101 boundary, 24h-window expiry, manual gym/verify continuity, and older mobile request compatibility.
4. Google Cloud quota/billing dashboard snapshot and production-safe operational runbook: owner, thresholds, telemetry, alerts, escalation and rollback.
5. Cost/abuse/UX analysis, with an **explicit user approval** for any change to the current rule about charging the 24h allowance on provider 429.
6. Independent Guardian HIGH security, privacy, data retention, billing and regression review if runtime/UI code changes.
7. Controlled small-scale post-change verification on authenticated test account **only when authorized**, minimizing upstream calls; never default to a 100-request paid canary.
8. App Store release go/no-go recommendation including known risks and remaining conditions.

## Out of scope / hard safety rules

- Do not turn this into a Build 48 rollout blocker or a mandatory step before the owner's current TestFlight/physical checks. **The due milestone is the first public App Store launch**.
- Do not edit or deploy current production Worker or D1 migration, change `PLACES_DAILY_QUOTA_POLICY=first-use-24h`, alter Google Cloud quotas/billing, touch secrets, or regenerate test accounts now.
- Keep Build 47 device install and previous shipped/staged binaries unchanged.
- Do not interfere with independently queued Build 48 B48-D (APNs) or B48-E (legacy catalog linking).
- No automatic refund on upstream 429; no redesign of the accepted quota until evidence + explicit owner approval.
- This document is a backlog plan, **not evidence that the investigation or implementation has been completed**.

## Pointers

- `docs/build48/PRODUCTION_ROLLOUT.md` (rollout and previous canary record).
- `worker/places-api.js`; `worker/places-quota.js`; `wrangler.jsonc`.
- Mobile `src/GymPickerModal.tsx`, `src/api.ts`.
- Build 48 decisions on Google Places global behavior, `first-use-24h`, and manual gym fallback in both repositories.
