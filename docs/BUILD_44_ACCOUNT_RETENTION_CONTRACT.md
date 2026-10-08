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
