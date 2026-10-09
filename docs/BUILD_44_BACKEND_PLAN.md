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

## S4 / S8 — B44-08 export + YENİ B44-10 güvenli restore

Kilitli ortak sözleşme: `docs/BUILD_44_BACKUP_RESTORE_CONTRACT.md`. Sessions/sets/programs/body measurements/structured metadata; bounded schema/manifest/checksum/ZIP/CSV validation ve credential projection, counts/conflict preview, explicit confirmation, atomik geri alınabilir no-data-loss merge ve idempotent cross-device sync zorunlu. Mevcut user_data sync davranışı incelenmeden client-only güvenli merge varsayımı yapılmaz. Önemli yeni import ledger/revision/transaction migration kararı önce kullanıcıya onaylatılır; schema runtime henüz değişmedi.

Auth'den gelen ACTIVE user hedef scope'u belirler; backup owner/user IDs hedefi belirleyemez. Yeni ACTIVE hesap kendi dosyasını içe alabilir; eski deleted hesabın token/provider yetkisi dirilmez. Pending/purging hedef, stale device/replayed push ve recovery/purge ile eşzamanlı restore fail-closed. Atomiklik, undo concurrent user writes, tombstone, same-file/second-device dedup ve stats parity contract tests zorunludur. S4a pure validation önce, sonra snapshot/ZIP, preview, onaylı merge/sync. Export-only endpoint varsayımı bu gereksinimlerin yerine geçmez.

B45-01 Hevy/Strong/başka workout export adapter'ları yalnız sonraki sürüm PLAN_ONLY; B44 backend haricî import implement etmez. HIGH bağımsız Guardian, odak testleri; production D1/deploy ve veri silme yetkisi verilmedi.

## 2026-10-08 — B kayıt bazlı authoritative storage/sync uygulama kararı

Kullanıcı B'yi onayladı: programs/workout sessions/sets kayıtları snapshot projections yerine authoritative olacak; measurements ve structured metadata için bounded entity schema; revisions/tombstones/journal ve eski AppData API tüketicileri için güvenli adaptör. Legacy snapshot fallback, zero data deletion migration, gerçek SQL atomic concurrency guard, eski PWA unsupported mobile alan koruması/fail-closed; auth/isolation/deletion cleanup odak kanıtı zorunlu. Önemli yeni davranış çıkarsa sohbet içinde kullanıcıya sorulur. Backend runtime geliştirme yetkili, production migration/deploy değil.

## 2026-10-09 — İlk B diliminin gerçek checkpoint'i

Başlıktaki PLAN ONLY durumu ilk planın tarihsel checkpoint'idir. Mimari B onayı ardından **yalnız ilk storage/sync dilimi IMPLEMENTED_LOCAL**: additive `0008`, iki yeni authoritative storage tablosu; raw AppData codec; tek consistent SQL pull, migration missing legacy fallback; bounded streaming push; CAS-first tek atomic batch ve tüm record değişimleri için authenticated user/revision/write-token/ACTIVE guard; durable tombstones; authenticated capabilities; yeni tabloların account deletion ve yalnız izinle çalıştırılabilir maintenance footprint'i. Legacy snapshot/projection tablolarında backfill, dual-write veya silme yoktur.

Odak SQLite testleri, FK on/off deletion, beş kritik semantik mutant ve tam `npm test` PASS; bağımsız HIGH Guardian PENDING. Yeni `BUILD_CURRENT.md` aktif çalışma ledger'ıdır. İlk dilim kontratı, sorgu limitleri, legacy client riskleri ve güvenli rollout/rollback sınırı `BUILD_44_RECORD_STORAGE_HANDOFF.md` içinde yazılıdır. B44-08/B44-10 tamamı PARTIAL; ZIP/CSV export/restore staging/preview/confirmation/journal/undo ve native client entegrasyonu sonraki dilimlerdir. S3 consent, S5 deletion challenge/provenance ve B44-04 30 günlük lifecycle runtime burada uygulanmış sayılmaz. Migration/deploy/build/TestFlight yapılmadı; production eylemler için ayrı açık talimat gerekir.

## 2026-10-09 — Guardian sonrası dar compatibility amendment

İlk bağımsız Guardian DURDURULDU. Native/PWA gerçek producer kaynakları ayrı read-only Planner ile doğrulandı; aynı dosya haritasında phone/Watch undo, preview lifecycle ve known recursive finalize/discard, PWA draft deletion, local hero omission ve migration-aware account cleanup düzeltildi. CAS, authenticated tuple identity, durable tombstones, unknown personal data fail-closed ve bütün release sınırları korunur. Yeni bağımsız HIGH Guardian PENDING; full export/restore PARTIAL, üretim/build başlamadı. Güncel ayrıntı ve test checkpoint'i record-storage handoff/BUILD_CURRENT içindedir.

### 2026-10-09 — İkinci tam Guardian sonrası PWA retry null düzeltmesi

İkinci tam bağımsız HIGH Guardian genel kararı DURDURULDU kaldı; önceki düzeltmeler geçti, tek kalan gerçek PWA retry `app.js:532–533` errorCode:null → fresh ready'de omission regresyonu giderildi. Ayrı read-only Planner dar amendment'ına göre yalnız exact `importPreviews[importId].errorCode` için matching-id verified pending→ready replacement'ta önceki null omission kabul edilir. Mevcut string geçiş izinleri korunur; parserStatus/failedAt string-only, object/array errorCode ve unknown preview/document/prescription loss zero-write kalır. Schema5 fixture gerçek null retry kullanır; schema8 mobile delete path değişmedi. Dedicated failed seed→retry null→fresh ready başarıları revision 1→2→3 ve unrelated data equality ile doğrulandı; invalid state/id/null-field ve adjacent unknown negatives revision/write değiştirmez. Fresh tam HIGH Guardian yeniden PENDING; commit/push ve production/build yoktur.


### 2026-10-09 — Phase 2A transport/root delta yerel checkpoint

Accepted storage `a25046df171c30dd70bc790db82ae764cb49bda6` sonrası approved B üzerinde yalnız A uygulandı: authenticated bounded raw pages, revision/token-bound HMAC cursor + signed64 rowid locator/exact-key digest, lightweight capabilities, complete touched-root delta, preserved global ranks/request-order append + <=8 sequential before/after commands, CAS-first tek atomic batch, account-scoped1h no-payload mutation receipts/concurrent retries ve bounded cleanup. Shared schema/compatibility/opaque-loss/known operational coverage korunur; schema5 pure-PWA account guard summary-only, unknown/tombstone/deletion gates zero-write.0009 additive migration yerel; eski record-aware pull/push authority korunur.

17 dosyalık map ve wire/budget/retry/rollback ayrıntısı `docs/BUILD_44_RECORD_TRANSPORT_HANDOFF.md`. Gerçek SQLite direct-seed70,006records /10,315,126bytes exact paging+assembly; middle edit10queries/16payloadrows/0ordinary rerank; huge raw keys/unsafe64locator, prefix replay/skip/forgery, concurrency/response-loss/TTL/order/rollback/composite/PWA/escaped receipt budget fixtures PASS. Storage5+transport5 critical mutants PASS, FK on/off deletion PASS, fullnpm EXIT0 (yalnız local8090 test izni), syntax/diff PASS. Logs `/private/tmp/reptrio-b44-phase2a-focus.log`, `/private/tmp/reptrio-b44-phase2a-full.log`. Backend test:change-guardian NOT_AVAILABLE; fresh independent FULL HIGH Guardian PENDING, commit/push yok.

Tüm B44-08/B44-10 PARTIAL; B initial >4MB publisher/personal restore/journal/undo/ZIP/native runtime pending. Production D1/deploy/iOS build/TestFlight/gerçek kullanıcı silme yapılmadı. `RECORD_TRANSPORT_ENABLED=false` rollback yalnız yeni routes/flags kapatır; record accounts eski user_data writer'a döndürülemez.


### 2026-10-09 — Phase2A FULL Guardian P2 düzeltmesi

Önceki frozen A FULL HIGH Guardian **DURDURULDU**: touched prefetch byte tahmini parent_key tekrarını ve JSON escaping/list envelope'u kapsamıyordu; legal3005B ID+1000set gerçek6.3MB payload döndürüyordu. Exact read-only Planner amendment sonrası aynı17map içinde explicit11field projection + JSON1 UTF8 sizing + sayısal sentinel/list envelope ve aynıSQLsnapshot rev/token/ACTIVE/user/count/byte gates uygulandı. Büyük touched payload DB'den çıkmadan SYNC_ROOT_LIMIT, stale owner SYNC_CONFLICT; no batch/write/receipt/data change.

Corrected focus PASS:6,341,042B ve6,331,032B projected old rows için0payloadRows/0batch; escaped legalnear3,789,338B returned==SQLbound, rawidentity/order/content/retry exact; büyüyen writer race0payload. Large edit artık9queries/16payloadrows/0normalrerank; schema/order/receipts/rollback/budget/mutants korunur. Corrected full log `/private/tmp/reptrio-b44-phase2a-p2-full.log`, focus `/private/tmp/reptrio-b44-phase2a-p2-focus.log`. Fresh FULL HIGH Guardian **PENDING**; önceki DURDURULDU kendiliğinden geçerli sayılmaz. AIMPLEMENTED_LOCAL, tümB44PARTIAL/Bpublisher+restore+nativePENDING; commit/push/deploy/migration/build/gerçekverisilme yok.

Corrected P2 final verification: focus PASS, full `npm test` EXIT0 (`/private/tmp/reptrio-b44-phase2a-p2-full.log`, local8090 fixture permission only), syntax/diff PASS. Fresh independent FULL HIGH Guardian PENDING; no commit/push/production actions.


### 2026-10-09 — Corrected Phase2A fresh FULL HIGH kabulü

Tam bağımsız Guardian **GEÇTİ**, frozen17 manifest `0a94e9dfe0270517f94943c54972aa6031238b0096d1d4f8f18de1230c1f0561`. Önceki DURDURULDU tarihsel kaydı korunur; P2 boyut açığı düzeltilmiş sürümün tamamı yeniden incelendi. Independent full npm EXIT0 `/private/tmp/reptrio-b44-guardian-phase2a-p2-full.log`, focus ve tüm adversarial kontroller PASS. Kendi normal eski producer23.009B örneği artık413/zero payload/batch/writes; bağımsız escaped near-limit transfer3.792.306B SQLbound ile aynı. Same-fetch revision/token/blocked/deleted races zero payload. 70.006 kayıt exact paging, signed64/cursor completeness, sequential order oracle, CAS/receipt races/rollback, schema5/unknown/tombstone/cleanup ve toplam10 mutant PASS. Syntax8/diff PASS; mechanical NOT_AVAILABLE.

Parent sonrasında yalnız bu kabul kayıtlarını ekledi; denetlenen runtime kaynakları değişmedi. Bu backend dilimi commit/push için kabul edildi; tüm B44-08/B44-10 hâlâ PARTIAL. Sonraki staged publisher + personal restore/journal/undo, ardından native entegrasyon. Production migration/deploy, native build/TestFlight/veri silme yetkisi verilmedi veya uygulanmadı.


### 2026-10-09 — Phase 2B personal restore local implementation, acceptance pending

Approved B, accepted A base `efe0dcf5a386d9b2e4c00ab3d836dffdd892f847`, branch `feat/build44-personal-restore`: additive0010 staging/journal, authenticated projected RESTORE and separate RAW staged SYNC, generation/revision/ACTIVE bounds, explicit preview/confirmation, one-batch CAS publication, durable receipt/retry/dedup, full ALL undo with exact ownership and versioned incoming/RAW opaque baseline proofs, path/item-only metadata removal, TTL/cancel/cleanup and fail-closed partial-schema deletion implemented locally. Portable V1 machine block/cf6acfa golden bytes remain unchanged; raw keys/order/-0 preserved. Exact21file map and runtime/rollback evidence: `docs/BUILD_44_PERSONAL_RESTORE_HANDOFF.md`.

Small routed personal tests and four meaningful proof mutants pass; storage5 mutants and account deletion FK on/off/partial personal schema tests pass. Broad full npm EXIT0 / real5,101sessions+66,313sets PASS before the final narrow unit/empty-selection guards; latest24 routed small groups +six B semantic mutants PASS after those guards. Fresh independent FULL HIGH Guardian PENDING. Latest source-backed Planner amendment closes the provenance9→RAW staged SYNC gate: distinct frozen-V1 RAW9 mode, strict stagedmarker/declaration equality, preserved9/unknown/null/absent/-0/order and zero-write legacy/delta5/8 downgrade guards; no broader operational omission privilege or8 stamp. Actual golden cross-flow and negative/retained5/8 controls pass. UNACCEPTED/no freeze/commit/push. SQLite timings are not D1/native evidence. Entire B44 backup/native/statistics refresh user flow remains PARTIAL. No production D1/deploy/build/TestFlight/real user data deletion, no mobile/Watch/synced-reference edits.

Final narrow Planner alignment: every session without own explicit unit requires SAME or selected safe NEW captured legacy context, even empty or explicit-unit-child sessions. Strict portable array/absent sets/null-unit rejection remains. Zero eligible projected records returns409 `RESTORE_EMPTY_SELECTION` before ordinal allocation/publication, preserving READY/no receipt/account/journal change; all-SAME duplicate receipts remain valid and unrelated eligible metadata may commit while blocked sessions/children never publish. Six-context × four valid session-shape outcomes plus invalid portable shapes, immediate RAW-preserving ALL undo and two additional unsafe-authorization mutants PASS. Latest focus `/private/tmp/reptrio-b44-final-unit-alignment.log`; broad `/private/tmp/reptrio-b44-final-full.log` ran before this exact isolated guard delta. Large fixtures all have own kg unit and nonempty selected counts; unchanged large publication paths are not needlessly rerun. Source/test/doc freeze21 then fresh FULL HIGH required; no acceptance/commit/push/build claimed.


## Independent FULL HIGH P1 correction — pending fresh review

The prior frozen candidate received **DURDURULDU**: complete personal-restore tables combined with missing `sync_mutation_receipts` passed cleanup readiness, then account deletion performed an external cleanup before a missing-table database failure. The existing deletion fixture reproduced routed500 `ACCOUNT_DELETE_FAILED` before correction (`/private/tmp/reptrio-b44-p1-before-fix.log`).

`storageCleanupMode` now requires both record storage and mutation receipts to be ready whenever personal-restore storage is ready, before any external effect. The existing FK-on/off deletion matrix adds this exact mixed-schema case and passes routed503 `SYNC_STORAGE_SCHEMA_UNSUPPORTED`, zero database writes, unchanged complete account data, zero Apple revocations and zero OpenAI response deletes (`/private/tmp/reptrio-b44-p1-corrected-deletion.log`, EXIT0). Supported predecessor schemas without personal tables remain covered. Syntax and diff checks pass. This narrow cleanup-readiness delta follows the previously recorded broad and focused evidence; no unrelated broad tests were repeated. The corrected exact21 candidate is **pending fresh independent FULL HIGH**, with no commit, push, deployment or acceptance.


## 2026-10-09 — Corrected backend personal restore accepted

Fresh independent FULL HIGH Guardian: **GEÇTİ**, corrected 21-file freeze SHA256 `34f9721efb86a328f4d1ad46d849fd9fe49a025f8e9119513d5b86cf7acda567` on base `efe0dcf5a386d9b2e4c00ab3d836dffdd892f847`. Parent verified all frozen hashes before this documentation-only acceptance append. Prior DURDURULDU remains historical; combined personal-ready/missing-receipts P1 is closed. Independent routed SQLite: 503 SYNC_STORAGE_SCHEMA_UNSUPPORTED, zero external effects/DB writes, account retained; FK on/off supported and partial schema deletion checks PASS.

Evidence: corrected deletion suite and independent lifetime receipt/ALL undo/UNDONE replay/cross-account controls PASS. Existing 24 focus groups/six safety mutants and full 5,101 sessions/66,313 sets evidence assessed proportionately; broad run predates final unit/empty guards, later focus covers them. Mechanical backend Guardian NOT_AVAILABLE. No runtime changes after reviewed freeze. Commit/push permitted for this backend scope only.

Build44 overall **PARTIAL**: native operation boundary, account-scoped pending reconciliation, Watch ownership/custody approval and implementation, ZIP UI/restore application/statistics integration and cross-device end-to-end verification remain. No production migration/deploy, iOS build/TestFlight or real user deletion performed or authorized. B45 external imports PLAN_ONLY.
