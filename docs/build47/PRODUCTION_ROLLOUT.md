# Build 47 backend — production rollout prosedürü (HAZIR, UYGULANMADI)

**Durum:** `PRODUCTION_APPROVAL_REQUIRED`. Bu belge yalnız prosedürdür. Production D1 migration ve Worker deploy kullanıcının
ayrı, açık onayı olmadan yapılmaz. Google Places anahtarı/billing ayrı bir harici adımdır ve bu rollout'a dahil değildir.

## Kaynak ve hedef

- Hedef kaynak: `build47/gyms-google-places` dondurulmuş SHA (ikinci Guardian PASS sonrası kaydedilecek; şu an `a239754`).
- Production şu an: kaynak `370ac431c212171fdee78a78eb70233d3c017593`, Worker `a2-workout` sürüm `72b88bbb-6790-474d-8679-ef4c484315ce`,
  D1 `a2-workout-pilot`, migration defteri 0001–0015 (16 satır), 2026-10-18.
- Tek Wrangler ortamı (production). Ayrı bir staging Worker/D1 tanımlı değil; açılması Cloudflare'da yeni kaynak oluşturmak demek
  ve **ayrı onay** ister. Yerel eşdeğeri yapıldı: `wrangler dev --local` + yerel D1 (0001–0016), smoke PASS (mobil
  `docs/build47/REMEDIATION_AND_EVIDENCE.md` §3).

## Değişiklikler ve uyumluluk

- Migration `0016_sync_data_features.sql`: yalnız ek tablo + trigger + tek seferlik INSERT OR IGNORE backfill. Mevcut tablo/satır
  değişmez. Eski Worker (370ac43) yeni tabloyu hiç okumaz → migration önce uygulanabilir, eski Worker etkilenmez.
- Yeni Worker 0016 olmadan tüm sync/restore yazımlarını 503 `SYNC_STORAGE_MIGRATION_REQUIRED` ile reddeder (fail-closed) →
  **sıra zorunlu: önce migration, sonra Worker.**
- Build 46 istemcileri: Build 47 verisi olmayan hesaplarda değişiklik yok (test edildi). Build 47 verisi olan hesaplarda yazımlar
  `SYNC_CLIENT_UPGRADE_REQUIRED`; Build 46 bu kodu genel hata olarak gösterir, veriyi cihazda "sunucu bekliyor" tutar, üzerine yazmaz.
- Yeni binding: `PLACES_LIMITER` (namespace 1004). `GOOGLE_MAPS_PLACES_API_KEY` secret yoksa Places 503 `PLACES_NOT_CONFIGURED`.

## Maliyet / limit etkisi

- Her sync yazımı +1 D1 okuma (seviye), seviye yükseldiğinde +1 yazma (hesap başına bir kez). Mutation sorgu bütçesi 30 içinde
  (testlerde ölçüldü). Restore start/commit/undo: eski istemcide +1 tarama sorgusu (`instr` ile hesap kayıtları).
- 0016 backfill: tüm `sync_records` üzerinde bir kez tarama (okunan satır = toplam kayıt sayısı). Yazılan satır = Build 47 verisi
  olan hesap sayısı (Build 47 yayınlanmadığı için ~0).

## Ön kontroller (salt okunur)

1. `npx wrangler whoami` (doğru hesap), `npx wrangler deployments list` → aktif sürüm `72b88bbb…`.
2. `npx wrangler d1 migrations list DB --remote` → yalnız `0016_sync_data_features.sql` bekliyor olmalı.
3. Secret adları (değerler okunmadan): `npx wrangler secret list` — önceki sürümle aynı adlar.
4. Kaynak: temiz checkout, exact SHA, `npm ci`, `npm test` (Node 22.23.x) ve `npm run cf:build` PASS.

## Uygulama (onaydan sonra)

1. Time Travel yer imi al ve kaydet: `npx wrangler d1 time-travel info DB` (bookmark).
2. `npx wrangler d1 migrations apply DB --remote` → yalnız 0016.
3. Doğrula: `SELECT name FROM sqlite_master WHERE name LIKE 'sync_account_data_features%'` (tablo + trigger) ve
   `SELECT COUNT(*) FROM sync_account_data_features`.
4. `npm run cf:deploy` → yeni sürüm ID'sini kaydet.
5. Smoke (salt okunur): `GET /api/health` 200; `GET /api/auth/providers` 200; oturumsuz `POST /api/places/autocomplete` 401;
   oturumsuz `/api/sync/pull` 401. Yetkili canary hesap varsa: Build 47 başlıklı pull 200 ve kayıpsız push 200; başlıksız
   yazım (yalnız canary'de Build 47 verisi varken) 409 `SYNC_CLIENT_UPGRADE_REQUIRED`. Gerçek kullanıcı verisine yazılmaz.
6. Kaydet: kaynak SHA, migration sürümü, deploy zamanı, Worker sürüm/deployment ID, bookmark.

## Geri dönüş

- Worker: `npx wrangler rollback 72b88bbb-6790-474d-8679-ef4c484315ce` (Build 46). Eski Worker yeni tabloyu yok sayar; veri kaybı yok.
  **Uyarı:** Build 46 Worker'ında H1 koruması ve H2 düzeltmesi yoktur; geri dönüldüyse Build 47 uygulaması dağıtılmamalı.
- Migration geri alınmaz (ek tablo zararsız). Gerekirse yalnız marker tablosu: `DROP TRIGGER sync_account_data_features_monotonic;
  DROP TABLE sync_account_data_features;` — kullanıcı verisi içermez; tekrar 0016 ile yeniden oluşturulabilir.
- Beklenmeyen veri durumu: Time Travel yer imine restore yalnız ayrı onayla (sonraki tüm yazımları geri alır).
