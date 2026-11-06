# Build 52 — Production API doğrulaması

**Genel sonuç: BLOCKED — "PRODUCTION API VERIFIED" VERİLMEDİ.**
Kimliksiz HTTPS kontrolleri ve Cloudflare salt-okunur kontrolleri geçti. Oturum açmayı gerektiren bütün kontroller
(capability içeriği, kişisel kart uçtan uca, hesap izolasyonu, eski istemci 409, yedek V3 akışı, hesap silme) **BLOCKED**.
Sebep: kontrolümüzde bir test posta kutusu yok (aşağıda).

Tarih: 2026-11-06 (UTC). Hedef: API `https://api.reptrio.com`, Worker sürümü `59083b99-7904-4aa1-92e9-0c8dea9f3114`,
backend commit `4e59064` (deploy kaydı `9377299`). İlk BLOCKED raporu: `4f5c0b0`.

Raporda token, parola, oturum çerezi, e-posta adresi veya kişisel veri yoktur. Kullanıcı kimlikleri yalnız 8 karakterlik önekle verilir.

## Çalışma ortamı ve sınırlar
- HTTPS istekleri `api.reptrio.com`'a izinli "Reptrio" ortamında açılan ayrı bir oturumdan gönderildi (kullanıcı onayı, 2026-11-06).
  Default ortamın ağı genişletilmedi; proxy/ağ denetimi aşılmaya çalışılmadı.
- Cloudflare (Worker sürümü, D1, analytics) kontrolleri ana oturumdan, salt-okunur API ile yapıldı.
- Hesap açılmadı, giriş yapılmadı, e-posta tetiklenmedi. Deploy, migration, rollback, SQL ile yazma/silme yapılmadı.
  Production'a yazma yapılmadı.

## Neden hesap gerektiren testler BLOCKED
Normal hesap silme akışı e-posta doğrulaması istiyor: `POST /api/auth/delete/request-link` hesabın adresine 10 dakika geçerli,
tek kullanımlık bir bağlantı gönderiyor. `POST /api/auth/delete/verify-link` ile `POST /api/auth/delete` yalnız o bağlantıdaki
token'la ve aynı oturumdan çalışıyor (`worker/account-lifecycle.js`). Kullanıcı kararı (2026-11-06): teslim edilemeyen sentetik
adres kullanılmaz; ZeptoMail üzerinden doğrulanmamış adrese e-posta gönderilmez; kontrolümüzdeki posta kutusu hazır olana kadar
hesap açılmaz. Böyle bir posta kutusu şu an yok. Bu yüzden test hesabı açılmadı.

## 1. Sürüm ve yönlendirme (Cloudflare API, salt-okunur)
| Kontrol | Beklenen | Gerçek | Zaman (UTC) | Sonuç |
|---|---|---|---|---|
| Aktif deployment | `59083b99…` %100 | `59083b99-7904-4aa1-92e9-0c8dea9f3114` %100, oluşturma 2026-11-05T22:29:55Z | 10:00:07 | PASS |
| Özel alan adları | api/app.reptrio.com → `a2-workout` production | ikisi de `a2-workout` / production | 09:57:19 | PASS |
| Yeni sürümde Worker hatası | 0 | 22:30Z–10:00Z: 956 istek / 0 hata; 10:05Z–10:17Z (test penceresi): 34 istek / 0 hata | 10:17:00 | PASS |

## 2. Kimliksiz HTTPS kontrolleri (gerçek istekler, Reptrio ortamı)
Kaynak sözleşmesi: `worker/account-api.js`, `worker/account-lifecycle.js`, `worker/index.js`. Sahte bearer, her çalıştırmada
üretilen rastgele 43 karakterlik bir değerdir; gerçek bir token değildir ve yazdırılmadı.

| # | UTC | Metot | Yol | Not | Beklenen | HTTP | Gövde `code` | Sonuç |
|---|---|---|---|---|---|---|---|---|
| 1 | 10:10:55 | GET | /api/health | – | 200 | 200 | `{"ok":true,"service":"reptrio",…}` | PASS |
| 2 | 10:10:56 | GET | /api/auth/providers | – | 200 | 200 | `{"providers":{"google":true,"apple":true}}` | PASS |
| 3 | 10:10:56 | GET | /api/sync/capabilities | kimliksiz | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| 4 | 10:10:56 | GET | /api/sync/capabilities | sahte bearer | 401 AUTH_REQUIRED | 401 | AUTH_REQUIRED | PASS |
| 5 | 10:10:56 | POST | /api/sync/capabilities | JSON `{}` | 405 | 405 | METHOD_NOT_ALLOWED | PASS |
| 6 | 10:10:57 | GET | /api/me | kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 7a | 10:10:57 | GET | /api/sync/pull | kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 7b | 10:10:57 | GET | /api/sync/pull | sahte bearer | 401 | 401 | AUTH_REQUIRED | PASS |
| 8a | 10:10:58 | POST | /api/sync/push | JSON `{}` kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 8b | 10:10:58 | POST | /api/sync/push | `Origin: https://evil.example` | 403 AUTH_ORIGIN_INVALID | 403 | AUTH_ORIGIN_INVALID | PASS |
| 8c | 10:10:58 | POST | /api/sync/push | `Content-Type: text/plain` | 415 | 415 | UNSUPPORTED_CONTENT_TYPE | PASS |
| 8d | 10:10:59 | GET | /api/sync/push | – | 405 | 405 | METHOD_NOT_ALLOWED | PASS |
| 9 | 10:10:59 | GET | /api/sync/records | kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 10 | 10:10:59 | POST | /api/sync/records/mutations | JSON `{}` kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 11a | 10:10:59 | POST | /api/backup/restore/operations | JSON `{}` kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 11b | 10:10:59 | POST | /api/backup/restore/operations | `X-Reptrio-Data-Level: 1` | 401 | 401 | AUTH_REQUIRED | PASS |
| 12 | 10:11:00 | GET | /api/backup/restore/operations/00000000-…/receipt | kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 13 | 10:11:00 | POST | /api/backup/restore/operations/not-a-uuid/commit | – | 404 RESTORE_ROUTE_INVALID | 404 | RESTORE_ROUTE_INVALID | PASS |
| 14 | 10:11:00 | POST | /api/sync/records/operations/00000000-…/undo | – | 404 RESTORE_ROUTE_INVALID | 404 | RESTORE_ROUTE_INVALID | PASS |
| 15 | 10:11:00 | GET | /api/auth/delete | kimliksiz | 401 | 401 | AUTH_REQUIRED | PASS |
| 16 | 10:11:01 | GET | https://app.reptrio.com/ | – | 200 | yanıt yok (proxy `CONNECT tunnel failed, response 403`) | – | BLOCKED (bu ortamda host izinli değil) |

5xx sayısı: **0**. #1–#15'in hepsi `content-type: application/json; charset=utf-8` ve `cache-control: no-store` döndü;
hiçbirinde `Set-Cookie` yok.

## 3. Oturumlu kontroller — BLOCKED (test hesabı yok)
| Kontrol | Beklenen (kaynaktan) | Sonuç |
|---|---|---|
| Oturumlu `GET /api/sync/capabilities` | 200, `personalExercises: 1`, `personalBackupVersions: [1,2,3]` | BLOCKED |
| A hesabı: kart oluşturma / okuma / güncelleme / tombstone silme / ikinci istemci senkronu / tekrar görünmeme | push/pull ile alan alan eşit; tombstone geri gelmez | BLOCKED |
| B hesabı ve oturumsuz istemci A kartını göremez | B pull'unda kart yok; oturumsuz 401 | BLOCKED (oturumsuz 401 kısmı §2'de PASS) |
| Kartlı hesapta `X-Reptrio-Data-Level: 1` yazma | 409 `SYNC_CLIENT_UPGRADE_REQUIRED`, veri değişmez | BLOCKED |
| Kartsız hesapta normal senkron | 200, veri kaybı yok | BLOCKED |
| Yedek V1/V2/V3 başlat/önizle (geri yükleme) | sözleşmeye uygun yanıt | BLOCKED |
| Hesap silme (request-link → verify-link → delete) ve sonrası D1'de kalan senkron/tombstone kayıtları | PENDING_DELETION/PURGING, oturumlar iptal | BLOCKED |

## 4. D1 salt-okunur karşılaştırma (`a2-workout-pilot`)
| Ölçüm | Önce (09:57:19Z) | Sonra (10:16:51Z) | Fark |
|---|---|---|---|
| Kullanıcı (silinmiş işaretli) | 87 (47) | 87 (47) | 0 |
| En yeni kullanıcı kaydı | – | 2026-10-21T19:47:47Z | test hesabı yok |
| `sync_records` `16525506…` | 7 kayıt / 403 B / tombstone 0 / rev 2 | aynı | 0 |
| `sync_records` `1a5de8f8…` | 920 / 413 819 B / tombstone 455 / rev 2480 | aynı | 0 |
| Veri düzeyi | iki hesap 1 | iki hesap 1 | 0 |
| Kişisel kart kaydı | 0 | 0 | 0 |
| `user_data` | 23 satır / 461 632 B / son 2026-10-16T19:08:20Z | aynı | 0 |

Test sırasında canlı kullanıcı değişikliği de test kaynaklı değişiklik de olmadı. Kimliksiz istekler veri yazmadı.

## 5. Rollback ve veri düzeyi notu
Production'da kart yok; bütün hesaplar veri düzeyi 1'de. Worker geri alımı bugün hiçbir hesabın verisini etkilemez.
Gelecekteki yazma testinde ilk kart yalnız o test hesabını düzey 2'ye çıkarır. Bu düzey ve tombstone kayıtları hesap
silinse bile purge tamamlanana kadar kalabilir; bunlar elle SQL ile temizlenmez.

## 6. Kalan riskler
- Kişisel kart, izolasyon, eski istemci 409 ve yedek V3 production'da HTTP ile **kanıtlanmadı**.
- `app.reptrio.com` bu ortamdan erişilemedi.
- Analytics yalnız Worker istisnalarını sayıyor; HTTP durum dağılımı §2'deki doğrudan isteklerle sınırlı.

## Engeli kaldırmak için
1. Kontrolümüzde iki adres (veya `+` takma ad) alabilen bir test posta kutusu ve doğrulama oturumunun silme bağlantısı
   token'ını okuyabileceği güvenli bir yol (kullanıcı kararı gerekir; token sohbete yapıştırılmaz).
2. Sonra aynı Reptrio ortamında §3 uçtan uca çalıştırılır; önce/sonra D1 karşılaştırması tekrarlanır.
3. `app.reptrio.com` kontrolü için Reptrio ortamına bu host eklenir (isteğe bağlı).
