# Build 52 — Production API doğrulaması

**Genel sonuç: PRODUCTION API VERIFIED** — iki bağımsız çalıştırma, ikisi de 38/38 PASS: 16:29:07Z–16:29:53Z ve son kod ile
16:32:41Z–16:33:37Z (aşağıdaki tablo). 5xx yok, Worker hatası yok.

Hedef: API `https://api.reptrio.com`, Worker sürümü `59083b99-7904-4aa1-92e9-0c8dea9f3114` (%100), backend commit `4e59064`
(deploy kaydı `9377299`). Önceki rapor sürümleri: `4f5c0b0`, `78e1def`, `81109c3` (BLOCKED aşamaları; tarihçe olarak korunur).

Raporda token, parola, oturum çerezi, sıfırlama bağlantısı veya kişisel veri yoktur. Kullanıcı kimlikleri 8 karakterlik önekle verilir.

## Nasıl çalıştırıldı
- Betik: `scripts/ops/prod-api-verify.mjs verify --reset-via-zoho` (kılavuz `docs/PROD_API_TEST_ACCOUNTS.md`), bu bulut oturumundan.
  Ağ: Default ortamına yalnız `api.reptrio.com` eklendi (kullanıcı onayı). Zoho Mail erişimi kullanıcının güvenli formla
  kaydettiği token ile, proxy üzerinden; değer oturuma hiç görünmedi.
- Kalıcı test hesapları (silinmez, sonraki Build'lerde yeniden kullanılır):
  - **A** `test@reptrio.com` `b7cd559b…` — 2026-10-08'den beri var; yeniden oluşturulmadı. Kişisel kart, CRUD, senkron, eski istemci 409.
  - **B** `test-delete@reptrio.com` `3d799b8d…` — 2026-11-06T16:27:20Z normal kayıt ucu ile oluşturuldu (adresin Zoho'da tanımlı
    olduğu önce doğrulandı). İzolasyon ve veri düzeyi 1 uyumluluğu; hiç kart almaz.
- Parolalar: her çalıştırmada resmî sıfırlama akışıyla (`/api/auth/password/forgot` → Zoho'daki Reptrio e-postası → `/api/auth/password/reset`)
  rastgele parola belirlenir ve **yalnız bellekte** tutulur; hiçbir yere yazılmaz. Oturumlar sonunda kapatılır.
- Zoho'da yalnız `no-reply@mail.reptrio.com`'dan test adreslerine gelen, istekten sonra alınan "şifre sıfırlama" e-postaları okundu.
  Başka e-posta açılmadı, gönderilmedi, silinmedi.
- Yapılmayanlar: deploy, migration, rollback, SQL ile yazma/silme, gerçek hesaplara dokunma, mobil build, TestFlight, main merge.

## 1. Sürüm ve yönlendirme (Cloudflare, salt-okunur)
| Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| Aktif deployment | `59083b99…` %100 | aynı (oluşturma 2026-11-05T22:29:55Z) | PASS |
| Özel alan adları | api/app.reptrio.com → `a2-workout` production | aynı | PASS |
| Worker hataları | 0 | 16:20Z–16:30Z: 38 istek / 0 hata; deploy'dan beri 0 hata | PASS |

## 2. HTTP kontrolleri (gerçek istekler)
| # | UTC | Metot | Yol | Adım | Beklenen | HTTP | Kod | Sonuç |
|---|---|---|---|---|---|---|---|---|
| U1 | 16:32:41 | GET | /api/health | unauthenticated contract | 200 | 200 | - | PASS |
| U2 | 16:32:42 | GET | /api/auth/providers | unauthenticated contract | 200 | 200 | - | PASS |
| U3 | 16:32:42 | GET | /api/sync/capabilities | unauthenticated contract | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| U4 | 16:32:42 | GET | /api/sync/capabilities | unauthenticated contract | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| U5 | 16:32:43 | GET | /api/sync/pull | unauthenticated contract | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| U6 | 16:32:43 | POST | /api/sync/push | unauthenticated contract | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| U7 | 16:32:43 | POST | /api/sync/push | unauthenticated contract | 403 AUTH_ORIGIN_INVALID | 403 | AUTH_ORIGIN_INVALID | PASS |
| U8 | 16:32:43 | POST | /api/sync/push | unauthenticated contract | 415 UNSUPPORTED_CONTENT_TYPE | 415 | UNSUPPORTED_CONTENT_TYPE | PASS |
| U9 | 16:32:43 | POST | /api/backup/restore/operations | unauthenticated contract | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| U10 | 16:32:43 | GET | /api/auth/delete | unauthenticated contract | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| U11 | 16:32:43 | GET | /api/sync/push | unauthenticated contract | 405 METHOD_NOT_ALLOWED | 405 | METHOD_NOT_ALLOWED | PASS |
| R-A | 16:33:00 | POST | /api/auth/password/reset | password set via official reset mail (A) | 202 forgot, mail found, 200 reset | 200 | - | PASS |
| R-B | 16:33:23 | POST | /api/auth/password/reset | password set via official reset mail (B) | 202 forgot, mail found, 200 reset | 200 | - | PASS |
| A1 | 16:33:24 | POST | /api/auth/login | sign in A (pinned id) | 201, user id == pinned | 201 | - | PASS |
| A2 | 16:33:25 | POST | /api/auth/login | sign in A (pinned id) | 201, user id == pinned | 201 | - | PASS |
| B1 | 16:33:26 | POST | /api/auth/login | sign in B (pinned id) | 201, user id == pinned | 201 | - | PASS |
| C1 | 16:33:27 | GET | /api/sync/capabilities | capabilities A | 200 personalExercises=1, personalBackupVersions [1,2,3] | 200 | - | PASS |
| S1 | 16:33:27 | GET | /api/sync/pull | pull A (level 2) | 200 | 200 | - | PASS |
| K1 | 16:33:27 | POST | /api/sync/push | create card (push, level 2) | 200 syncVersion+1 | 200 | - | PASS |
| K2 | 16:33:28 | GET | /api/sync/pull | read card from second client session | 200, card equal field by field | 200 | - | PASS |
| K3 | 16:33:29 | POST | /api/sync/push | update card (name, description, rev+1) | 200 | 200 | - | PASS |
| K4 | 16:33:29 | GET | /api/sync/pull | read update from other session | 200, updated fields | 200 | - | PASS |
| O1 | 16:33:30 | POST | /api/sync/push | old client push (data level 1) | 409 SYNC_CLIENT_UPGRADE_REQUIRED | 409 | SYNC_CLIENT_UPGRADE_REQUIRED | PASS |
| O2 | 16:33:30 | POST | /api/sync/push | old client push (data level absent) | 409 SYNC_CLIENT_UPGRADE_REQUIRED | 409 | SYNC_CLIENT_UPGRADE_REQUIRED | PASS |
| O3 | 16:33:31 | POST | /api/backup/restore/operations | old client restore start (data level 1) | 409 SYNC_CLIENT_UPGRADE_REQUIRED | 409 | SYNC_CLIENT_UPGRADE_REQUIRED | PASS |
| O4 | 16:33:31 | GET | /api/sync/pull | old client pull (data level 1) still allowed | 200 | 200 | - | PASS |
| O5 | 16:33:32 | GET | /api/sync/pull | refused writes changed nothing | 200, same syncVersion and card | 200 | - | PASS |
| I1 | 16:33:32 | GET | /api/sync/pull | B pull (data level 1) | 200, no A card | 200 | - | PASS |
| L1 | 16:33:32 | POST | /api/sync/push | B push without cards (data level 1) | 200 (account stays below level 2) | 200 | - | PASS |
| I2 | 16:33:33 | GET | /api/sync/pull | B pull after A writes: no A card | 200, no A card | 200 | - | PASS |
| I3 | 16:33:33 | GET | /api/sync/pull | no session cannot read | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| D0 | 16:33:33 | GET | /api/sync/pull | card present before delete | 200, this run's card live | 200 | - | PASS |
| D1 | 16:33:34 | POST | /api/sync/push | delete card: tombstone via sync | 200 | 200 | - | PASS |
| D2 | 16:33:35 | POST | /api/sync/push | release tombstone from array via sync | 200 | 200 | - | PASS |
| D3 | 16:33:35 | GET | /api/sync/pull | card absent after re-sync | 200, card absent | 200 | - | PASS |
| Z-A1 | 16:33:36 | POST | /api/auth/logout | logout A1 | 200 | 200 | - | PASS |
| Z-A2 | 16:33:36 | POST | /api/auth/logout | logout A2 | 200 | 200 | - | PASS |
| Z-B1 | 16:33:36 | POST | /api/auth/logout | logout B1 | 200 | 200 | - | PASS |
Notlar: K2/K4 kartı alan alan karşılaştırır; O5 reddedilen yazmaların syncVersion ve kartı değiştirmediğini doğrular; I1/I2
B'nin verisinde A'nın kart kimliğinin olmadığını doğrular; D3 kartın yeniden senkronda geri gelmediğini doğrular.
Ayrıca daha önce (10:10Z) ayrı oturumdan yapılan 20 kimliksiz istek de beklenen kodları verdi (`78e1def`).

## 3. D1 salt-okunur karşılaştırma (`a2-workout-pilot`)
| Ölçüm | Önce (16:27:00Z) | Sonra (16:30:00Z) | Fark ve sebep |
|---|---|---|---|
| Kullanıcı (silinmiş işaretli) | 87 (47) | 88 (47) | +1 = test hesabı B |
| Gerçek hesap `16525506…` sync | 7 kayıt / 403 B / tombstone 0 / rev 2 / düzey 1 | aynı | 0 |
| Gerçek hesap `1a5de8f8…` sync | 920 / 413 819 B / 455 / rev 2480 / düzey 1 | aynı | 0 |
| `user_data` | 23 satır / 461 632 B | aynı | 0 |
| A `b7cd559b…` | sync yok, düzey yok | 5 kayıt / 15 B / tombstone 0 / rev 4 / **düzey 2**; `personalExercises` satırı `[]` | test (beklenen, kalıcı) |
| B `3d799b8d…` | yok | 4 kayıt / 13 B / tombstone 0 / rev 1 / düzey satırı yok (0) | test; düzey 2'ye çıkmadı |
| Açık oturum (test hesapları) | 0 | 0 | çıkış yapıldı |

Canlı kullanıcı trafiği bu pencerede veri değiştirmedi; görülen tüm farklar iki test hesabına aittir. Son çalıştırma
(16:32:38Z → 16:33:37Z) arasında tek fark A'nın revizyonu (4 → 8: oluştur, güncelle, tombstone, bırak); A'da kart yok, B değişmedi,
gerçek hesaplar aynı.

## 4. Rollback ve veri düzeyi
A kalıcı olarak veri düzeyi 2'de (yalnız artar); kartı yok. Gerçek hesaplar düzey 1'de. Worker geri alımı gerçek hesapları
etkilemez; A'ya eski Worker ile yazılamayabilir — bu yalnız test hesabını etkiler. Kayıtlar elle SQL ile temizlenmez.

## 5. Kalan notlar
- 16:27Z'deki ilk deneme Zoho çağrısında zaman aşımıyla durdu (yazma yok; yalnız A için bir sıfırlama e-postası gitti, kullanılmadı,
  30 dakikada geçersizleşir). Betiğe Zoho çağrıları için yeniden deneme eklendi, ikinci çalıştırma temiz geçti. Guardian bulgusuyla alıcı filtresi tam adres
eşleşmesine (tek alıcı, gönderen `no-reply@mail.reptrio.com`) çevrildi; son çalıştırma bu kodla yapıldı.
- `app.reptrio.com` bu kapsamda kontrol edilmedi (API doğrulaması).
- Zoho erişim token'ı yaklaşık 1 saat geçerli. Sonraki Build'lerde aynı komut yeni bir Zoho token'ı gerektirir (veya Mac Keychain yolu).
- Zoho token'ı bu posta kutusunda tam yetkili ve kutu test dışı gerçek adresleri de barındırıyor; ayrı test kullanıcısı + salt-okunur
  token önerilir. Sohbete düşen eski refresh token iptal edilmelidir.
- Hesap silme testi bu doğrulamanın kapsamında değildir (ayrı iş).
