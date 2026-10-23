# REPTRIO Backend Build 49 — karar defteri

**2026-10-24 başlangıcı:** `build49/integration` dalı, Build 48 son kaydı `f05401234af0ebd92dbadaf4c35a7270b04a1a05` üzerinden açıldı. Eşlenik mobil dal `atacell85-cloud/reptrio-mobile:build49/integration` temel commit `e4019edbd145a8cd0675faf659ef5c966a94619b`.

Build 48 geliştirme döngüsü kullanıcı kararıyla kapanıyor; bekleyen Watch/Live Activity fiziksel testleri PASS sayılmaz. Build 49 ilk ürün görevi B49-001 olarak geliştirme sırasına alındı, henüz kodlama onayı verilmedi. Production Worker `2d52c211-665e-418a-9d60-d7d952576596`, mevcut APNs anahtar yönlendirmesi ve `PLACES_DAILY_QUOTA_POLICY=first-use-24h` değiştirilmez.

Önemli devralınan bakım: `OPS-PREFLIGHT` backend deploy öncesi otomatik kontrolleri, **sonraki backend deploy'dan önce** uygulanmalı. Bu kayıt yetki veya deploy izni değildir. Google 429/kota/maliyet görevi `prelaunch/topics` / AS-PRE-001 ile ilk kamuya açık App Store çıkışı öncesine ayrılmıştır; Build 49'un zorunlu ilk işi değildir.

Kullanıcı onayı olmadan secret, canlı Worker, D1 migration, production deploy, TestFlight, main merge veya cihaz kurulumu yapılmaz.

## B49-001 — Konuma göre salon keşfi, sadece yeni salon ekleme (2026-10-24)

Eşlenik mobil spesifikasyon: `atacell85-cloud/reptrio-mobile:build49/integration/docs/build49/B49_001_LOCATION_AWARE_GYM_DISCOVERY.md`.

- **Yeni salon ekle** açılınca iOS konum izni istenir; izin + geçerli konum olmadan Google Autocomplete veya Nearby çağrısı yok. İzin reddinde **yalnız manuel salon kaydı**, kayıtlı salon seçimi devam.
- İzinli salon adı girişinde yakındaki sonuçları önceliklendiren mevcut Autocomplete hattı genişletilir (geçici cihaz konumu, doğrulanmış/limitli girdi; Cloudflare IP'si değil).
- Kullanıcı adı bilmiyorsa **Yakındaki salonları göster** düğmesine basınca Nearby Search (New) sonuçları mesafeye göre; **otomatik Nearby sorgusu yok**. Kayıtlı salon seçimi Google isteği oluşturmaz.
- Nearby maliyetli ve Autocomplete'ten ayrı bir SKU/kota olabilir: **sayı verilmedi**, kota ve proje maliyet koruması, field mask, abuse/429 ve günlük/oturum sınırları analiz ve açık kullanıcı kararı gerektirir. Eski 100 istek / ilk-use-24h Autocomplete kotası otomatik değiştirilmez.
- Konum geçmişi/kalıcı koordinat/log yok; API anahtarı sunucuda kalır. Güvenli eski istemci uyumu, D1/Place ID/attribution ve kullanıcı geçmişi korunur.
- Bu yalnız öncelik ve karar kaydı: backend API implementasyonu, migration, canlı Worker değişimi, secret veya deploy yetkisi vermez.
