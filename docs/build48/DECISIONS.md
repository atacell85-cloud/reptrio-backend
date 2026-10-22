# REPTRIO — Build 48 decisions and implementation boundary

Status: APPROVED DECISIONS / NOT YET IMPLEMENTED
Date: 2026-10-22
Branches: `build48/integration` in `reptrio-mobile` and `reptrio-backend`

## Frozen Build 47 baseline
- Mobile: `build47/release-candidate` @ `ea80a22192cbb02ff8b4b185bd542f70381facc9` (1.2.0 (47)).
- Backend: `build47/gyms-google-places` @ `0dfca57c445140597bba01c3fc61e37476ac4b18`.
- Do not modify Build 47, merge into `main`, upload TestFlight, or deploy backend production as part of branch setup. Physical acceptance is separate.

## Locked product decisions (latest decisions override older handover text)
1. **Google Places Autocomplete allowance:** maximum **100 actual Autocomplete requests per verified user per day**, not 10. The counter is account-based, shared across the user's devices, enforced in the backend with durable/atomic concurrency-safe accounting. Place ID verification does not consume the Autocomplete allowance.
2. **Global product:** REPTRIO must function worldwide. Do not hard-code Turkey, Turkish, Istanbul or `Europe/Istanbul` as a global default for time windows, locale, format, search geography or UX. Daily quota boundary: **resolved 2026-10-22 as `first-use-24h`** (see "User decision — 2026-10-22" below); the old Istanbul-midnight rule is superseded, not an instruction to silently substitute another time zone.
3. **Salon search UX:** no separate **“Ara”** button and no visible “remaining searches” counter. Design responsive Autocomplete without multiplying billable requests unnecessarily (minimum query length, input debounce, in-flight cancellation/deduplication, server-side protections). The earlier button-per-request approach is superseded.
4. **Entry label:** the workout screen's add-gym entry must say only **“Salon ekle”**, not “Google Haritalar” / “Google Maps”. Preserve the Google attribution/logo and terms wherever required by the Places experience; removing the wording from this button is not permission to remove legally required attribution.
5. **Fallbacks & cost controls:** manual gym entry remains available even when the user's quota is reached; preserve Place ID verification and safe stale-results behavior. Keep global provider-usage/cost protection distinct from per-user limits; monthly Google free usage is not itself an application quota.
6. **Apple Watch / Live Activity:** retain the **already implemented Build 45** ActivityKit APNs remote-end architecture (minute cron, canonical last meaningful activity + 30 minutes, foreground local cleanup, Watch dormancy). Build 45 staging physical locked-iPhone remote-end acceptance passed, but that does not prove Build 47 production behavior. The **2026-10-22 Build 47** production D1 row passed its 30-min deadline, made an APNs send attempt and received `403:BadEnvironmentKeyInToken`; remote dismissal was blocked by credential/environment mismatch. Any additional symptom on app foreground or Watch remains a separate investigation. Preserve HealthKit and Watch session semantics; do not rewrite Build 45 scheduling.
7. **Queued B48-D — separate APNs credentials by host:** Apple Developer has a Production-only REPTRIO APNs key and a Sandbox-only Live Activity key. Backend must select the correct credentials/JWT for each APNs host; maintain safe `auto` fallback. Preserve existing production secrets; plan separate `APNS_SANDBOX_KEY_ID` / `APNS_SANDBOX_PRIVATE_KEY` and use `APNS_TEAM_ID` only if verified for both. Regression tests + HIGH Guardian + operator runbook before any separately approved production secret change/deploy. The currently configured secret values/Key IDs were not read, so do not claim their identities are proven. **No production changes, TestFlight, iOS install or deployment authorized.**

8. **Queued B48-E — legacy RepDB exercise IDs must be explicitly linkable:** A Build 47 user reports no **"Katalogdaki hareketle eşleştir"** button for `glute-bridge`. The frozen pre-Build-46 RepDB ID `glute-bridge` is **not** the new 302-catalog ID `ex_000123` (`Glute Bridge`), nor a `custom:` ID. The current `isCustomExerciseId` eligibility guard excludes legitimate legacy catalog IDs at the UI, selection, preview and transaction layers; existing query normalization already handles `-` as whitespace. **Do not merely show a button or change punctuation search.** The exact installed row ID has not yet been read, so reproduce with synthetic legacy-ID fixtures. Build 48 must allow **only validated legacy RepDB canonical IDs plus existing custom IDs** to enter the **user-confirmed**, per-routine-row catalog-link transaction, while excluding unknown strings and already-modern `ex_` IDs. Preserve source IDs, history ownership, isolated statistical identities, original fields, Undo journal, older-client sync and profile backup; no global alias collapse, automatic conversion or bulk rewrite. Complete contract/tests: mobile `docs/build48/B48_E_LEGACY_CATALOG_LINK.md`; developer handoff section B48-E. Mobile-only code scope with mandatory red-before/green-after regression tests and HIGH Guardian. **No deployment, device install, production data write or main merge authorized.**

## User decision — 2026-10-22 (B48-C reset policy)
- **Approved:** the daily Autocomplete allowance resets **24 hours after the first counted search** (`first-use-24h`): a window opens at the user's first dispatched Autocomplete request and lasts 24 h; a new window opens only after it expires. No time zone, no Istanbul or UTC calendar day. User's words: "ilk aramadan sonra 24 saat olsun".
- Enabling in production still requires separately approved steps: apply migration 0017, add `PLACES_DAILY_QUOTA_POLICY: first-use-24h` to `wrangler.jsonc` `vars` (not the dashboard; deploy would erase it), deploy the Build 48 Worker.

## Acceptance — 2026-10-23 (B48-A/B/C)
- **B48-A, B48-B, B48-C: COMPLETE and ACCEPTED by the user.** Production canary accepted (backend Worker `900e5cbf`,
  `first-use-24h` quota live; record: backend `docs/build48/PRODUCTION_ROLLOUT.md`).
- Google 429 source separation, Google Cloud quota and cost audit are deferred to pre-App-Store work:
  backend `prelaunch/topics` → `docs/prelaunch/AS_PRE_001_PLACES_429_QUOTA_BILLING.md` (does not block Build 48,
  physical tests or TestFlight).

## Delivery gates
- This record commits decisions only, not feature implementation or tests.
- Before code changes, validate request accounting, API compatibility, global reset policy, Google attribution and physical iPhone/Watch acceptance checklist.
- Keep development isolated on Build 48 branches; do not change Build 47 artifacts without explicit approval.
