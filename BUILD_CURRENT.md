# Reptrio — Güncel çalışma kaydı

## Build 44 · B44-08 / B44-10 · 2026-10-09

Kullanıcının onayladığı mimari **B** üzerinde ilk backend storage/sync dilimi uygulanmıştır. Tüm ZIP JSON+CSV dışa aktarma ve güvenli kişisel yedek geri yükleme hedefi **PARTIAL / DEVAM EDİYOR**. Bu dilim tam yedek/restore akışının tamamlandığını göstermez.

- Çalışma branch'i: `feat/build44-record-storage`.
- Değişiklik öncesi referans: `6ba344a6f1043c3a421acc895e5502e46cfb45ae`.
- Yerel additive migration: `0008_record_sync_storage.sql`; production'a uygulanmadı.
- Record authority, tek transaction SQL CAS, revision/write-token sahipliği, tombstone ve legacy read adapter: IMPLEMENTED_LOCAL.
- Odak gerçek SQLite testleri ve beş kritik semantik mutant: PASS.
- Tam `npm test`: PASS (yerel fixture server için sandbox port izni gerekti; production işlemi yok).
- Bağımsız HIGH Guardian: ilk inceleme DURDURULDU; kaynakta doğrulanan undo/import/legacy-delete regresyonları düzeltildi. Yeni tam bağımsız inceleme PENDING; commit/push bekler.
- Production migration/deploy, iOS build, TestFlight ve gerçek kullanıcı verisi silme: NOT_STARTED / ayrı açık talimat gerekir.

Guardian düzeltme checkpoint: phone/Watch draft undo, import pending/failed/retry/ready ve known-schema finalize/discard, PWA set/group/activity deletion, local hero stripping, gerçek Watch/Health retention controls; missing0008 legacy cleanup ve partial/unsupported schema/version için external cleanup öncesi fail-closed gate. Unknown personal alan koruması ve atomic CAS değişmedi.

Sonraki dilimler: coherent paged export, ZIP/CSV credential projection, restore staging/preview, açık kullanıcı onayı, atomik merge/journal/dedup/undo ve cross-device/stats kanıtı. Yeni runtime burada bulunmaz. B45 dış kaynak import adapter'ları PLAN_ONLY; Local Watch ve kök Build 44 planı korunur.

Teknik kapsam, hata kontratı ve rollback sınırı: [record storage handoff](docs/BUILD_44_RECORD_STORAGE_HANDOFF.md). Detaylı ilerleme: [Build 44 ilerleme](docs/BUILD_44_PROGRESS.md).

Guardian düzeltmeleri sonrası son doğrulama: `npm test` EXIT 0; log `/private/tmp/reptrio-b44-phase1-guardian-fixes-20261009.log`. `npm run test:record-sync`, `npm run test:account-deletion` (FK on/off) ve `git diff --check` PASS. Yeni bağımsız HIGH Guardian PENDING; commit/push yoktur.

### 2026-10-09 — İkinci tam Guardian sonrası PWA retry null düzeltmesi

İkinci tam bağımsız HIGH Guardian genel kararı DURDURULDU kaldı; önceki düzeltmeler geçti, tek kalan gerçek PWA retry `app.js:532–533` errorCode:null → fresh ready'de omission regresyonu giderildi. Ayrı read-only Planner dar amendment'ına göre yalnız exact `importPreviews[importId].errorCode` için matching-id verified pending→ready replacement'ta önceki null omission kabul edilir. Mevcut string geçiş izinleri korunur; parserStatus/failedAt string-only, object/array errorCode ve unknown preview/document/prescription loss zero-write kalır. Schema5 fixture gerçek null retry kullanır; schema8 mobile delete path değişmedi. Dedicated failed seed→retry null→fresh ready başarıları revision 1→2→3 ve unrelated data equality ile doğrulandı; invalid state/id/null-field ve adjacent unknown negatives revision/write değiştirmez. Fresh tam HIGH Guardian yeniden PENDING; commit/push ve production/build yoktur.

PWA null amendment final doğrulama: odak `npm run test:record-sync` ve tam `npm test` EXIT 0; son log `/private/tmp/reptrio-b44-phase1-pwa-null-fix-20261009.log`. `git diff --check` PASS. Yeni full bağımsız HIGH Guardian PENDING; önceki DURDURULDU verdict korunur, commit/push yoktur.


### 2026-10-09 — Son tam bağımsız HIGH kabulü

Frozen13 dosya, base `6ba344a6f1043c3a421acc895e5502e46cfb45ae`: bağımsız Guardian **GEÇTİ**. Önceki DURDURULDU kayıtları tarihsel kanıttır; son dar PWA null düzeltmesinden sonra tam inceleme yeniden yapıldı. Actual PWA failed→null retry→ready SQLite200/revision1→2→3, unrelated data exact; sekiz invalid state/id/type/unknown-loss kontrolünde sıfır yazım. Full npm test EXIT0, record-sync beş kritik mutant PASS, account deletion FK on/off ve external cleanup öncesi schema/version gates PASS; syntax/diff PASS. Backend mechanical test:change-guardian NOT_AVAILABLE.

Bu yalnız yerel record-storage diliminin kabulüdür. Production migration/deploy/build/TestFlight veya kullanıcı verisi silme yetkilendirilmedi/yapılmadı. Record-aware/write-disabled rollback artifact yayın ön koşulu olarak açık kalır; eski whole-account writer'a geri dönülmez. Sonraki dilim paged transport/root delta, ardından staged publisher/personal restore ve native entegrasyondur.
