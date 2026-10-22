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
2. **Global product:** REPTRIO must function worldwide. Do not hard-code Turkey, Turkish, Istanbul or `Europe/Istanbul` as a global default for time windows, locale, format, search geography or UX. **Daily quota boundary/time-zone policy still requires explicit product/technical resolution**; the old Istanbul-midnight rule is superseded, not an instruction to silently substitute another time zone.
3. **Salon search UX:** no separate **“Ara”** button and no visible “remaining searches” counter. Design responsive Autocomplete without multiplying billable requests unnecessarily (minimum query length, input debounce, in-flight cancellation/deduplication, server-side protections). The earlier button-per-request approach is superseded.
4. **Entry label:** the workout screen's add-gym entry must say only **“Salon ekle”**, not “Google Haritalar” / “Google Maps”. Preserve the Google attribution/logo and terms wherever required by the Places experience; removing the wording from this button is not permission to remove legally required attribution.
5. **Fallbacks & cost controls:** manual gym entry remains available even when the user's quota is reached; preserve Place ID verification and safe stale-results behavior. Keep global provider-usage/cost protection distinct from per-user limits; monthly Google free usage is not itself an application quota.
6. **Apple Watch / Live Activity:** investigate and fix the regression where the workout's Live Activity/Watch foreground prominence **fails to disappear after the intended ~30-minute inactivity period** (including after phone/app reopening). First verify the exact inactivity clock, lifecycle and OS constraints. Preserve existing HealthKit, live HR, rest timers, WatchConnectivity, workout-session behavior; avoid unrelated refactoring. **No fix is claimed by this decision record.**

## Delivery gates
- This record commits decisions only, not feature implementation or tests.
- Before code changes, validate request accounting, API compatibility, global reset policy, Google attribution and physical iPhone/Watch acceptance checklist.
- Keep development isolated on Build 48 branches; do not change Build 47 artifacts without explicit approval.
