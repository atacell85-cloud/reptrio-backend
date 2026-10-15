# Cloudflare Pilot Deployment

## First deploy

1. Install dependencies with `npm install`.
2. Authenticate interactively: `npx wrangler login`.
3. Add the production secret without placing it in source control: `npx wrangler secret put OPENAI_API_KEY`.
4. Review non-secret defaults in `wrangler.jsonc`, then deploy with `npm run cf:deploy`.
5. The same Worker serves the PWA and API. Production URLs are `https://app.reptrio.com` and `https://api.reptrio.com`; the workers.dev URL remains a legacy fallback.

## Configuration

`OPENAI_IMPORT_MODEL`, `OPENAI_IMPORT_TIMEOUT_MS`, `OPENAI_IMPORT_MAX_RETRIES`, `OPENAI_IMPORT_RETRY_BASE_MS`, and `OPENAI_IMPORT_MAX_INPUT_BYTES` are non-secret Worker vars in `wrangler.jsonc`. `OPENAI_API_KEY` is a Cloudflare secret only. For local Worker development, Wrangler reads the ignored `.env` file; use `npm run cf:dev`.

`AI_IMPORT_LIMITER` is a Cloudflare Rate Limiting binding configured for four import requests per IP per minute. Change its `simple` block in `wrangler.jsonc` deliberately if the pilot needs a different limit.

## Google and Apple login

OAuth login is enabled by code. Google and Apple are configured for the Reptrio production API domain. Use these redirect URLs:

- Google: `https://api.reptrio.com/api/auth/oauth/google/callback`
- Apple: `https://api.reptrio.com/api/auth/oauth/apple/callback`

Required Cloudflare secrets currently present in production:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `APPLE_OAUTH_CLIENT_ID` (Apple Services ID)
- `APPLE_OAUTH_TEAM_ID`
- `APPLE_OAUTH_KEY_ID`
- `APPLE_OAUTH_PRIVATE_KEY` (Sign in with Apple private key in PKCS#8 `.p8` format)

Store secrets with `npx wrangler secret put <NAME>`. Do not place these values in source control or chat.

## Operations

- Health check: `https://api.reptrio.com/api/health`
- Tail safe metadata logs: `npx wrangler tail a2-workout`
- Roll back: `npx wrangler rollback`
- Custom hostnames are configured as Worker custom domains in `wrangler.jsonc`: `app.reptrio.com` and `api.reptrio.com`.

Do not upload `.env`, `.dev.vars`, API keys, or imported document contents. Worker logs contain request metadata only, never keys or document bodies.

## Account deletion (issue #6) — deploy notes

Not deployed by the change itself. When this branch is released:

1. **Apply migration 0005 before deploying the Worker:** `npx wrangler d1 migrations apply a2-workout-pilot --remote`. It adds the encrypted Apple refresh-token columns and `oauth_reauth_tickets`. Without them, `/api/auth/delete` and Apple sign-in token storage fail. `worker-deploy.yml` does not apply migrations.
2. **Deploy the Worker before shipping the app build** that uses `GET /api/auth/delete`. The app falls back to the old password flow against an older backend (405), but Google / Apple users can only delete after this backend is live.
3. **Accounts the old flow only soft-deleted** (`users.deleted_at`): purge them with the maintenance script, **not** a migration. It is irreversible; run it only with explicit owner approval, after step 1:
   `npx wrangler d1 execute a2-workout-pilot --remote --file scripts/maintenance/purge-soft-deleted-accounts.sql`
4. **Configuration:** no new secret is needed. Apple refresh tokens are encrypted with a key derived from the decoded `APPLE_OAUTH_PRIVATE_KEY`. Replacing that key makes stored tokens unreadable; affected Apple users re-authorize once before deleting (`APPLE_REAUTH_REQUIRED`).
5. **Apple users who signed in before this release:** they have no stored token. Deletion asks them to re-authorize with Apple once, through a single-use ticket bound to their signed-in account (`POST /api/auth/reauth/apple`, then Apple sign-in with `reauth=<ticket>`). The callback only accepts the Apple ID already linked to that account and never creates or switches accounts.
6. **What `POST /api/auth/delete` does:**
   - revokes Sign in with Apple at `https://appleid.apple.com/auth/revoke` first; if that fails, nothing is deleted;
   - deletes stored OpenAI background import responses (best effort);
   - removes every `user_id`-linked row and the `users` row in one atomic D1 batch.
   `GET /api/auth/delete` tells the client whether a password is required and whether Apple re-authorization is needed.
7. **Not reachable by deletion; document these publicly:**
   - OpenAI abuse-monitoring retention;
   - earlier synchronous import responses, which are stored by default (new ones use `store: false`);
   - background responses whose id was lost;
   - D1 Time Travel recovery window.

## OAuth account linking (issue #12) — deploy notes

Not deployed by the change itself. This release builds on the account-deletion release (merge backend PR #2 / mobile PR #11 first).

1. **Apply migration `0006_oauth_email_trusted.sql`** (additive: `oauth_accounts.email_trusted`) together with 0005, **before** the Worker deploy. Without it, sign-in fails on the new column.
   - Links written by the old Worker between the migration and the deploy stay NULL. Like all pre-migration links, they are "unproven" until that identity signs in again.
2. **Behaviour after deploy.** The identity key is provider + `sub`. Already-linked identities sign in unchanged.
   - **A new identity whose email matches an existing account** is linked only when:
     - its email is **trusted**: Google verified it AND Google is authoritative for it (`@gmail.com`, or a Workspace account whose `hd` is the email's domain); Apple verified it; and
     - the account was created by a trusted provider identity that still has that email.
   - **Otherwise sign-in fails closed** with `OAUTH_ACCOUNT_LINK_REQUIRES_VERIFICATION`. No link and no duplicate account are created.
   - **New accounts** need a provider-verified email (`OAUTH_EMAIL_UNVERIFIED`).
3. **Product follow-ups:**
   - Password users cannot add Google / Apple sign-in by email match; a signed-in "link Google / Apple" flow does not exist yet.
   - Because registration does not verify email, someone can pre-register a password account for another person's address. That person can then never use Google / Apple with it until email verification or account recovery exists.

## Password reset (Build 43 G) — deploy notes

Not deployed by the change itself. This branch (`build43/password-reset`) stacks on the account-deletion and OAuth-linking branches (PRs #2 / #3), so deploying it also ships those. Their notes above apply first.

1. **Apply migration `0007_password_reset_tokens.sql` before deploying the Worker** (with 0005 / 0006 if they are not applied yet): `npx wrangler d1 execute a2-workout-pilot --remote --file .\migrations\0007_password_reset_tokens.sql`. It is additive: a new table plus an index.
   - **Order matters:** account deletion now also erases `password_reset_tokens`. A Worker deployed without the table fails every `POST /api/auth/delete` with `ACCOUNT_DELETE_FAILED`, and reset requests fail silently.
2. **Secret:** `ZEPTOMAIL_API_KEY` must exist on the `a2-workout` Worker. It is the ZeptoMail Send Mail token of the `reptrio-password-reset` mail agent, with or without the `Zoho-enczapikey ` prefix. Check with `npx wrangler secret list`; never print the value. If it is missing, requests still answer 202 and the log shows `password_reset_mail_failed` / `not_configured`.
3. **Configuration in `wrangler.jsonc` (deployed with the Worker):**
   - rate-limit binding `PASSWORD_RESET_LIMITER` (namespace `1002`, 5 requests / 60 s per client IP and action);
   - `/reset-password` added to `assets.run_worker_first`, so the Worker serves the reset page.
   - If the limiter binding is missing, the endpoints fail open; the per-account throttle still applies.
4. **Mail endpoint:** `https://cpaas.zoho.eu/v1.1/email` (EU data center) in `worker/transactional-email.js`. Before the first deploy, confirm it against the mail agent's "Setup info → API" page. Sender `Reptrio <no-reply@mail.reptrio.com>`; click and open tracking are off (tracking would route the reset link, and its token, through the provider).
5. **Endpoints:**
   - `POST /api/auth/password/forgot {email}` → always `202 {ok:true}` for a valid email, `400 AUTH_INVALID_EMAIL` for a malformed one, `429 PASSWORD_RESET_RATE_LIMITED`.
     - The lookup, the link and the mail happen after the response.
     - Per account: at most one link per 60 s and three per hour, silently.
     - Google / Apple-created accounts (generated password) and deleted or unknown accounts get nothing.
   - `POST /api/auth/password/reset {token, password}` → `200 {ok:true}`. Errors:
     - `400 AUTH_PASSWORD_TOO_SHORT` (8–200; checked before the link);
     - `400 PASSWORD_RESET_INVALID` (wrong, malformed, expired, used, revoked, deleted or ineligible);
     - `429`;
     - `500 PASSWORD_RESET_FAILED`.
     - On success it changes the password, deletes all sessions, voids pending mobile OAuth codes and the user's other links, and sends a "şifren değiştirildi" notice. It does not sign in.
   - `GET /reset-password` → the page the emailed link `https://api.reptrio.com/reset-password#token=…` opens. It offers the app handoff `reptrio://reset-password?token=…` or a web form.
6. **Smoke test after deploy** (own test account only):
   - request a link;
   - the mail arrives;
   - the web form and the app both reset;
   - the old password and old sessions are rejected;
   - the same link again → invalid.
   - Logs contain only event names and status codes.
7. **Apple Private Relay:** mail to `@privaterelay.appleid.com` addresses is delivered only if `mail.reptrio.com` / the sender is registered in Apple's Private Email Relay settings. Apple-created accounts never receive reset mail, so this matters only for password accounts using a relay address.
