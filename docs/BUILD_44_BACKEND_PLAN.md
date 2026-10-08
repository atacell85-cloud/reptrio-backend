# REPTRIO Build 44 — Backend Implementation Contract (Plan Only)

**Durum:** PLAN / HİÇBİR KOD VE D1 KAYDI DEĞİŞMEDİ.
**Baseline:** `build43/password-reset@21fa48f97ad5fb38f7efbbe7a036db8fc15ed4b7`.
**Mobil kaynak:** https://github.com/atacell85-cloud/reptrio-mobile/blob/build44/planning/docs/tasks/BUILD_44_MASTER_PLAN.md
**Mobile phase handoffs:** https://github.com/atacell85-cloud/reptrio-mobile/blob/build44/planning/docs/tasks/BUILD_44_PHASE_HANDOFFS.md
**Uyumluluk:** Eski mobil versiyonlar aynı production API'yi kullanıyor. API kontratı migration-first ve backwards compatible olmalı. Deploy yalnız ayrıca izinle. Hiçbir production D1 sorgusu, hesap silme, Worker deploy/secret işlemine bu plan onay vermez.

## S0 Baseline and safety

- `AGENTS.md`, `CLOUDFLARE_DEPLOYMENT.md`, `worker/index.js`, `worker/account-api.js`, `worker/password-reset.js`, `worker/transactional-email.js`, `migrations/0001..0007` ve ilgili e2e testleri incele.
- `npm test` baseline, minimum fixture/simulated OpenAI/Apple/ZeptoMail; secrets gerçek değerini loglama.
- Geri dönüş noktası: 21fa48f. Her migration için incremental no-data-loss rollback/compatibility planı. D1 Time Travel bir uygulama rollback stratejisinin yerine geçmez.

## S3 — AI data-sharing permission API & server gate [P0, HIGH]

**Gerçek uygulama:** Mobile `app/import.tsx` dosyayı seçtiği anda `/api/import/jobs` multipart gönderir. Backend `worker/index.js`: `/api/import/jobs` POST, `/api/import/jobs/:id/retry`, `/api/import/parse`, queue consumer ve `requestBody` üzerinden OpenAI Responses API çağrısı vardır. Orijinal dosya `input_file` olarak, normalizedDocument metni JSON olarak taşınır. Background istek `store:true`.

**Kontrat kararları (önce Planner/security sign-off):**
- Authenticated consent records bound user ID and version of exact disclosure / purpose (`ai_import_openai_document_v1`), grantedAt/revokedAt, write idempotency. No raw data/document in audit.
- New `GET /api/privacy/ai-import` (current consent status + revision), `POST /api/privacy/ai-import/consent` action `grant|revoke` (exact same authenticated user; origin/replay/CSRF checks). Endpoint naming can change only through coordinated mobile contract test.
- `POST /api/import/jobs` and `/api/import/parse` MUST reject before D1 import job insert/openAI call/file persistence if consent missing, stale or revoked. Retry and queue must be checked at execution time too; long-running jobs already submitted before revocation policy requires explicit decision.
- Consent must be granted after disclosure in app but server can never trust client Boolean flag alone: server-controlled account-scoped state. Old apps fail closed to OpenAI, not generic 500 or silent upload.
- Return stable error code `AI_CONSENT_REQUIRED` (exposed as appropriate status) for mobile recovery UI. Idempotent requests and authenticated session expiry handled.
- Audit all deletion/retention of `import_jobs` background OpenAI response IDs; do not claim upstream permanent deletion if API/provider contract forbids.
- No proactive new upload of user profile/body measurements, email, HealthKit data to OpenAI. Only user-selected workout program file, extracted text/structured data.
- Privacy notice updates and KVKK Art.9 transfer review required before live sharing.

**Required outcome-based tests:**
- missing/denied/revoked/stale -> 0 OpenAI fetch and 0 raw payload stored; real job route AND retry AND queue path;
- own consent accepted; another user's consent rejected; invalid token and forged state; concurrent revoke->enqueue, old app/mobile spoof, normal background completion; file oversized/invalid mime;
- no document body/token in logs and no raw content in privacy records;
- deletion clears related consent/audit according lawful retention contract.
- Run `npm test` + E2E mock provider / staged API contract; HIGH Guardian PASS.

## S5 — Provider-aware safe account deletion, no password-field for Apple/Google-generated [P0, CRITICAL]

**Current code:** `worker/account-api.js deletionInfo/deleteAccount/deletionContext`, `worker/transactional-email.js`, `worker/password-reset.js`. Current `deletionContext` uses `oauth_accounts.created_at === users.created_at` to classify generated random password. This fails for legacy timing and password+linked accounts; it is not reliable identity provenance.

**Approved user choice (2026-10-08): email verification LINK, not code.**
- Email/password account: user can request deletion without knowing current password. Use a single-use email verification link (proposed TTL 10 min); link visit is not account deletion and separate in-app final confirmation is required. Protect the link with expiration, replay control and account/session binding. Final destructive screen warning and confirmation remains, optional export first.
- OAuth-created Apple/Google: never ask a meaningless generated password. Use live, authenticated session plus appropriate fresh provider check/Apple reauth when needed; Apple refresh tokens must be revoked before D1 wipe.
- Explicit provenance in `users` (nullable legacy/migrated source, e.g. `credential_origin`, not boolean inferred from timestamp equality). Backfill only proven records; unknown legacy values cannot default to passwordless deletion without account re-verification.
- Existing password login/reset, trusted OAuth account-linking and provider-sub user identity remain unchanged.
- `GET /api/auth/delete` answers action needed using explicit policy (not simply password true/false after mobile update). A versioned response preserves legacy mobile behavior, but new clients must never silently invoke unsafe paths.
- Proposed challenge endpoints: `POST /api/auth/delete/request-link`, `POST /api/auth/delete/verify-link`, then `POST /api/auth/delete` after a separate user confirmation (route names to finalize in Planner). A proof may authorize only that user's deletion and cannot serve as session token or code on URL query.
- For registered address not verified/not accessible, provide app-accessible, verified identity recovery path. Do not require user to email/call support as only deletion method.
- Apple revoke failure leaves all account rows intact; D1 atomic delete only after revoke successes. Failed/unknown responses must not clear mobile local data unless backend verified account gone.
- Backend `ACCOUNT_TABLES` must include every new B44 account-scoped table. Revoked/unredeemed codes destroyed on account wipe and on reset according policy.
- Generic public messages to avoid enumeration, mail delivery failure actionable in authenticated context, no stale-code bypass.

**Tests:** real SQLite+D1 fixture migration-first, legacy Apple created pre-Build43, fresh Apple/Google/password, user password linked to Apple or Google, Private Relay, email link expired/replay/wrong account and mail preview GET safety, request flood, competing sessions, provider revoke unavailable/re-auth mismatch, lost response+verified 401, no cross-account deletion, user data rollback on failure, OpenAI stored response deletion, mail delivery service down, completion idempotency.
**External rules:** Apple account deletion https://developer.apple.com/support/offering-account-deletion-in-your-app/ ; OWASP sensitive reauth https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html.
**Mandatory:** critical independent Guardian PASS and explicit D1+deploy approval. Never test irreversible deletion on production personal account.

## S4 optionally — Export snapshot endpoint

Current client is local-first `AppData` with `sessions, measurements, programs`. Mobile can export a coherent local synced snapshot, but it must never claim local data complete unless server status verifies.
If Planner proves local sync not sufficient, add authenticated `GET /api/export` streaming/manifest with optional snapshot version, pagination/checkpoint for large data; scrub sensitive tokens/password hashes, OAuth keys, raw third-party provider secrets, other accounts. Cross-account ID authorization and CSV safety required. Backend direct export contract and data retention must be agreed with mobile. No endpoint should make data deleted earlier recoverable beyond lawful retention.

## Integration, ordering and release gate

1. Stage schema/backwards-compatible API, test without prod secrets.
2. Write cross-repo mobile contract fixtures for `api.ts` and screen state transitions.
3. New Backend version first only after explicit deployment approval; failing/legacy client remains secure, privacy sharing remains fail-closed. Implement rollback/version validation.
4. Mobile ship only after privacy and deletion contract E2E PASS; large cohort existing users tested in read-only mode.
5. Independent Guardian (HIGH for import/consent, CRITICAL for deletion) + unit, integration, end-to-end tests.

**Do not change:** workout set completion and stats semantics, HealthKit/Watch, OAuth trusted account linking, password reset/ZeptoMail sender, app bundle/team, payment/secrets, existing manual routines.

## B44-04 — 30 günlük kurtarma varsayılanı (2026-10-08)

Kullanıcı, silme onayı ardından 30 gün geri alınabilir saklamayı **varsayılan seçenek** olarak onayladı. Aynı ekranda hemen kalıcı silme yolu bulunacak. Pending hesap normal API/sync/AI kullanamaz, recovery yalnız yeni kimlik doğrulama ve açık onayla olur. Son onaydan itibaren 30 gün sonunda sunucu tarafından otomatik purge yapılır; cron, iş kuyruğu, Apple revoke, race condition, audit ve KVKK/App Store incelemesi tam zorunludur. E-posta doğrulaması tek kullanımlık **link** yöntemiyle devam eder. Bu karar önceki bölümlerdeki yalnız anında silme uygulaması varsayımlarını geçersiz kılar.

Kanonik backend sözleşmesi: `docs/BUILD_44_ACCOUNT_RETENTION_CONTRACT.md`. Mobil tasarım: https://github.com/atacell85-cloud/reptrio-mobile/blob/build44/planning/docs/tasks/BUILD_44_30_DAY_ACCOUNT_RECOVERY.md. Bu dosya planlama kaydıdır; gerçek D1 veya servis değişmedi.
