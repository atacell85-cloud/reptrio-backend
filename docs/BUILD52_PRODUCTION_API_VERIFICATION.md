# Build 52 — Production API doğrulaması

**Genel sonuç: BLOCKED — "PRODUCTION API VERIFIED" VERİLMEDİ.**
Kimliksiz HTTPS kontrolleri ve Cloudflare salt-okunur kontrolleri geçti. Oturum açmayı gerektiren kontroller
(capability içeriği, kişisel kart uçtan uca, hesap izolasyonu, eski istemci 409, veri düzeyi 1 uyumluluğu) production'da
henüz çalıştırılmadı: kalıcı test hesaplarının tek seferlik kurulumu Mac'te kullanıcı adımı bekliyor (§7).

Tarih: 2026-11-06 (UTC). Hedef: API `https://api.reptrio.com`, Worker sürümü `59083b99-7904-4aa1-92e9-0c8dea9f3114`,
backend commit `4e59064` (deploy kaydı `9377299`). Önceki rapor sürümleri: `4f5c0b0`, `78e1def`.

Raporda token, parola, oturum çerezi veya kişisel veri yoktur. Kullanıcı kimlikleri yalnız 8 karakterlik önekle verilir.

## Çalışma ortamı ve sınırlar
- HTTPS istekleri `api.reptrio.com`'a izinli "Reptrio" ortamında açılan ayrı bir oturumdan gönderildi (kullanıcı onayı, 2026-11-06).
  Default ortamın ağı genişletilmedi; proxy/ağ denetimi aşılmaya çalışılmadı.
- Cloudflare (Worker sürümü, D1, analytics) kontrolleri ana oturumdan, salt-okunur API ile yapıldı.
- Hesap açılmadı, giriş yapılmadı, e-posta tetiklenmedi. Deploy, migration, rollback, SQL ile yazma/silme yapılmadı.
  Production'a yazma yapılmadı.

## Neden hesap gerektiren testler hâlâ BLOCKED
- Plan değişti (kullanıcı kararı 2026-11-06): her testte hesap açıp silmek yerine **iki kalıcı test hesabı** kullanılır;
  parolalar yalnız proje Mac'inin **macOS Keychain**'inde tutulur, testleri Mac'teki yerel Claude Code çalıştırır.
  Hesap silme testi ve Zoho Mail API erişimi bu doğrulamadan ayrı bir iştir.
- Salt-okunur D1 kontrolü (2026-11-06): `test@reptrio.com` için production'da hesap **zaten var** (`b7cd559b…`,
  2026-10-08, ACTIVE, parolalı, sağlayıcı bağlantısı yok, senkron verisi yok, açık oturum yok). Parolası bilinmiyor; yeniden
  oluşturulmadı. `test-delete@reptrio.com` için hesap **yok**.
- Zoho posta kutularının varlığı bu ortamdan **doğrulanamadı**: DNS sorgusu ve DNS-over-HTTPS ağ politikasıyla kapalı,
  Cloudflare token'ı DNS kayıtlarını okuma yetkisine sahip değil (`10000 Authentication error`). Teslimat yalnız kullanıcı
  beyanıyla bilinir (`test-delete@` için 2026-11-06 iç test e-postası). Kurulum adımı ilk gerçek resmî e-postayla bunu kanıtlar.
- Bu yüzden: A'nın parolası resmî sıfırlama akışıyla, B ise kayıt + aynı sıfırlama akışıyla Mac'te bir kez kurulmalı (§7).
  Bu kurulum yapılmadan hesap gerektiren hiçbir production testi çalıştırılmadı.

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

## 3. Oturumlu kontroller — BLOCKED (kurulum bekliyor)
Tekrar çalıştırılabilir betik: `scripts/ops/prod-api-verify.mjs` (çalıştırma kılavuzu `docs/PROD_API_TEST_ACCOUNTS.md`).
| Kontrol | Beklenen (kaynaktan) | Production | Yerel Worker provası |
|---|---|---|---|
| A oturumu (iki istemci) ve B oturumu, sabitlenmiş kimlik | 201, `/api/me` id = sabit id | BLOCKED | PASS |
| Oturumlu capabilities | 200, `personalExercises: 1`, `[1,2,3]`, `writable` | BLOCKED | PASS |
| A: kart oluştur / ikinci oturumdan oku / güncelle / oku | 200, alan alan eşit | BLOCKED | PASS |
| A: eski istemci push (düzey 1 ve başlıksız) | 409 `SYNC_CLIENT_UPGRADE_REQUIRED` | BLOCKED | PASS |
| A: eski istemci restore başlatma (düzey 1) | 409 `SYNC_CLIENT_UPGRADE_REQUIRED` | BLOCKED | PASS |
| A: eski istemci pull; reddedilen yazmalar veriyi değiştirmez | 200; aynı syncVersion ve kart | BLOCKED | PASS |
| B: düzey 1 pull/push (kartsız), A kartı görünmez; oturumsuz okuma | 200 / 200 / 401 | BLOCKED | PASS |
| Resmî temizlik: tombstone → diziden bırakma → kart geri gelmez | 200 / 200 / yok | BLOCKED | PASS |

Yerel prova: `wrangler dev --local` (yerel D1, tüm migration'lar; Cloudflare token'ı kapalı), 2026-11-06. Guardian
düzeltmelerinden sonra: önceden bırakılmış test kartıyla başlayan çalıştırma 38/38 PASS (önce kartı resmî yolla temizledi),
ardından 36/36 PASS; eşzamanlı ikinci istemci (347 push) altında çalıştırma doğru biçimde NOT VERIFIED verdi ve A'da kart
kalmadı. Önceki üç ardışık çalıştırma 34/34 PASS; çıktıda parola/token/e-posta yok. Yerel D1: A düzey 2, `personalExercises` satırı `[]`; B için düzey
satırı yok (0). Negatif provalar: yanlış sabit kimlik → A1 FAIL, yazma yok, NOT VERIFIED; mevcut adrese `setup-register`
→ durur, hesap açmaz; B zaten sabitliyse `setup-register` → durur. Kurulum akışı (kayıt + sıfırlama bağlantısı + oturum
doğrulama) yerel sahte bağlantıyla geçti. Yerel prova production kanıtı **değildir**; macOS Keychain yolu burada
çalıştırılamadı (Linux), ilk Mac kurulumunda doğrulanır.

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
İlk doğrulama çalıştırması yalnız A'yı kalıcı olarak düzey 2'ye çıkarır (düzey yalnız artar). Kart temizlikten sonra
A'nın `personalExercises` satırı `[]` olarak kalır. B hiç kart almaz. Bu kayıtlar elle SQL ile temizlenmez.

## 6. Kalan riskler
- Kişisel kart, izolasyon, eski istemci 409 ve yedek V3 production'da HTTP ile **kanıtlanmadı**.
- `app.reptrio.com` bu ortamdan erişilemedi.
- Analytics yalnız Worker istisnalarını sayıyor; HTTP durum dağılımı §2'deki doğrudan isteklerle sınırlı.

## 7. Kalan tek kullanıcı adımı (Mac, bir kez)
```bash
npm run ops:prod-api-setup-reset -- --account A
npm run ops:prod-api-setup-register -- --account B
```
Her komut resmî sıfırlama e-postasını ister; Zoho kutusundaki bağlantı terminale gizli girişle yapıştırılır (sohbete değil).
Parolalar Keychain'e yazılır. B'nin kimliği `scripts/ops/prod-api-test-accounts.json`'a yazılır ve commit edilir.
Sonra (ve sonraki her Build'de, istemsiz): `npm run ops:prod-api-verify -- --out prod-api-verify-build52`; sonuç bu rapora
eklenir, öncesi/sonrası D1 karşılaştırması tekrarlanır. Ancak tüm kontroller geçerse "PRODUCTION API VERIFIED" yazılır.
