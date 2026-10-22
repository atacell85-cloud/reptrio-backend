# REPTRIO — App Store public-launch preparation backlog

**Branch:** `prelaunch/topics` — backend repository.
**Milestone:** **before first publicly available App Store release** of REPTRIO.
**Not the milestone:** current physical iPhone acceptance, private developer testing, or TestFlight beta distribution.

This branch is a **planning/work-queue branch**. It must not be deployed as a Worker or merged into production merely because a prelaunch task was recorded here. Runtime implementations must be developed and reviewed on separately authorized branches.

## Recorded topic

| ID | Topic | State | Launch gate |
|---|---|---|---|
| AS-PRE-001 | [Google Places 429 attribution, rate-limit / quota, cost and observability audit](./AS_PRE_001_PLACES_429_QUOTA_BILLING.md) | OPEN, DEFERRED | Review and acceptance **before public App Store availability**, not before developer/TestFlight testing |

### Approved behavior to preserve until separately changed

- First counted Autocomplete attempt starts a **24-hour window**; max **100 reserved upstream Autocomplete attempts/account/window**. Google upstream 429 currently consumes one unit when reached; Cloudflare pre-dispatch burst rejection does not.
- No quota display counter in the UI. Manual gym creation and Place ID verification remain independent and available.
- Build 48 A/B/C canary acceptance is recorded separately; the ambiguity in upstream-vs-edge 429 is a future operational/UX hardening topic, not proof of a current quota defect.

### Distinct Build 48 development work (do not move here)

- **B48-D:** APNs Sandbox vs Production keys and Live Activity closure.
- **B48-E:** user-confirmed, reversible legacy RepDB routine catalog linking.

New App Store preparation topics should be added as separate entries with an owner, risk, acceptance evidence and explicit release/deployment gates. Do not silently reclassify beta/physical tests as public-release blockers.
