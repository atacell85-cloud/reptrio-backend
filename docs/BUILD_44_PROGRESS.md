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

## 2026-10-09 — İlk kayıt depolama dilimi kabul edildi

`feat/build44-record-storage@a25046df171c30dd70bc790db82ae764cb49bda6` commit/push tamamlandı; taslak PR4 https://github.com/atacell85-cloud/reptrio-backend/pull/4 (base build44/planning, merge edilmedi). Additive migration0008 yalnız dosya/yerel fixture kapsamındadır. Tek record authority, atomik revision/token CAS, durable tombstones, legacy read ve kayıp korumalı eski API uyumluluğu uygulanmıştır.

Taze tam bağımsız HIGH Guardian GEÇTİ. Full npm test EXIT0, gerçek SQLite yarış/rollback/bütçe kontrolleri, beş kritik mutant, PWA null retry 1→2→3, phone/Watch undo ve account deletion FK on/off/external cleanup öncesi schema gates PASS. Mechanical test:change-guardian backend'de NOT_AVAILABLE.

Sonraki küçük dal `feat/build44-record-transport`, acceptedbase a25046d: paged raw record reads, bounded complete-root mutations, signed cursors/order ve retry receipts. Planner yedi bölüm etki haritası verdi; implementasyon başladı, kabul henüz yok. Ardından staged normal publisher ve personal restore/journal/undo; sonrasında native akış/local hydration/stats. Tam B44-08/B44-10 PARTIAL.

Production migration/deploy, iOS build/TestFlight veya gerçek kullanıcı verisi silme yapılmadı. Record-aware emergency rollback artifact yayın kapısı olarak açık kalır. B45 external adapters PLAN_ONLY.


### 2026-10-09 — Phase 2B personal restore local implementation, acceptance pending

Approved B, accepted A base `efe0dcf5a386d9b2e4c00ab3d836dffdd892f847`, branch `feat/build44-personal-restore`: additive0010 staging/journal, authenticated projected RESTORE and separate RAW staged SYNC, generation/revision/ACTIVE bounds, explicit preview/confirmation, one-batch CAS publication, durable receipt/retry/dedup, full ALL undo with exact ownership and versioned incoming/RAW opaque baseline proofs, path/item-only metadata removal, TTL/cancel/cleanup and fail-closed partial-schema deletion implemented locally. Portable V1 machine block/cf6acfa golden bytes remain unchanged; raw keys/order/-0 preserved. Exact21file map and runtime/rollback evidence: `docs/BUILD_44_PERSONAL_RESTORE_HANDOFF.md`.

Small routed personal tests and four meaningful proof mutants pass; storage5 mutants and account deletion FK on/off/partial personal schema tests pass. Broad full npm EXIT0 / real5,101sessions+66,313sets PASS before the final narrow unit/empty-selection guards; latest24 routed small groups +six B semantic mutants PASS after those guards. Fresh independent FULL HIGH Guardian PENDING. Latest source-backed Planner amendment closes the provenance9→RAW staged SYNC gate: distinct frozen-V1 RAW9 mode, strict stagedmarker/declaration equality, preserved9/unknown/null/absent/-0/order and zero-write legacy/delta5/8 downgrade guards; no broader operational omission privilege or8 stamp. Actual golden cross-flow and negative/retained5/8 controls pass. UNACCEPTED/no freeze/commit/push. SQLite timings are not D1/native evidence. Entire B44 backup/native/statistics refresh user flow remains PARTIAL. No production D1/deploy/build/TestFlight/real user data deletion, no mobile/Watch/synced-reference edits.

Final narrow Planner alignment: every session without own explicit unit requires SAME or selected safe NEW captured legacy context, even empty or explicit-unit-child sessions. Strict portable array/absent sets/null-unit rejection remains. Zero eligible projected records returns409 `RESTORE_EMPTY_SELECTION` before ordinal allocation/publication, preserving READY/no receipt/account/journal change; all-SAME duplicate receipts remain valid and unrelated eligible metadata may commit while blocked sessions/children never publish. Six-context × four valid session-shape outcomes plus invalid portable shapes, immediate RAW-preserving ALL undo and two additional unsafe-authorization mutants PASS. Latest focus `/private/tmp/reptrio-b44-final-unit-alignment.log`; broad `/private/tmp/reptrio-b44-final-full.log` ran before this exact isolated guard delta. Large fixtures all have own kg unit and nonempty selected counts; unchanged large publication paths are not needlessly rerun. Source/test/doc freeze21 then fresh FULL HIGH required; no acceptance/commit/push/build claimed.


## Independent FULL HIGH P1 correction — pending fresh review

The prior frozen candidate received **DURDURULDU**: complete personal-restore tables combined with missing `sync_mutation_receipts` passed cleanup readiness, then account deletion performed an external cleanup before a missing-table database failure. The existing deletion fixture reproduced routed500 `ACCOUNT_DELETE_FAILED` before correction (`/private/tmp/reptrio-b44-p1-before-fix.log`).

`storageCleanupMode` now requires both record storage and mutation receipts to be ready whenever personal-restore storage is ready, before any external effect. The existing FK-on/off deletion matrix adds this exact mixed-schema case and passes routed503 `SYNC_STORAGE_SCHEMA_UNSUPPORTED`, zero database writes, unchanged complete account data, zero Apple revocations and zero OpenAI response deletes (`/private/tmp/reptrio-b44-p1-corrected-deletion.log`, EXIT0). Supported predecessor schemas without personal tables remain covered. Syntax and diff checks pass. This narrow cleanup-readiness delta follows the previously recorded broad and focused evidence; no unrelated broad tests were repeated. The corrected exact21 candidate is **pending fresh independent FULL HIGH**, with no commit, push, deployment or acceptance.


## 2026-10-09 — Corrected backend personal restore accepted

Fresh independent FULL HIGH Guardian: **GEÇTİ**, corrected 21-file freeze SHA256 `34f9721efb86a328f4d1ad46d849fd9fe49a025f8e9119513d5b86cf7acda567` on base `efe0dcf5a386d9b2e4c00ab3d836dffdd892f847`. Parent verified all frozen hashes before this documentation-only acceptance append. Prior DURDURULDU remains historical; combined personal-ready/missing-receipts P1 is closed. Independent routed SQLite: 503 SYNC_STORAGE_SCHEMA_UNSUPPORTED, zero external effects/DB writes, account retained; FK on/off supported and partial schema deletion checks PASS.

Evidence: corrected deletion suite and independent lifetime receipt/ALL undo/UNDONE replay/cross-account controls PASS. Existing 24 focus groups/six safety mutants and full 5,101 sessions/66,313 sets evidence assessed proportionately; broad run predates final unit/empty guards, later focus covers them. Mechanical backend Guardian NOT_AVAILABLE. No runtime changes after reviewed freeze. Commit/push permitted for this backend scope only.

Build44 overall **PARTIAL**: native operation boundary, account-scoped pending reconciliation, Watch ownership/custody approval and implementation, ZIP UI/restore application/statistics integration and cross-device end-to-end verification remain. No production migration/deploy, iOS build/TestFlight or real user deletion performed or authorized. B45 external imports PLAN_ONLY.
