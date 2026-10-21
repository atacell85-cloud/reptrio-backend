# Build 47 backend — production rollout

**Durum:** `PRODUCTION_DEPLOYED` (kullanıcı onayı: "BUILD 47 — GOOGLE PLACES + PRODUCTION BACKEND + FINAL RELEASE", madde 2).
Google Places anahtarı/kotası ayrı adım: bkz. "Google Places yapılandırması" (aşağıda).

## Uygulama kaydı (2026-10-21)

| Adım | Sonuç |
| --- | --- |
| Hesap | `wrangler whoami` → Atacell85@gmail.com's Account (`d92ece05…8f98`), d1/workers write kapsamı |
| Önceki aktif sürüm | `72b88bbb-6790-474d-8679-ef4c484315ce` (Build 46, 2026-10-18) — beklenen |
| Bekleyen migration | yalnız `0016_sync_data_features.sql` |
| Secret adları | 12 ad, Build 46 ile aynı (değerler okunmadı) |
| Kaynak | `b6b379b809e096e06b50df783c5cd8af15adb7bd` temiz; Node 22.23.2 `npm test` (21 grup) PASS, `cf:build` PASS (`logs/prod-gate-*.log`). Kod `3ed251d` ile aynı (yalnız bu belge farklı) |
| Ön sayımlar | users 86, sync_records 326, sync_account_state 1, d1_migrations 16; beklenen backfill 0 hesap; queue `a2-import-jobs` 1 producer / 1 consumer; D1 24 sa write 0 |
| Time Travel yer imi | `00000261-00000000-0000510b-cb1a6ebe6d6c40f005f46f2be297c10f` (07:30Z öncesi) |
| Migration | 2026-10-21T07:30:02Z `migrations apply DB --remote` → 0016 ✅ (4 komut). Tablo + `sync_account_data_features_monotonic` trigger var; satır 0; defter 0016 son; users 86 / sync_records 326 değişmedi; tekrar `migrations list` → uygulanacak yok |
| Deploy | 2026-10-21T07:31:15Z, sürüm **`69cb03a3-85d3-438b-9ef5-f5b1e7f50e39`** (%100), mesaj "Build 47 backend b6b379b…". Routes app/api.reptrio.com, 3 cron, queue producer/consumer, D1, 4 rate limiter (`PLACES_LIMITER` 12/60 s dahil) korunmuş |
| Salt okunur smoke | `/api/health` 200; `/api/auth/providers` 200; oturumsuz `/api/places/autocomplete` ve `/verify` 401 `AUTH_REQUIRED`; oturumsuz `/api/sync/pull` ve `/push` 401; secret sayısı 12 |
| Canary | `logs/prod-canary.mjs` (hesap sahibi çalıştırır; izole sentetik hesap, normal silme sözleşmesiyle temizlik). Sonuç: bekliyor |

Geri dönüş notu: Build 46 Worker'ına (`72b88bbb…`) rollback H1 korumasını kaldırır (aşağıda); otomatik yapılmaz.
Time Travel restore yalnız ayrı kullanıcı onayıyla.

## Kaynak ve hedef

- Hedef kaynak: `build47/gyms-google-places` `b6b379b` (Guardian tur 5 PASS).
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

- Worker: `npx wrangler rollback 72b88bbb-6790-474d-8679-ef4c484315ce` (Build 46). Eski Worker yeni tabloyu yok sayar; rollback'in
  kendisi kayıt silmez. **Uyarı (Guardian tur 2 F5):** Build 46 Worker'ında H1 koruması yoktur. Rollback sırasında Build 47 verisi
  olan hesaplarda Build 46 istemcileri yeniden yazabilir: anahtar düşüren yazımlar eski `noFieldLoss` ile reddedilir, ama değer
  düzeyindeki bozulma (Build 46'nın ölçümlerde `null`→`0` normalizasyonu) kabul edilir. Ayrıca Build 46 Worker'ı Build 47'nin
  silme/Undo/yeniden etkinleştirme/bağlantılı antrenman bitirme yazımlarını reddeder. Geri dönüldüyse Build 47 uygulaması
  dağıtılmamalı ve dağıtılmışsa kullanıcılar etkilenir — rollback yalnız acil durumda.
- Migration geri alınmaz (ek tablo zararsız). Gerekirse yalnız marker tablosu: `DROP TRIGGER sync_account_data_features_monotonic;
  DROP TABLE sync_account_data_features;` — kullanıcı verisi içermez; tekrar 0016 ile yeniden oluşturulabilir.
- Beklenmeyen veri durumu: Time Travel yer imine restore yalnız ayrı onayla (sonraki tüm yazımları geri alır).

## Bilinen istemci geçiş durumları

- Build 46 cihazı, hesap Build 47 verisi kazandıktan sonra yazamaz (`SYNC_CLIENT_UPGRADE_REQUIRED`); değişiklikleri cihazda bekler.
  Cihaz Build 47'ye güncellenince ilk push `SYNC_SCHEMA_LOSS_RISK` alır; Build 47 bu durumda bir kez sunucudan çeker ve yalnız
  Build 46'nın düşürdüğü anahtarları (salon `googlePlaceId`/`archivedAt`, tarihli ölçüm alanları; journal Build 46'da korunur)
  hâlâ yerelde bulunan kayıtlara geri koyar — birleştirme (union) yapmaz, bu yüzden yerelde silinenler silinmiş kalır; Undo
  geri alınmaz; geri yüklenen anahtarlar `syncMetadata.lastLossRecovery`'de kaydedilir; tek deneme (mobil
  `restoreFieldsDroppedByOlderClient`, Guardian tur 2 F2 / tur 3 R3-1..3; uçtan uca testte doğrulandı). Kurtarma yalnız
  çekilen sürüm reddedilen tabanla aynıysa çalışır (R4-1); sunucu bu arada ilerlediyse hiçbir şey benimsenmez/yazılmaz,
  eski tabanlı yeniden deneme `SYNC_CONFLICT` alır ve mevcut çakışma birleştirmesi diğer cihazın kayıtlarını korur.
- Staged-sync (SYNC) yolu artık istemci seviyesini `finalize`'a iletir (F4). Mobil bu yolu kullanmıyor.
- Önceden var olan, Build 47 dışı: schema 8 taslağından set satırı silme her seviyede reddedilir (uygulamada böyle bir akış yok);
  8 komutlu kayıt sıralama mutation'ı workerd/Node 26 SQLite'ında `nested too deep` (hiçbir istemci kullanmıyor);
  `worker/record-sync-storage.js` doğrudan (worker girişi olmadan) içe aktarılırsa transport döngüsü yüzünden TDZ verir (F7).
