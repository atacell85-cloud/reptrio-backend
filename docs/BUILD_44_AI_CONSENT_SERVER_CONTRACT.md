# B44-07 — Hesap Bazlı Opt-In AI Paylaşım İzni, Sunucu Sözleşmesi

**Ürün onayı: 2026-10-12. Durum: PLAN_ONLY.** Kullanıcı dosya başına büyük rıza diyaloğunu reddetti; üyelikte ayrı/isteğe bağlı, varsayılan kapalı tek seferlik AI açık rızasını; dosya analizinde sade bilgilendirme ve ayarlardan geri çekmeyi onayladı.

Mobil source-of-truth: https://github.com/atacell85-cloud/reptrio-mobile/blob/feat/build44-ai-consent-plan/docs/tasks/BUILD_44_AI_CONSENT_APPROVED_FLOW.md

## Taslak API ve D1 kontratı

- Ayrı, versioned, authenticated `ai_import_consent` kaydı (account/user id, policy version, grantedAt, revokedAt, last action). Ayrı audited decisions (action/version/time; document or raw content NEVER logged) veya eşdeğer kanıtlanabilir veritabanı tasarımı. Geliştirme sırasında migration numarası diğer Build44 migrationlarla çakışmayacak şekilde kesinleştirilecek. D1 schema/migration bu aşamada **uygulanmadı**.
- `GET /api/privacy/ai-import` -> current policy text/version, account-scoped granted status and last decision; non-existent/migration-not-installed => **not granted**. `POST /api/privacy/ai-import/consent` -> explicit {accept:true/false, policyVersion} and authenticated same-origin account, idempotent grant/revoke; transition timestamp server-generated. Exact endpoints further review subject.
- Üyelikte email signup checkbox, kayıt tamamlanınca authenticated consent POST; provider signup creates account separately, opt-in offered once in welcome with explicit user action, normal login no inferred consent. Signup failure or consent POST failure leaves OFF.
- Consent record cannot be transferred between accounts; no consent from `emailVerified`/OAuth proof, provider name, signup timestamp or static client header. Deleted/pending-deletion accounts cannot grant or upload. 30-day recovery doesn't automatically renew revoked AI consent.

## All-path deny-before-egress, including old endpoints

Relevant worker `worker/index.js` currently routes public `POST /api/import/parse`, signed-in `POST /api/import/jobs`, signed-in retry, background Worker consumer `processImportJob` and `syncOpenAIBackgroundJob`. Every path capable of OpenAI input, upload or job replay needs server-only permission checks. In particular:
- Legacy `/api/import/parse` is presently callable without `currentUser`. It **must** be authenticated + permitted or safely retired before any privacy release; client-side controls alone cannot fix this.
- Create: authenticate, ACTIVE, permission-version check **before** parsing/accepting/uploading file and writing a new import job; immediately before OpenAI submit recheck; race blocked by serialized consent/job state transition or equivalent no-post-revoke egress invariant.
- Retry and queue: ownership + ACTIVE + permission on each attempt, not only when first enqueued. An old queued job becomes disabled/cancelled when consent revoked. Delayed queue deliveries, concurrent retries, stale mobile, old endpoint bypass and re-enqueue must not send.
- Stored `background:true, store:true` OpenAI responses: inspect response retrieval and deletion capabilities, retention, revocation and account deletion. Existing OpenAI copies cannot be claimed retrospectively removed on revoke; disclose actual limits. `store:true` settings and response deletion independently privacy-reviewed.
- Error contract e.g. `AI_CONSENT_REQUIRED` with 403 and `AI_CONSENT_OUTDATED` with 403 where helpful; generic error never sends original file/name/text to logs. Backend acceptance fixture must prove **OpenAI fetch count 0** if no valid permission.
- Consent must be accessible across devices; stored on backend, not `AppData.settings` alone. Revocation policy controls server even if a client has stale granted cache.

## Runtime change impact and rollout order

1. Independent Planner mandatory impact map: `worker/index.js`, `worker/account-api.js` auth invariants (read-only unless necessary), new consent-policy module, additive D1 migration, import worker SQLite tests + fixtures, backend docs. Test /privacy endpoints for authentication, CSRF, missing schema/unsupported migration, replay, concurrent revoke, old client and account status.
2. Backend defaults to DENY if schema absent or status unknown. Migration/back-end unit tests then independent HIGH Guardian. Database migration/prod deployment requires separate explicit authorization; no silent fail-open rollout to keep old imports working.
3. Mobile opt-in UI, privacy management and import action indicator can be released only with compatible server end-to-end verification. Avoid letting user see 'consent granted' before actual confirmed server state.
4. Privacy counsel sign-off for KVKK 2026/347 separate aydınlatma/rıza and cross-border lawful mechanism; Apple 5.1.2(i) third-party AI disclosure. No broad generic `all data processing` consent.

**Acceptance:** user can use app/manual routine without AI consent; fresh email/Apple/Google grant separate; signup and reauth do not auto-opt-in; permission once for subsequent uploads (with small notice and deliberate `Analyze` action), not repeat modal; settings revoke; all egress paths fail closed; no imported content logged; 0 upstream requests on unauthorized, correct async queued/revoke behavior, HIGH Guardian PASS before merge/deploy.

Official references: https://developer.apple.com/app-store/review/guidelines/ ; https://www.kvkk.gov.tr/Icerik/8710/veri-sorumlulari-tarafindan-acik-riza-ve-aydinlatma-metinlerinin-ayri-ayri-duzenlenmesi-gerektigi-hakkinda-kisisel-verileri-koruma-kurulunun-18-02-2026-tarihli-ve-2026-347-sayili-ilke-kararina-iliskin-kamuoyu-duyurusu .
