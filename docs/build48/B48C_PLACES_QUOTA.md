# B48-C — Per-account Places Autocomplete allowance (100 / day)

Status: IMPLEMENTED BEHIND RELEASE GATE (2026-10-22). **Not enabled anywhere.** Migration 0017 NOT applied to any
remote D1; no deploy. One product decision is open: the reset boundary (§3).

## 1. What is implemented (branch `build48/integration`)
- `migrations/0017_places_autocomplete_quota.sql` — additive table `places_autocomplete_usage`, one row per account:
  `window_start_ms`, `window_end_ms`, `dispatched`, `updated_ms`. No search text, Google content, device or location.
- `worker/places-quota.js` — `PLACES_DAILY_AUTOCOMPLETE_LIMIT = 100`; candidate policies `utc-day`, `first-use-24h`;
  `APPROVED_PLACES_QUOTA_POLICIES = []` (empty); one atomic conditional upsert `RETURNING dispatched`.
- `worker/places-api.js` — order: auth/lifecycle → config (+ gate) → body → burst limiter (`PLACES_LIMITER`, unchanged)
  → **daily reservation (Autocomplete only)** → Google. Refusal: `429 {code:'PLACES_DAILY_LIMIT'}` (no count disclosed).
- `worker/account-api.js` — account erasure deletes the row explicitly (also with FKs off); FK cascades as well.
- Mobile (Build 48 B48-A) shows a localized explanation for `PLACES_DAILY_LIMIT`, stops searching in that picker
  opening, and keeps manual gym entry available. No counter is shown.

## 2. Accounting semantics
| Situation | Outcome |
|---|---|
| Quota policy env unset | Exactly Build 47: no D1 access; works with or without 0017. |
| Policy env set but not approved in code | Autocomplete `503 PLACES_NOT_CONFIGURED` before limiter/Google (fail closed). Place ID verification unaffected (tested). |
| Bad body / unauthenticated / deleting account / burst-limited | Refused before reservation; no unit taken. |
| Admitted (dispatched ≤ 100 in window) | One unit taken **before** dispatch. |
| Google timeout, abort, 5xx, upstream 429 | Unit kept (request may be billed; errors cannot be provoked to refill). |
| 101st+ in window, any device | `429 PLACES_DAILY_LIMIT`, Google not called, counter not increased. |
| Concurrent devices / duplicate requests | D1 serializes the single statement: exactly 100 admitted (tested with 260 parallel calls, 2 accounts × 2 devices). |
| Place ID verification (Place Details IDs Only) | Never counted, never blocked by the allowance. |
| D1 error / 0017 missing while enabled | `503 PLACES_UNAVAILABLE`, Google not called. |
| Clock earlier than stored window (instance skew) | Counts in the current window; never refills. |
| Worker restart / other isolate | State only in D1; persists. |
| Account erasure | Row deleted with the account. |

## 3. OPEN DECISION — reset boundary (needs explicit user approval)
The superseded rule was Istanbul midnight. Neither Istanbul nor UTC has been chosen. Viable global options:

| Option | Behaviour | Pros | Cons / edge cases |
|---|---|---|---|
| **A. `utc-day`** (implemented) | Resets 00:00 UTC for everyone | Simplest; one instant; no client input; travel-proof; easy to audit against provider daily usage | Local reset hour varies (03:00 Istanbul, ~19–20:00 New York, 09:00 Tokyo); a user can use 100 just before and 100 just after the boundary (200 in a few minutes) |
| **B. `first-use-24h`** (implemented) | Window opens at first counted request, lasts 24 h | No time zone at all; fair everywhere; no boundary burst (max 100 per any window start) | Reset time differs per user and drifts; harder to explain ("24 hours after your first search") |
| C. Account-local calendar day | Midnight in a stored account time zone | Matches users' notion of "today" | Needs a validated stored time zone (new data, consent/UX); travel and time-zone changes can refill early or block; client-supplied zone can be gamed |
| D. True rolling 24 h | Count of requests in the last 24 h | Smoothest; strict | Needs per-request rows or buckets (more D1 writes/reads); not implemented |

Recommendation for the decision maker: **B** (no time-zone assumption, no boundary burst) or **A** if a single global
reset instant is preferred. Either is enabled by adding the name to `APPROVED_PLACES_QUOTA_POLICIES` (reviewed code
change + tests) and setting `PLACES_DAILY_QUOTA_POLICY` on the Worker — only after 0017 is applied.

## 4. Cost and provider protection (validated 2026-10-22 against official docs)
- Google Maps Platform pricing page: **Autocomplete Requests** (Essentials) 10,000 free billable events/month, then
  US$2.83 per 1,000 (first tier); **Autocomplete Session Usage** and **Place Details Essentials (IDs Only)**: no charge
  listed. The current docs do not state that Autocomplete requests in a session ending in Place Details are free, so the
  conservative model assumes **every dispatched Autocomplete request is billable** after the free cap.
- Worst case per account: 100 × 30 = 3,000 requests/month ≈ US$8.49 beyond the free cap. The free 10,000/month equals
  ~3.3 maximal users. **The per-user allowance is not a budget control.** Account-wide protection stays separate and
  in place: Google Cloud quota caps on the Places API (New) methods and the ₺500 budget alerts (Build 47), plus the
  `PLACES_LIMITER` burst limiter (12/min/account). Monthly free usage is not an application quota.
- Session tokens: unchanged (one token per search; Place Details ends it; token rotated after every verify attempt).
  Abandoned sessions are billed per request (official docs).

## 5. Operational notes / risks
- **D1 writes:** one row write per dispatched Autocomplete while enabled (refusals write nothing). On Workers Free
  (100,000 rows written/day across the database) heavy use competes with sync/purge budgets; monitor before enabling.
- **Worker before mobile:** the Build 48 Worker (B48-B optional locale keys) must be live before any Build 48 mobile
  client ships; the Build 47 Worker answers 400 to the new keys.
- Rollout order when approved: apply 0017 (explicit permission) → deploy Worker with approved policy → set env var.
  Rolling back = unset env var (no D1 access). Build 47 clients keep working; they show the generic search error text
  on `PLACES_DAILY_LIMIT` and can still save manually.

## 6. Tests
`scripts/places-quota-test.mjs` (in `npm test`), mutation-checked (ceiling, approval list, result handling, verify
counting, fail-closed gate, fail-closed accounting, purge coverage, boundary off-by-one).
