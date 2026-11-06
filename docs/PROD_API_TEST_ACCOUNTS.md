# Reptrio production API test accounts — runbook

Permanent test infrastructure for verifying the production API on every build (decision 2026-11-06).

## What exists
| Account | Address | Pinned user id | Role |
|---|---|---|---|
| A | `test@reptrio.com` | `b7cd559b-…` (in `scripts/ops/prod-api-test-accounts.json`) | Personal card CRUD, sync, old-client 409. Holds data level 2 after the first run (expected, permanent). |
| B | `test-delete@reptrio.com` | filled in by `setup-register` | Isolation and data-level-1 compatibility. Never receives a card; stays below level 2. |

- Both addresses deliver to the same supervised Zoho mailbox. The mailbox is used **only** during the one-time setup below.
- Passwords live only in the **macOS Keychain** of the project Mac: service `reptrio-prod-api-test`, account = email.
  They are never in the repo, reports, GitHub, Cloudflare or Claude environment secrets.
- The accounts are never deleted. Account deletion is a separate piece of work (needs Zoho Mail API access) and is not part of
  this check.

## One-time setup (on the Mac, interactive; the only human step)
```bash
cd <reptrio-backend checkout on build52/personal-exercises or later>
npm run ops:prod-api-setup-reset -- --account A       # A exists; its old password is unknown
npm run ops:prod-api-setup-register -- --account B    # creates B only if no account exists; pins its id
```
Each command requests the official reset mail (`POST /api/auth/password/forgot`, 202), waits, then asks for the reset link
**in the terminal, with the input hidden**. Open the Zoho mailbox, copy the link from the newest Reptrio mail, paste it.
The script generates a random password, completes `POST /api/auth/password/reset`, stores it in the Keychain, and signs in
once to prove the pinned id. macOS may ask once whether `security` may access the item: choose **Always Allow**.
`setup-register` refuses to run if B is already pinned or the address already has an account (no re-creation).
`setup-reset` changes the password before it can sign in and compare the pinned id; it relies on the supervised mailbox
belonging to the pinned account. If the id check then fails, stop and investigate before any verify run.
After `setup-register`, commit the updated `scripts/ops/prod-api-test-accounts.json` (B's user id; no secrets).

## Every build (no prompts, no account creation, no mail)
```bash
npm run ops:prod-api-verify -- --out prod-api-verify-build<N>
```
Exit code 0 and `PRODUCTION API VERIFIED` only when every check passes; anything FAIL or BLOCKED gives `NOT VERIFIED`.
Output: `result.json` and `result.md` (status codes and error codes only; no tokens, passwords or addresses).

What it checks: unauthenticated contract (401/403/405/415), sign-in A (two client sessions) and B with pinned ids,
capabilities (`personalExercises: 1`, `personalBackupVersions [1,2,3]`), card create → read from the second session →
update → read, old client push at level 1 and with no level (409 `SYNC_CLIENT_UPGRADE_REQUIRED`), old client restore start
(409), old client pull (200), refused writes change nothing, B pull/push at level 1 with no A card visible, no-session read
(401), then cleanup through sync (tombstone, then release from the array) and verification that the card does not return.
All sessions are logged out at the end.

## Safety rules built into the script
- Base URL is production or a loopback dev Worker only.
- Every signed-in session must match the pinned user id (`/api/auth/login` and `/api/me`); otherwise it logs out and stops.
- Only A is ever sent a card. If A holds any card that is not a test card (`Reptrio API test …`), the run stops without writing.
- Leftover test cards from an interrupted run are cleaned first through the same sync path.
- B writes only with data level 1 and never with cards.
- Cleanup re-pulls and retries on `SYNC_CONFLICT` (a real app session on A may sync at the same time) and then confirms no
  live test card is left; otherwise the run records BLOCKED `LEFTOVER CARD` and the next run removes it first.
- A loopback run never reads or writes the Keychain and never writes the default accounts file.

## Local rehearsal (no production)
```bash
npm run cf:build && npx wrangler d1 migrations apply a2-workout-pilot --local --persist-to <dir>
npx wrangler dev --local --port 8799 --persist-to <dir>
# register two local accounts, write a copy of the accounts file with base http://127.0.0.1:8799 and their ids, then:
REPTRIO_TEST_PASSWORD_A=… REPTRIO_TEST_PASSWORD_B=… node scripts/ops/prod-api-verify.mjs verify --accounts <copy>
```
Environment-variable passwords and the in-memory store (`REPTRIO_TEST_DEV_STORE=1`) are refused for the production base URL.
