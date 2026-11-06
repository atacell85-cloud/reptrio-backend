# Build 52 — Production API doğrulaması

**Genel sonuç: BLOCKED — "PRODUCTION API VERIFIED" VERİLMEDİ.**

Tarih: 2026-11-06 (UTC). Hedef: API `https://api.reptrio.com`, Web `https://app.reptrio.com`, Worker sürümü
`59083b99-7904-4aa1-92e9-0c8dea9f3114`, backend commit `4e59064` (deploy kaydı `9377299`).

Bu raporda token, parola, oturum çerezi, e-posta veya kişisel veri yoktur. Kullanıcı kimlikleri yalnız 8 karakterlik önekle verilir.

## Engelin özeti
- Bu çalışma oturumunun ağ politikası `api.reptrio.com` / `app.reptrio.com` adreslerine izin vermiyor:
  `GET https://api.reptrio.com/api/sync/capabilities` → proxy `CONNECT tunnel failed, response 403` (HTTP durumu alınamadı; istek
  Worker'a hiç ulaşmadı). 09:57Z ve 10:00Z'de tekrarlandı, sonuç aynı.
- `api.reptrio.com`'a izin veren "Reptrio" çalışma ortamı var, ancak bu oturum çalışırken o ortama taşınamıyor
  ("this kind of session cannot be moved to another environment while it runs"). O ortamda ayrı bir oturum açma denemesi otomatik
  izin denetiminde reddedildi. Güvenlik denetimi aşılmaya çalışılmadı; Default ortamın ağı genişletilmedi.
- Sonuç: gerçek HTTPS isteği gerektiren bütün kontroller (bölüm 2–4) **BLOCKED**. Test hesabı açılmadı, production'da kart
  oluşturulmadı, hiçbir veri yazılmadı.

## 1. Sürüm ve yönlendirme (Cloudflare API, salt-okunur)
| Kontrol | Beklenen | Gerçek | Zaman (UTC) | Sonuç |
|---|---|---|---|---|
| Aktif deployment | `59083b99…` %100 | `59083b99-7904-4aa1-92e9-0c8dea9f3114` %100, oluşturma 2026-11-05T22:29:55Z | 10:00:07 | PASS |
| Özel alan adları | api/app.reptrio.com → `a2-workout` production | ikisi de `a2-workout` / production | 09:57:19 | PASS |
| Yeni sürümde hata | 0 | 22:30Z–10:00Z arası `59083b99`: 956 istek, 0 hata, durum `success` | 10:00:07 | PASS (yalnız Worker istisnası; HTTP 4xx/5xx dağılımı bu veri setinde yok) |

## 2. Capabilities ve yetkilendirme — BLOCKED
Kaynaktan doğrulanan sözleşme (`worker/account-api.js`): `GET /api/sync/capabilities`, kullanıcı yoksa `401 AUTH_REQUIRED`;
oturumlu yanıtta `personalExercises: 1`, `personalBackupVersions: [1,2,3]` (`PERSONAL_EXERCISES_ENABLED` `'false'` değilse).
| Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| Oturumsuz capabilities | 401 `AUTH_REQUIRED` | istek ulaşmadı (proxy 403) | BLOCKED |
| Oturumlu capabilities | 200, `personalExercises: 1`, `[1,2,3]` | ölçülemedi | BLOCKED |
| 5xx yok | 5xx yok | ölçülemedi | BLOCKED |

## 3. Kişisel kart uçtan uca — BLOCKED
Önceden ayrılmış bir production test hesabı yok. Önerilen yol (yapılmadı, onay bekliyor): resmî `POST /api/auth/register` ile
ayrılmış alan adlı iki geçici hesap (A, B), rastgele bellek içi parola; A'da benzersiz `custom:card:<uuid>` kart push → pull ile
geri okuma/karşılaştırma → izinli alan güncelleme → ikinci istemci oturumu senkronu → B ve oturumsuz istemcinin A kartını
okuyamadığı → resmî sync ile tombstone silme ve tekrar görünmeme → hesapların resmî silme API'siyle kapatılması. Tombstone/sync
kayıtları veritabanından elle temizlenmez.
Rollback etkisi: ilk production kartı yalnız o test hesabını veri düzeyi 2'ye çıkarır; o hesap için Build 51 istemcisi
`409 SYNC_CLIENT_UPGRADE_REQUIRED` alır. Gerçek hesaplar düzey 1'de kalır (aşağıdaki anlık görüntü), Worker geri alımı onları etkilemez.

## 4. Geriye uyumluluk — BLOCKED (HTTPS) / kaynak düzeyinde kayıtlı
Kartsız hesap senkronu, kartlı hesapta eski istemci yazımının güvenli reddi, yedek V1/V2/V3 sözleşmeleri production'da HTTP ile
ölçülemedi. Kaynak düzeyindeki testler deploy öncesi geçmişti (`9377299` deploy kaydı); bu production kanıtı yerine geçmez.
Gerçek kullanıcı hesabıyla eski sürüm testi yapılmadı. Otomatik rollback yapılmadı.

## 5. Salt-okunur veri anlık görüntüsü (D1 `a2-workout-pilot`, test öncesi, 2026-11-06T09:57:19Z)
- Kullanıcı: 87 (silinmiş işaretli 47).
- `sync_records`: `16525506…` 7 kayıt / 403 B / tombstone 0; `1a5de8f8…` 920 kayıt / 413 819 B / tombstone 455. Deploy anındaki
  sayılarla aynı.
- Veri düzeyi: iki hesap da 1. Kişisel kart kaydı: 0.
- `user_data`: 23 satır, 461 632 B, son güncelleme 2026-10-16T19:08:20Z.
- Test yapılmadığından "sonra" anlık görüntüsü ve test hesabı farkı yok; canlı trafikten ayrılacak bir test değişikliği oluşmadı.

## 6. Kalan riskler
- Capabilities, kimlik doğrulama reddi ve kart yaşam döngüsü production'da HTTP ile **kanıtlanmadı**.
- Analytics yalnız Worker istisnalarını gösteriyor; HTTP 4xx/5xx dağılımı ayrıca bakılmadı.

## Engeli kaldırmak için (kullanıcı kararı)
1. `api.reptrio.com`'a izinli ("Reptrio") ortamda yeni bir oturum açıp bu görevi orada çalıştırmak (Cloudflare salt-okunur
   kontrolleri bu oturumda yapılabilir), **veya**
2. Bu oturumun Default ortamına `api.reptrio.com` (ve `app.reptrio.com`) izni eklenmesini onaylamak.
Her iki durumda da bölüm 3'teki geçici test hesabı yolu için açık onay gerekir.
