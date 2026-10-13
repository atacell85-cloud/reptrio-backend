# Build 44 / B44-04 — 30 Günlük Geri Alınabilir Hesap Silme: Sunucu Sözleşmesi

**Ürün kararı (2026-10-08):** Hesap silmede varsayılan seçenek 30 gün kurtarma süresi. Ayrıca kullanıcı aynı akışta **hemen kalıcı silme** yolunu seçebilmeli. Bu belge yalnızca implementasyon gereksinimidir; backend kodu, D1 ve canlı servis değişmedi.

Mobil karar ve kullanıcı akışı: https://github.com/atacell85-cloud/reptrio-mobile/blob/build44/planning/docs/tasks/BUILD_44_30_DAY_ACCOUNT_RECOVERY.md

## API ve veri modeli taslağı

- D1 `users` için geriye uyumlu `account_status`, `deletion_requested_at`, `purge_at` durum bilgisi, gerekirse `account_deletion_events` ve kilitleme/iş kuyruğu metadata'sı. Alan adları nihai mühendislik planında kilitlenecek; zamanlar UTC tutulacak.
- `ACTIVE`, `PENDING_DELETION`, `PURGING`, `DELETED` durumlarını sunucu doğrular; client flag güvenilir kaynak değildir.
- E-posta kullanıcısı önce kayıtlı adresine 10 dakikalık tek kullanımlık silme doğrulama bağlantısı alır. Link GET kendi başına hesap durumunu değiştirmez, açık kullanıcı onayı gerekir.
- Nihai onay işleminde iki yöntem: `DELETE_AFTER_30_DAYS` (varsayılan), `DELETE_NOW` (alternatif). Yöntem seçimi yalnız authenticated/re-authenticated kullanıcı tarafından yapılabilir.
- `DELETE_AFTER_30_DAYS` son onay zamanından itibaren `purge_at = now + 30*24h`. İstek idempotent; istek sonrası hesabın tüm giriş/normal işlem yolları güvenli kapatılır, session tokenları geçersizleşir ve başka cihazdan stale sync yazımı reddedilir.
- Hesabın sahibi tekrar kimliğini doğruladığında `PENDING_DELETION` için yalnız `GET status`, `POST recover`, `POST purge-now` gibi dar izinli işlemler açık olmalı. Normal login ile veriler açılmaz veya silme iptal edilmez; `recover` için ayrıca açık onay gerekir.
- `PURGING` başladıktan sonra otomatik kurtarma kabul edilmez. Recovery ve purge aynı D1 snapshot/transaction lock karşısında yarış güvenli olmalı.
- Server Cron/queue purge zamanlarını periyodik tarar. `now >= purge_at` olan hesapları güvenli tekrar deneyerek kalıcı olarak siler. Worker crash, Apple revoke/third-party failure, timeout, D1 batch exception için idempotent retry ve alarm/operasyon raporu zorunlu. Sessizce sonsuz saklama yasak.
- Aynı kullanıcıya ait `user_data`, `programs`, `workout_sessions`, `workout_sets`, `user_settings`, `sync_metadata`, `import_jobs`, `auth_sessions`, `oauth_accounts`, reset/silme tokenları ve yeni B44 kayıtları dâhil tam ilişkili silme kapsamı doğrulanacak. Apple Sign In token revocation ve OpenAI stored response temizlik siyaseti planın parçasıdır.
- Hukuken tutulması gereken azami/ayrı audit kayıtları gerekçeli, ayrı şema ve açıklama ile sınırlandırılır. 30 gün yalnız kullanıcıya açık kurtarma programı kapsamıdır, üçüncü tarafların yasal/teknik retention garantisi değildir.
- Pending hesaplar AI import queue, Watch/session write, sync ve eski client endpoint'lerinin tümünde yetkisiz olmalı. Silme başlatılırken asenkron iş ve yükleme yarışlarını iptal et veya bloke et.
- Backend `deletionContext` mevcut kırılgan OAuth account-origin algısı (aynı `created_at` timestamp) düzeltilmeden aktif hale getirilmez.

## Kabul testleri

1. OAuth/Apple/Google ve e-posta hesabı için doğrulama, opsiyonel export, iki açık silme yolu ve son onay.
2. `DELETE_AFTER_30_DAYS` sonrası hiçbir normal API login/sync/AI upload kabul edilmez; diğer cihaz tokenları ve eski istemci push reddedilir.
3. 29. gün güvenli kimlik doğrulama + bilinçli recover antrenman geçmişini eksiksiz geri getirir; yanlış hesap/otomatik login geri getirmez.
4. Süre dolmadan purge yok; dolduğunda idempotent kalıcı silme. 30. gün recovery/purge yarışında hem yanlış purge hem yeniden aktifleşme yok.
5. `DELETE_NOW` 30 gün beklemez. Apple revoke veya D1 hatasında asla sahte silme başarısı yok.
6. Cron yeniden başlatma, rate limit, silme token replay, mail link scanner GET, client offline, restore sonrası yeniden silme ayrı test.
7. KVKK / Apple politika kontrolü; HIGH/CRITICAL bağımsız Guardian PASS, prod migration ve deploy için ayrı açık yetki.

Resmî kaynaklar: https://developer.apple.com/support/offering-account-deletion-in-your-app/ ; https://www.kvkk.gov.tr/Icerik/5441/KISISEL-VERILERIN-SILINMESI-YOK-EDILMESI-VEYA-ANONIM-HALE-GETIRILMESI-HAKKINDA-YONETMELIK .

## B44-10 kişisel dosya restore ile ayrım (2026-10-08)

30 gün recovery aynı hesabın doğrulamalı reaktivasyonudur. B44-10 ise kullanıcıda bulunan REPTRIO-Verilerim.zip dosyasını yeni ACTIVE hesaba preview+onay sonrası taşır; eski hesap/auth token/provider binding yeniden oluşmaz, purge süresi uzamaz. Pending/purging/deleted hedef normal import/sync kabul etmez. Yeni kayıt önce boş, restore isteğe bağlıdır. Ortak detay `BUILD_44_BACKUP_RESTORE_CONTRACT.md` (mobile: `docs/tasks/`, backend: `docs/`).

## 2026-10-13 — B44-04 implemented backend contract (isolated, HIGH)

Union baseline `d6419a8` preserves PR10 AI consent and PR11 restore V2/repeated READY behavior. Additive `0013_account_lifecycle.sql` is local only. No production migration, deploy, deletion, build or TestFlight is authorized. Whole-B44 independent HIGH Guardian and physical provider/device validation remain **DEFERRED/PENDING** by user instruction.

The implemented state is `ACTIVE` → `PENDING_DELETION` → `PURGING`; physical removal returns `DELETED` in the successful direct response, with no tombstone/receipt or post-deletion proof endpoint. Pending never uses legacy `deleted_at`. `credential_origin` explicitly records PASSWORD/GOOGLE/APPLE for new accounts and UNKNOWN for every existing row. Legacy timestamps never establish provenance or email verification. Registered email proof POST alone may establish `email_verified_at`.

| API | Authorization/request | Successful response |
|---|---|---|
| `GET /api/auth/delete` | Normal ACTIVE session | `contractVersion:2`, `requiresPassword:false`, `verification:"EMAIL_LINK_OR_LINKED_PROVIDER"`, `defaultMethod:"DELETE_AFTER_30_DAYS"`, `providers`, `appleReauthRequired` |
| `POST /api/auth/delete/request-link` | Normal ACTIVE session, JSON `{}` | 202 `{ok:true,expiresInSeconds:600}`; mail error503, no usable issued link retained |
| `POST /api/auth/delete/verify-link` | Same user and exact session that requested link; `{token}` | `{proof,expiresInSeconds:600}`; atomically consumes link; does not close/delete account |
| `POST /api/auth/reauth/google` or `/apple` | Normal session or scoped recovery token; `{}` | `{ticket,provider}`; start OAuth with `reauth=ticket`, mobile client and `reptrio://` redirect |
| Fresh linked-provider callback | New state/nonce/code, exact provider+subject and ticket/session binding; no link/create/switch | ACTIVE: redirect fragment `#proof=…`; recovery: `?reauth=ok` marks that scoped credential verified; Apple material stays encrypted |
| `POST /api/auth/delete` | Normal ACTIVE session; `{confirm:"DELETE",proof,method?}` | Default method `DELETE_AFTER_30_DAYS`: `{ok:true,accountStatus:"PENDING_DELETION",deletionRequestedAt,purgeAt}`. `DELETE_NOW`: direct `{ok:true,accountStatus:"DELETED"}` only after cleanup |
| Password/OAuth login for pending/purging owner | Existing owner credentials/provider-sub | 201 `{accountStatus,recoveryToken,expiresAt}`; no normal session/user data. Password verification is fresh ownership; OAuth recovery needs separate linked-provider ticket verification |
| `GET /api/auth/account/status` | `Authorization: Bearer recoveryToken` only | `{user:{id,email},providers,appleReauthRequired,purgeError,accountStatus,deletionRequestedAt,purgeAt,ownershipVerificationRequired,canRecover}`; identity/lifecycle state only, no personal payload |
| `POST /api/auth/account/recover` | Scoped token with fresh ownership; `{confirm:"RECOVER"}` | 201 standard new mobile `{user,sessionToken,expiresAt}` only when PENDING and current UTC time `<purgeAt` |
| `POST /api/auth/account/purge-now` | Scoped token with fresh ownership; `{confirm:"DELETE"}` | Direct `{ok:true,accountStatus:"DELETED"}` only after cleanup; retryable error preserves locked state |

HTTPS link is `https://api.reptrio.com/account-deletion-link#token=…`. GET/HEAD emits static no-store/no-referrer CSP-protected HTML with an explicit `reptrio://account-deletion#token=…` handoff. It never writes D1 or consumes the token. Tokens/proofs are random256-bit, stored only as SHA-256 digests, purpose/account/session-bound,10minutes, single use. No credentials belong in HTTP query parameters, logs, referrers or operational events.

Normal-session issuance is conditional on ACTIVE inside SQL. The shared account DB guard adds ACTIVE to existing ownership predicates and outer same-snapshot owner gates to bounded scoped payload reads. Legacy predecessor schemas keep existing sync behavior; an absent lifecycle migration is never cached. Existing record/storage/transport/restore CAS/receipt/protocol/opaque codecs and budgets remain intact. Pending revokes all normal sessions, reset tokens, mobile OAuth codes, provider tickets and lifecycle proofs atomically, cancels queued/processing AI jobs, and preserves personal data/revisions/identity.

Purge has a conditional owner lease, bounded cron batch8, exponential retry up to24hours, and overdue structured alerts after1hour; timestamps/deadlines are never extended. Complete cleanup readiness runs before upstream effects. Apple revoke and required OpenAI deletion failures do not return success. Final atomic cleanup explicitly covers legacy, consent/audit, record/mutation, restore/journal, lifecycle credential and execution-work rows with FK ON/OFF.

### AI execution amendment and crash limit

Owner-scoped `account_lifecycle_work` rows are execution metadata, not deletion receipts or a result fence. Background stored-response work leases are acquired atomically only while ACTIVE with current consent. A returned response ID is recorded durably using a narrowly scoped operational writer even when normal publication has closed. Unpublished late results are removed upstream; purge waits/retries while RUNNING/UNKNOWN/unresolved work exists, and its final SQL batch also checks this condition.

An upstream-create crash before durable ID persistence is intrinsically unknown: expiry does **not** prove the remote object disappeared. Such work becomes UNKNOWN, remains a visible retry/overdue operational condition and blocks false permanent-success claims until safely reconciled. Production alert routing/operator reconciliation evidence is a release gate. Official OpenAI APIs require a response ID to [cancel background work](https://developers.openai.com/api/docs/guides/background) or [delete a stored response](https://developers.openai.com/api/reference/resources/responses/methods/delete).

Fresh linked-provider proof means a new exact-subject authorization ceremony and separate final confirmation. It does not promise provider password re-entry: [Google explicitly does not support Google Account reauthentication requests](https://developers.google.com/identity/siwg/security-bundle); its documented prompts are none/consent/select_account, not login/max_age. Apple docs do not establish guaranteed password re-entry. Normal login parameters remain unchanged; mobile should use its isolated ephemeral verification ceremony. Physical provider/browser behavior remains PENDING.

Missing account/401 is never permanent-deletion proof. Response loss after a transition is unknown; mobile preserves owner data/custody until a direct matching success. No post-delete receipt endpoint or fence was added. A pre-lifecycle runtime downgrade becomes unsafe once pending users exist; rollback requires a lifecycle-aware artifact, not the union baseline alone.

### Submission prerequisites and legacy password-reset compatibility

Before either final30-day or immediate submission, every linked Apple authorization must have ready revoke configuration and a decryptable, nonempty encrypted refresh token. No provider revocation occurs at scheduling. Missing/corrupt/rotated material gives `APPLE_REAUTH_REQUIRED`; missing configuration gives `APPLE_REVOKE_UNAVAILABLE`, with the account ACTIVE and sessions/data/proof unchanged. Exact linked-provider reauthorization supplies material. The verified subject/ciphertext snapshot is repeated in the transition SQL CAS so concurrent provider-link/material changes cannot strand a knowingly unpurgeable account. Actual later outage/key rotation remains PURGING retry/overdue handling after claim, without extending the deadline.

Forgot-password preserves explicit PASSWORD accounts and legacy UNKNOWN accounts with **no** provider rows; the same ACTIVE/eligibility predicate guards issue and every reset statement. A successful mailbox-proven reset chooses a password and atomically records PASSWORD provenance. Known GOOGLE/APPLE remain excluded even if their provider link is missing. UNKNOWN with any linked provider stays ambiguous and fail-closed; timestamps, including exact collision or skew, never authorize reset or auto-link. OAuth auto-link eligibility requires verified email, explicit originating provider provenance and its matching trusted linked identity. Existing exact-sub login works when Apple omits email in later ID tokens.

Final local verification: lifecycle/deletion(OAUTH/FK ON/OFF/all populated tables)/OAuth/reset/AI/Worker/onboarding/storage/transport/restore focus PASS; restore33 checks including actual5,101sessions/66,313sets publication and full ALLundo, storage5+transport5+restore6 existing critical mutations PASS. Added outcome tests cover day29 exact complete record/state bytes, exact10minute expiry, parallel proof/finalization, both recovery/purge winners, late storage/bootstrap/delta/restore commit/undo closures, Apple prerequisites and ID-write crash uncertainty. Syntax/diff PASS. Full `npm test` could not complete locally: first sandbox fixture-listen EPERM, then escalated smoke Chrome CDP startup failure. Parent-approved `.github/workflows/build44-account-lifecycle.yml` runs the existing complete npm suite with Node22; remote final verification PENDING before mobile implementation. Whole-B44 independent HIGH Guardian/device evidence remains deferred, not claimed passed.
