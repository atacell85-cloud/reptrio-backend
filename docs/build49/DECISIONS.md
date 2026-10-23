# REPTRIO Backend Build 49 — karar defteri

**2026-10-24 başlangıcı:** `build49/integration` dalı, Build 48 son kaydı `f05401234af0ebd92dbadaf4c35a7270b04a1a05` üzerinden açıldı. Eşlenik mobil dal `atacell85-cloud/reptrio-mobile:build49/integration` temel commit `e4019edbd145a8cd0675faf659ef5c966a94619b`.

Build 48 geliştirme döngüsü kullanıcı kararıyla kapanıyor; bekleyen Watch/Live Activity fiziksel testleri PASS sayılmaz. Build 49 ilk kod görevi henüz onaylanmadı. Production Worker `2d52c211-665e-418a-9d60-d7d952576596`, mevcut APNs anahtar yönlendirmesi ve `PLACES_DAILY_QUOTA_POLICY=first-use-24h` değiştirilmez.

Önemli devralınan bakım: `OPS-PREFLIGHT` backend deploy öncesi otomatik kontrolleri, **sonraki backend deploy'dan önce** uygulanmalı. Bu kayıt yetki veya deploy izni değildir. Google 429/kota/maliyet görevi `prelaunch/topics` / AS-PRE-001 ile ilk kamuya açık App Store çıkışı öncesine ayrılmıştır; Build 49'un zorunlu ilk işi değildir.

Kullanıcı onayı olmadan secret, canlı Worker, D1 migration, production deploy, TestFlight, main merge veya cihaz kurulumu yapılmaz.
