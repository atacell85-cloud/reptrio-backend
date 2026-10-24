# B49-001 — Places konum sözleşmesi (backend)

**Durum:** KODLANDI + TESTLİ (2026-10-24); **DEPLOY EDİLMEDİ / MIGRATION UYGULANMADI**. Eşlenik mobil: `reptrio-mobile:build49/integration` `docs/build49/B49_001_LOCATION_AWARE_GYM_DISCOVERY.md`.

## Kullanıcı kararları (2026-10-24)
- Nearby limiti **muhafazakâr**: hesap başına **24 saatte 5 istek** (ilk sayılan istekten 24 saat, tüm cihazlar ortak), **5 km** yarıçap, en fazla **20** sonuç, mesafeye göre sıralı. Autocomplete 100 / `first-use-24h` aynen kalır.
- Ayrıca **proje-genel günlük tavan** (UTC gün); sayı deploy sırasında `PLACES_NEARBY_PROJECT_DAILY_CAP` ile **kullanıcı onayıyla** verilir (kodda varsayılan yok → kapalı).
- Backend: kod + test yapıldı; production deploy / migration `0018` / env değişkenleri **ayrı açık onay** ve `OPS-PREFLIGHT` sonrasıdır.

## API
`POST /api/places/autocomplete` — Build 47/48 gövdesi aynen geçerli. İsteğe bağlı `location:{latitude,longitude}` (tam bu iki sonlu sayı, aralık içi; 4 ondalığa yuvarlanır; yanlış biçim **400**, sessizce düşürülmez). Google'a `locationBias.circle` (yarıçap 50 000 m = belgelenen azami) olarak gider; kısıt (restriction) değil, yalnız öncelik.

`POST /api/places/nearby` — gövde `{latitude, longitude, languageCode?, regionCode?}` (başka alan 400). Auth → yapılandırma → gövde → burst limiter → hesap payı → proje tavanı → Google. Yanıt `{places:[{placeId,name,address,distanceMeters}],attribution:'Google Maps'}`; mesafe sunucuda istek noktasından hesaplanır, Google koordinatı/puanı iletilmez.
Hatalar: `503 PLACES_NOT_CONFIGURED` (kapalı), `429 PLACES_NEARBY_DAILY_LIMIT`, `503 PLACES_NEARBY_CAPACITY` (proje tavanı), `429 PLACES_RATE_LIMITED`, `502/503` sağlayıcı.

Google isteği: `places:searchNearby`, `includedTypes:['gym','fitness_center']`, `maxResultCount:20`, `rankPreference:DISTANCE`, `locationRestriction.circle` 5000 m, **FieldMask `places.id,places.displayName,places.formattedAddress,places.location`** (Nearby Search **Pro** SKU alanları; daha üst katman alanı yok). Resmî belge doğrulaması: radius 0–50 000, maxResultCount 1–20, rankPreference DISTANCE|POPULARITY, locationBias circle ≤ 50 000 m; fiyat katmanı alan maskesine göre belirlenir. Güncel fiyat/ücretsiz kullanım Cloud Console'dan deploy öncesi doğrulanacak (kodda fiyat varsayımı yok).

## Açma kapıları (deploy aşaması, onay ister)
1. `OPS-PREFLIGHT`; 2. D1 migration `0018_places_nearby_quota.sql` (additif, tekrar çalıştırılabilir); 3. Worker env: `PLACES_NEARBY_QUOTA_POLICY='first-use-24h'` **ve** `PLACES_NEARBY_PROJECT_DAILY_CAP='<onaylı sayı>'`; 4. Google Cloud'da Places API (New) kota/bütçe uyarısı. Biri eksikse rota kapalıdır; mobil özellik bu durumda “yakındakiler kullanılamıyor” gösterir, manuel ekleme etkilenmez.

## Gizlilik / güvenlik
Koordinat yalnız izin+geçerli cihaz konumundan, istek süresince bellekte; D1'e, loga ve Google isteğinde hesap kimliğine yazılmaz (testte tüm tablolar taranır). Hesap silinince `places_nearby_usage` satırı hem FK cascade hem migration’daki `AFTER DELETE ON users` trigger’ı ile silinir (FK kapalı purge yollarında da; final-erase 40 sorgu bütçesi nedeniyle uygulama tarafında ek DELETE yok). Proje sayacı kişisel veri içermez.

## Test
`npm run test:places-nearby` (ve tam `npm test`). Mobil geriye uyum: eski istemciler konum göndermez → Build 48 davranışı.
