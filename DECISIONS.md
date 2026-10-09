# Reptrio backend karar kaydı

### 2026-10-08 — B44-08/B44-10 kayıt bazlı storage/sync mimarisi B ONAYLANDI

Kullanıcıya tek hesap snapshot satırının D1 2MB sınırı ve sync yarışları açıklandı; kayıt bazlı programs/sessions/sets/measurements/metadata ve account-scoped restore journal önerisi ardından kullanıcı “tamam devam et” dedi. Rutin uygun teknik seçimler Planner tarafından doğrulanır. Yeni önemli ürün davranışı/geri döndürülemez veri yazımı ayrı sohbet onayı ister. Migration dosyaları ve production dışı testler yetkili; production D1 migration/deploy/iOS build/TestFlight/kullanıcı verisi silme ayrı açık talimat gerektirir. Local Watch ve kök tarihi BUILD_44 korunur. Durum APPROVED / IMPLEMENTATION_NOT_STARTED (bu kayıt docs-only).

### 2026-10-09 — B ilk backend dilimi yerel olarak uygulandı

Yukarıdaki `IMPLEMENTATION_NOT_STARTED` ilk onay anının tarihsel durumudur. Şimdi `sync_account_state` ve `sync_records` additive schema, authoritative record adapter, gerçek SQL CAS ve token/ACTIVE/user gate, durable tombstones, bounded request/row/chunk planı ve authenticated capabilities yerel olarak IMPLEMENTED_LOCAL. Eski `user_data` ve projections korunur; ilk başarılı push authority marker oluşturduktan sonra kayıtlar tek kaynaktır, dual-write yapılmaz. Sayısal schema 5 PWA yalnız saf temsil edilebilir PWA hesabını düzenleyebilir; mobile schema 8 hesabına PWA yazımı fail-closed. Nested opaque alan kaybı ve unknown future alanlı root/child snapshot deletion sıfır yazımla reddedilir; kaynakta doğrulanmış workout draft/rest timer ve program builder draft clear akışları yalnız bilinen şekil için çalışır. Bounded codec depolama allowlist'i değildir; raw unknown değerler saklanır, export projection sonraki dilimdedir.

İlk dilim testleri ve tam yerel `npm test` PASS; beş kritik CAS/ownership/key/opaque-loss/tombstone mutant davranış hatasıyla yakalandı. Bağımsız HIGH Guardian PENDING. B44-08/B44-10 bütün akışı PARTIAL; restore journal, staging, preview, explicit confirmation, dedup, undo, ZIP/CSV ve client entegrasyonu henüz uygulanmadı. Production migration/deploy/build/TestFlight veya kullanıcı verisi silme yapılmadı. Legacy code'a kör rollback record authority hesaplarını eski snapshot'a döndüremez: record-aware read/write-disabled acil sürüm gerekir. Ayrıntılar `docs/BUILD_44_RECORD_STORAGE_HANDOFF.md`.

### 2026-10-09 — İlk Guardian DURDURULDU; kaynak bazlı compatibility düzeltmeleri

Bağımsız ilk inceleme gerçek phone/Watch completedAt undo, import lifecycle ve migration öncesi account-delete regresyonunu buldu; commit/push yapılmadı. Ayrı read-only Planner kaynakları doğruladı; mevcut B/continue yetkisi altında yalnız aynı 13 dosyalık kapsamda düzeltildi. Omission istisnaları schema 8 draft set explicit completed true→false, verified preview pending/failed/ready scalar fields ve local-only female/male heroPreference ile sınırlıdır. PWA draft'ta known set/group/scalar activity removal çalışır; preview finalize/discard bütün bilinen recursive transport/local/UI/document shape gerektirir. Unknown opaque root/child kaybı yine zero-write fail-closed; cache/finalizations için yeni istisna yoktur. Watch ledger 512→512 ve closed/Health scalar ID retention kontrolü eklendi, ledger clear izni eklenmedi.

Account deletion auth/confirm/password sonrasında yalnız schema/account storage version gate kullanır: iki yeni tablo yoksa legacy liste, ready/supported version için eski+yeni liste; partial/unsupported schema/state halinde Apple revoke/OpenAI cleanup ve DB DELETE öncesinde actionable 503. FK on/off testleri external side-effect counters ile kanıtlar. Odak testler PASS; final tam suite sonrası yeni bağımsız HIGH Guardian PENDING. B44-08/B44-10 toplamı PARTIAL, production/build işlemi yoktur.

### 2026-10-09 — İkinci tam Guardian sonrası PWA retry null düzeltmesi

İkinci tam bağımsız HIGH Guardian genel kararı DURDURULDU kaldı; önceki düzeltmeler geçti, tek kalan gerçek PWA retry `app.js:532–533` errorCode:null → fresh ready'de omission regresyonu giderildi. Ayrı read-only Planner dar amendment'ına göre yalnız exact `importPreviews[importId].errorCode` için matching-id verified pending→ready replacement'ta önceki null omission kabul edilir. Mevcut string geçiş izinleri korunur; parserStatus/failedAt string-only, object/array errorCode ve unknown preview/document/prescription loss zero-write kalır. Schema5 fixture gerçek null retry kullanır; schema8 mobile delete path değişmedi. Dedicated failed seed→retry null→fresh ready başarıları revision 1→2→3 ve unrelated data equality ile doğrulandı; invalid state/id/null-field ve adjacent unknown negatives revision/write değiştirmez. Fresh tam HIGH Guardian yeniden PENDING; commit/push ve production/build yoktur.


### 2026-10-09 — Son tam bağımsız HIGH kabulü

Frozen13 dosya, base `6ba344a6f1043c3a421acc895e5502e46cfb45ae`: bağımsız Guardian **GEÇTİ**. Önceki DURDURULDU kayıtları tarihsel kanıttır; son dar PWA null düzeltmesinden sonra tam inceleme yeniden yapıldı. Actual PWA failed→null retry→ready SQLite200/revision1→2→3, unrelated data exact; sekiz invalid state/id/type/unknown-loss kontrolünde sıfır yazım. Full npm test EXIT0, record-sync beş kritik mutant PASS, account deletion FK on/off ve external cleanup öncesi schema/version gates PASS; syntax/diff PASS. Backend mechanical test:change-guardian NOT_AVAILABLE.

Bu yalnız yerel record-storage diliminin kabulüdür. Production migration/deploy/build/TestFlight veya kullanıcı verisi silme yetkilendirilmedi/yapılmadı. Record-aware/write-disabled rollback artifact yayın ön koşulu olarak açık kalır; eski whole-account writer'a geri dönülmez. Sonraki dilim paged transport/root delta, ardından staged publisher/personal restore ve native entegrasyondur.


### 2026-10-09 — Phase 2A transport/root delta yerel checkpoint

Accepted storage `a25046df171c30dd70bc790db82ae764cb49bda6` sonrası approved B üzerinde yalnız A uygulandı: authenticated bounded raw pages, revision/token-bound HMAC cursor + signed64 rowid locator/exact-key digest, lightweight capabilities, complete touched-root delta, preserved global ranks/request-order append + <=8 sequential before/after commands, CAS-first tek atomic batch, account-scoped1h no-payload mutation receipts/concurrent retries ve bounded cleanup. Shared schema/compatibility/opaque-loss/known operational coverage korunur; schema5 pure-PWA account guard summary-only, unknown/tombstone/deletion gates zero-write.0009 additive migration yerel; eski record-aware pull/push authority korunur.

17 dosyalık map ve wire/budget/retry/rollback ayrıntısı `docs/BUILD_44_RECORD_TRANSPORT_HANDOFF.md`. Gerçek SQLite direct-seed70,006records /10,315,126bytes exact paging+assembly; middle edit10queries/16payloadrows/0ordinary rerank; huge raw keys/unsafe64locator, prefix replay/skip/forgery, concurrency/response-loss/TTL/order/rollback/composite/PWA/escaped receipt budget fixtures PASS. Storage5+transport5 critical mutants PASS, FK on/off deletion PASS, fullnpm EXIT0 (yalnız local8090 test izni), syntax/diff PASS. Logs `/private/tmp/reptrio-b44-phase2a-focus.log`, `/private/tmp/reptrio-b44-phase2a-full.log`. Backend test:change-guardian NOT_AVAILABLE; fresh independent FULL HIGH Guardian PENDING, commit/push yok.

Tüm B44-08/B44-10 PARTIAL; B initial >4MB publisher/personal restore/journal/undo/ZIP/native runtime pending. Production D1/deploy/iOS build/TestFlight/gerçek kullanıcı silme yapılmadı. `RECORD_TRANSPORT_ENABLED=false` rollback yalnız yeni routes/flags kapatır; record accounts eski user_data writer'a döndürülemez.


### 2026-10-09 — Phase2A FULL Guardian P2 düzeltmesi

Önceki frozen A FULL HIGH Guardian **DURDURULDU**: touched prefetch byte tahmini parent_key tekrarını ve JSON escaping/list envelope'u kapsamıyordu; legal3005B ID+1000set gerçek6.3MB payload döndürüyordu. Exact read-only Planner amendment sonrası aynı17map içinde explicit11field projection + JSON1 UTF8 sizing + sayısal sentinel/list envelope ve aynıSQLsnapshot rev/token/ACTIVE/user/count/byte gates uygulandı. Büyük touched payload DB'den çıkmadan SYNC_ROOT_LIMIT, stale owner SYNC_CONFLICT; no batch/write/receipt/data change.

Corrected focus PASS:6,341,042B ve6,331,032B projected old rows için0payloadRows/0batch; escaped legalnear3,789,338B returned==SQLbound, rawidentity/order/content/retry exact; büyüyen writer race0payload. Large edit artık9queries/16payloadrows/0normalrerank; schema/order/receipts/rollback/budget/mutants korunur. Corrected full log `/private/tmp/reptrio-b44-phase2a-p2-full.log`, focus `/private/tmp/reptrio-b44-phase2a-p2-focus.log`. Fresh FULL HIGH Guardian **PENDING**; önceki DURDURULDU kendiliğinden geçerli sayılmaz. AIMPLEMENTED_LOCAL, tümB44PARTIAL/Bpublisher+restore+nativePENDING; commit/push/deploy/migration/build/gerçekverisilme yok.

Corrected P2 final verification: focus PASS, full `npm test` EXIT0 (`/private/tmp/reptrio-b44-phase2a-p2-full.log`, local8090 fixture permission only), syntax/diff PASS. Fresh independent FULL HIGH Guardian PENDING; no commit/push/production actions.


### 2026-10-09 — Corrected Phase2A fresh FULL HIGH kabulü

Tam bağımsız Guardian **GEÇTİ**, frozen17 manifest `0a94e9dfe0270517f94943c54972aa6031238b0096d1d4f8f18de1230c1f0561`. Önceki DURDURULDU tarihsel kaydı korunur; P2 boyut açığı düzeltilmiş sürümün tamamı yeniden incelendi. Independent full npm EXIT0 `/private/tmp/reptrio-b44-guardian-phase2a-p2-full.log`, focus ve tüm adversarial kontroller PASS. Kendi normal eski producer23.009B örneği artık413/zero payload/batch/writes; bağımsız escaped near-limit transfer3.792.306B SQLbound ile aynı. Same-fetch revision/token/blocked/deleted races zero payload. 70.006 kayıt exact paging, signed64/cursor completeness, sequential order oracle, CAS/receipt races/rollback, schema5/unknown/tombstone/cleanup ve toplam10 mutant PASS. Syntax8/diff PASS; mechanical NOT_AVAILABLE.

Parent sonrasında yalnız bu kabul kayıtlarını ekledi; denetlenen runtime kaynakları değişmedi. Bu backend dilimi commit/push için kabul edildi; tüm B44-08/B44-10 hâlâ PARTIAL. Sonraki staged publisher + personal restore/journal/undo, ardından native entegrasyon. Production migration/deploy, native build/TestFlight/veri silme yetkisi verilmedi veya uygulanmadı.
