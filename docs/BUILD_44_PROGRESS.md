# Build 44 backend ilerleme — 2026-10-09

B44-08 ZIP JSON+CSV ve B44-10 güvenli kişisel yedek restore son onaylı kapsamı kaydedildi; `BUILD_44_BACKUP_RESTORE_CONTRACT.md` mobil kontratla eşleşir. Runtime/schema NOT_STARTED, tests NOT_RUN, Guardian PENDING; deploy/migration/veri silme yapılmadı. B45-01 source-specific external workout transfer ayrı sonraki sürüm PLAN_ONLY. Sonraki: mevcut sync transaction/identity/account-status kaynak incelemesi, önemli schema kararı için kullanıcı onayı ve küçük feature branch'te odak testleri.

Başlangıç `npm test` PASS, yerel test server/fixture'lar; production verisi veya servis değişmedi. Mevcut sync SELECT+koşulsuz UPSERT ve PWA eksik snapshot yazımı restore için güvenli transaction kanıtı değildir. A (iki hesap-scoped işlem/kimlik journal tablosu + revision/capability guard) / B (entity storage/sync) seçimi kullanıcı onayı bekler: mobile `docs/tasks/BUILD_44_RESTORE_ARCHITECTURE_DECISION.md`. Runtime/migration/deploy başlamadı.

## 2026-10-08 — Mimari B onaylandı; geliştirme devam ediyor

Kayıt bazlı depolama/sync, kullanıcı “tamam devam et” mesajıyla onaylandı. Önceki USER_APPROVAL_PENDING mimari A/B kayıtları bu son kararla geçersizdir. İlk backend dilimi Planner source/impact-map incelemesinde; migration/deploy yapılmadı. Önce record storage + atomic version/account guard ve legacy uyumluluk, sonra export/restore staging/preview/confirmation/journal/undo/sync/stats dilimleri. Pure inspector PR17 önceki bağımsız temel dilimdir, full ZIP restore henüz tamamlanmadı.

## 2026-10-09 — İlk B storage/sync dilimi IMPLEMENTED_LOCAL / tam akış PARTIAL

Tarihsel NOT_STARTED ve A/B onay bekliyor satırları önceki checkpoint'tir; mimari B kullanıcı tarafından onaylandı ve bu ilk backend dilimi artık kodda yereldir. `0008_record_sync_storage.sql`, `worker/record-sync-storage.js`, pull/push delegation ve authenticated capabilities; account deletion/maintenance cleanup footprint; SQLite limit/barrier instrumentation ve record sync testleri eklendi. Legacy snapshot/projection satırları korunur, bootstrap sonrası kayıtlar authoritative olur. Aynı revision/bootstrap yarışında tek SQL CAS kazanır; tüm sonraki yazımlar o hesabın yeni revision+write_token+ACTIVE+silinmemiş kullanıcı koşuluna bağlıdır. Hata bütün batch'i geri alır. Tombstone eski cihazın güncel revision ile yeniden yaratmasını da reddeder.

`npm run test:record-sync`, `npm run test:account-deletion` (FK on/off), tam `npm test` ve `git diff --check` PASS. Odak test: legacy zero-write; legacy rev pre-read/CAS yarışı; bootstrap ve mevcut hesap yarışı; unchanged revision; >2MB/<4MB tam veri roundtrip; mobile group/storageKey identity ve PWA raw-id array; opaque alan, unknown future root/child deletion ve container loss; gerçek SQL rollback; ACTIVE/BLOCKED/deleted/account isolation; migration missing/version unsupported; stream/row/depth/node/count/bind budget; finish/cancel/rest timer/builder clear; id-less AI individual prescriptions ve kind-scoped child identity. Beş kritik semantik mutant yakalandı. Tam testin fixture port 8090 dinlemesi sandbox'ta EPERM ile engellendi; yalnız yerel test için izinli tekrar PASS. Production ağ/hesap/veri/migration kullanılmadı.

HIGH bağımsız Guardian PENDING; implementation agent commit/push yapmadı. `test:change-guardian` backend paketinde bulunmuyor; yapılmamış bir kontrol PASS olarak kaydedilmez. UI/mobile/native/HealthKit/Watch kodu bu dilimde değişmedi. B44-08/B44-10 tüm ZIP/restore hedefi tamamlanmadı: coherent snapshot pagination, credential projection, staging/preview/confirmation, merge/journal/undo/idempotent dedup ve mobile entegrasyonu sonraki dilimlerdir. Production D1/deploy/iOS build/TestFlight NOT_STARTED.

Kanonik güncel ledger: `BUILD_CURRENT.md`. Teknik kontrat ve risk sınırı: `BUILD_44_RECORD_STORAGE_HANDOFF.md`.

## 2026-10-09 — İlk bağımsız Guardian düzeltme checkpoint'i

İlk HIGH Guardian **DURDURULDU**: genel nested-field koruması gerçek completedAt undo ve import lifecycle'ı engelliyor, eksik0008 ortamında account-delete yeni tabloyu bekliyordu. Ayrı source-backed read-only Planner amendment'ına göre mevcut kapsam içinde giderildi. Phone/Watch completed true→false dışında completedAt omission kapalı; preview pending/failed/retry/ready operational scalar omission bilinen geçişe bağlı; known recursive transport/PWA resolution/normalizedDocument coverage ile finalize/discard; PWA known draft set/group/activity removal; schema8 local female/male hero stripping. Unknown root/child/operational-object kaybı yine zero-write. Gerçek Watch512/closed20/Health1000 retention PASS, ledger clear reddedilir; cache/finalizations istisnası eklenmedi.

Account deletion schema+version gate auth/confirm/password sonrası ve Apple/OpenAI öncesindedir. Missing0008 eski listeyle çalışır; ready version eski+yeni temizler; partial/bad-column/unsupported-version 503 ve 0 external/DB cleanup. FK on/off fixture kanıtı PASS. Yeni full `npm test` ve `git diff --check` ardından taze HIGH Guardian PENDING; önceki DURDURULDU kendiliğinden PASS sayılmaz. Commit/push/build/deploy/migration/gerçek kullanıcı silme yapılmadı.

Guardian düzeltmeleri sonrası son doğrulama: `npm test` EXIT 0; log `/private/tmp/reptrio-b44-phase1-guardian-fixes-20261009.log`. `npm run test:record-sync`, `npm run test:account-deletion` (FK on/off) ve `git diff --check` PASS. Yeni bağımsız HIGH Guardian PENDING; commit/push yoktur.

### 2026-10-09 — İkinci tam Guardian sonrası PWA retry null düzeltmesi

İkinci tam bağımsız HIGH Guardian genel kararı DURDURULDU kaldı; önceki düzeltmeler geçti, tek kalan gerçek PWA retry `app.js:532–533` errorCode:null → fresh ready'de omission regresyonu giderildi. Ayrı read-only Planner dar amendment'ına göre yalnız exact `importPreviews[importId].errorCode` için matching-id verified pending→ready replacement'ta önceki null omission kabul edilir. Mevcut string geçiş izinleri korunur; parserStatus/failedAt string-only, object/array errorCode ve unknown preview/document/prescription loss zero-write kalır. Schema5 fixture gerçek null retry kullanır; schema8 mobile delete path değişmedi. Dedicated failed seed→retry null→fresh ready başarıları revision 1→2→3 ve unrelated data equality ile doğrulandı; invalid state/id/null-field ve adjacent unknown negatives revision/write değiştirmez. Fresh tam HIGH Guardian yeniden PENDING; commit/push ve production/build yoktur.

PWA null amendment final doğrulama: odak `npm run test:record-sync` ve tam `npm test` EXIT 0; son log `/private/tmp/reptrio-b44-phase1-pwa-null-fix-20261009.log`. `git diff --check` PASS. Yeni full bağımsız HIGH Guardian PENDING; önceki DURDURULDU verdict korunur, commit/push yoktur.


### 2026-10-09 — Son tam bağımsız HIGH kabulü

Frozen13 dosya, base `6ba344a6f1043c3a421acc895e5502e46cfb45ae`: bağımsız Guardian **GEÇTİ**. Önceki DURDURULDU kayıtları tarihsel kanıttır; son dar PWA null düzeltmesinden sonra tam inceleme yeniden yapıldı. Actual PWA failed→null retry→ready SQLite200/revision1→2→3, unrelated data exact; sekiz invalid state/id/type/unknown-loss kontrolünde sıfır yazım. Full npm test EXIT0, record-sync beş kritik mutant PASS, account deletion FK on/off ve external cleanup öncesi schema/version gates PASS; syntax/diff PASS. Backend mechanical test:change-guardian NOT_AVAILABLE.

Bu yalnız yerel record-storage diliminin kabulüdür. Production migration/deploy/build/TestFlight veya kullanıcı verisi silme yetkilendirilmedi/yapılmadı. Record-aware/write-disabled rollback artifact yayın ön koşulu olarak açık kalır; eski whole-account writer'a geri dönülmez. Sonraki dilim paged transport/root delta, ardından staged publisher/personal restore ve native entegrasyondur.
## 2026-10-09 — İlk kayıt depolama dilimi kabul edildi

`feat/build44-record-storage@a25046df171c30dd70bc790db82ae764cb49bda6` commit/push tamamlandı; taslak PR4 https://github.com/atacell85-cloud/reptrio-backend/pull/4 (base build44/planning, merge edilmedi). Additive migration0008 yalnız dosya/yerel fixture kapsamındadır. Tek record authority, atomik revision/token CAS, durable tombstones, legacy read ve kayıp korumalı eski API uyumluluğu uygulanmıştır.

Taze tam bağımsız HIGH Guardian GEÇTİ. Full npm test EXIT0, gerçek SQLite yarış/rollback/bütçe kontrolleri, beş kritik mutant, PWA null retry 1→2→3, phone/Watch undo ve account deletion FK on/off/external cleanup öncesi schema gates PASS. Mechanical test:change-guardian backend'de NOT_AVAILABLE.

Sonraki küçük dal `feat/build44-record-transport`, acceptedbase a25046d: paged raw record reads, bounded complete-root mutations, signed cursors/order ve retry receipts. Planner yedi bölüm etki haritası verdi; implementasyon başladı, kabul henüz yok. Ardından staged normal publisher ve personal restore/journal/undo; sonrasında native akış/local hydration/stats. Tam B44-08/B44-10 PARTIAL.

Production migration/deploy, iOS build/TestFlight veya gerçek kullanıcı verisi silme yapılmadı. Record-aware emergency rollback artifact yayın kapısı olarak açık kalır. B45 external adapters PLAN_ONLY.
