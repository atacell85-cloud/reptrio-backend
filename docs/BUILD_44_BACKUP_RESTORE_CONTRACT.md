# Build 44 — B44-08 / B44-10 kişisel yedek sözleşmesi

**2026-10-08 — PRODUCT_APPROVED / NOT_IMPLEMENTED.** Son kullanıcı isteği yetkilidir. B44-08 ZIP JSON+CSV dışa aktarma; YENİ B44-10 `REPTRIO-Verilerim.zip` güvenli içe aktarma/geri yükleme. Bu belge runtime, deploy veya migration gerçekleştiği anlamına gelmez.

## Veri ve dosya sınırı

- Sessions, sets, programs, body measurements ve structured metadata; mevcut custom/legacy exercise identity, kayıt bağlantıları, kg/lb snapshot, kaynak timestamps/timezone ve istatistik dışı/tamamlanmamış kayıt semantiği korunur. Export/import aynı versiyonlu round-trip fixture sözleşmesini kullanır.
- Manifest: schema version, dosya listesi, her dosyanın checksum ve byte/count bilgisi, export zamanı, local/cloud kapsamı ve snapshot tutarlılık bilgisi. JSON authoritative round-trip veri, CSV aynı snapshot'ın taşınabilir görünümüdür; iki temsil iki kez veri eklemez. V1 alan adları ve checksum canonical byte encoding uygulama Planner'ında kesinleştirilir.
- Allowlist yalnız kişisel antrenman verisini taşır. Auth/session/refresh/access token, parola/hash, OAuth provider binding/sub, API key, credential, signed URL veya cihaz kimlik doğrulama kayıtları dışa aktarılmaz ve içe alma ile hesaba eklenmez. Tanınmayan structured metadata güvenli/versiyonlu şema doğrulanmadan AppData'ya geçirilmez. Secret temizliği checksum doğrulamasından sonra ve domain validation'dan önce güvenli projection ile yapılır; loglara ham payload yazılmaz.
- Export önce tutarlı sync snapshot kanıtı ister; offline export açıkça yalnız bu cihazdaki veriler olarak etiketlenir. Mevcut cloud completeness kuralı korunur. Auth kimliği hiçbir zaman arşivden alınmaz.

## Kullanıcı akışı ve atomiklik

1. Ayarlar > Veri ve gizlilik > Yedeğimi içe aktar; sistem dosya seçici. Dosya seçimi ağ yükleme, veri yazımı, AI analizi veya geri yükleme onayı sayılmaz.
2. Staging'de doğrula: desteklenen schema/manifest, required entries, dosya/count uyumu ve checksums; sıkıştırılmış/açılmış payload boyutu, entry count, compression ratio, path traversal/absolute path/symlink, encrypted/nested/duplicate-entry ZIP ve zip bomb sınırları. Açılmadan önce ve streaming decode sırasında hard cap uygulanır. Sayısal sınırlar/library seçimi Planner kanıtıyla kilitlenmeden ZIP decode shipping yok.
3. Malicious CSV/formula, quoting, UTF-8/BOM ve JSON domain/reference validation. CSV hiçbir zaman executable/evaluated içerik değildir. Formula-safe CSV gösterimi JSON'daki gerçek metni bozmaz; unsupported/ambiguous input fail-closed, kısmi sessiz import yok. Checksum bozukluğu ile credential stripping birbirini bypass edemez. Checksum bütünlük kontrolüdür, gönderici kimliği kanıtı değildir.
4. Kayıt sayısı ve çakışma önizlemesi: her entity için yeni, mevcut/aynı (skip), çakışan, reddedilen; custom/legacy eşleşmeler, birim/zaman ve provenance görünür. Sessiz overwrite veya isimden hareket birleştirme yok. Çakışmanın kesin politikası onaylı değilse commit edilmez; kullanıcı düzeltir/skip eder/iptal eder.
5. Kullanıcı önizlemeyi açıkça onaylar. Aynı kullanıcı, hedef data revision ve preview digest tekrar doğrulanır; hesap değişimi, sync/yerel değişiklik veya süre dolumu preview'ı geçersiz kılar ve yeniden gösterir. Aktif antrenmanla yarışan restore, Planner güvenli sınır doğrulamadan uygulanmaz.
6. Tam staging + atomik, geri alınabilir/veri kaybettirmeyen merge. Var olan kayıtlar otomatik overwrite/silinmez, program references yetim bırakılmaz, workout/set duplicate oluşmaz. Hata, iptal veya process crash yarım merge üretmez. Undo yalnız bu import'un değişikliklerini geri alır; daha sonra yapılan kullanıcı/diğer cihaz değişikliklerini snapshot overwrite ile silmez. Tombstone'lar ve eski backup resurrection politikası mevcut sync ile açıkça çözülür.
7. Stable domain identity + import provenance üzerinden idempotency; aynı arşivi tekrar ve başka cihazdan içe alma ikinci workout/set üretmez. Yerel ve server sync yarışları eklenen veriyi kaybetmez. Client-only random IDs yeterli kanıt değildir. Account-scoped import mapping/ledger veya alternatif sync transaction tasarımı önemli backend şema kararı ise kullanıcı onayı uygulamadan önce alınır.
8. Commit başarıyla doğrulanınca history/program/measurement ve statistics index/cache güncellenir; mevcut PR/e1RM math ve timezone day grouping korunur. Başarı ancak gerçek tamamlanma sonrası gösterilir.

## Silinmiş hesap ve 30 gün kurtarma sınırı

- 30 gün sunucu recovery mevcut hesabın ayrı doğrulamalı kurtarılmasıdır. B44-10 kullanıcının kendi kişisel yedeğini **yeni, doğrulanmış ACTIVE hesaba** taşımasıdır; eski hesabı, provider binding veya auth yetkisini canlandırmaz.
- `PENDING_DELETION`, `PURGING`, `DELETED` hedefte import/sync yazımı reddedilir. Eski backup owner ID hedef hesabı seçemez. Eski hesabın purge/retention süresi değiştirilmez. Kalıcı silme sonrası sunucudan recovery vaadi yok; dosya kullanıcıda mevcut olmalıdır.
- Export silme için zorunlu değildir. Yeni signup başlangıçta boş kalır; yalnız ayrı dosya seçimi/preview/onay sonrası kişisel veri eklenir. Eski credentials veya tombstone/owner scope yeni hesaba körlemesine taşınmaz.

## Kodlanabilir dilimler

| Dilim | Çıktı | Ön koşul / bitiş kanıtı |
|---|---|---|
| S4a | Ortak versioned backup domain schema, allowlist ve pure doğrulama | Planner exact impact map, hostile/legacy fixtures, HIGH Guardian |
| S4b | Tutarlı snapshot, JSON+CSV serialize ve ZIP/share | byte/checksum sözleşmesi, library/limit review, full round-trip parity |
| S8a | Sistem dosya seçici ve bounded ZIP validation/staging | S4a/b, fail-closed hostile archive tests; data write yok |
| S8b | Domain conflict/count preview | read-only existing data, stable identity/tombstone policy; cancel = zero writes |
| S8c | Atomik merge/undo/idempotency/sync | mevcut local/server invariant kanıtı; önemli yeni schema/mimari seçim varsa kullanıcı onayı |
| S8d | Stats refresh ve restore E2E | retry/crash/multi-device/account-switch tests ve bağımsız HIGH Guardian |

Her runtime commit `BUILD_CURRENT.md` + `DECISIONS.md` günceller. Mevcut rollout/build yetkisi yoktur. İmplementasyon kanıtı olmadan hiçbir dilim DONE/PASS değildir.

## Build 45 sınırı

B45-01 Hevy/Strong ve başka workout uygulamalarının CSV/export transferi yalnız sonraki sürüm. Source-specific adapter, identity reconciliation, unmatched custom moves, preview/correction, provenance ve fixture setleri ayrı kontrat ister. B44 içinde haricî import implement etme; mevcut AI program import'u farklı özelliktir ve parser semantiği korunur.

## 2026-10-08 — Onaylı backend mimarisi B

Kullanıcı kayıt bazlı kalıcı depolama/sync yoluna devam etmeyi onayladı. Tek all-account JSON satırının D1 boyut sınırı kaldırılacak; tek kayıt/platform bütçeleri yine bounded kalacak. Revision check + domain writes + operation journal atomik; legacy fallback/capability koruması veri kaybına yol açamaz. Bu onay yalnız implementation/schema dosyaları/production dışı test içindir; production migration/deploy/build/veri silme yetkisi değildir.


## 2026-10-12 — Separate portable profile V2 contract (S2a; HIGH review pending)

V1 language/machine block/golden bytes remain frozen: SHA-256 `2b8111f64393c6691817e045891aac7bdb2a8493350e8d111daad1763853e094`. V1 entry points remain strict V1. `createVersionedPersonalBackup(input,context,sha256,version)`, `stageVersionedPersonalBackup(bytes,sha256,expectedVersion?)`, and `previewVersionedPersonalBackup` support exactly 1/2 with distinct staging provenance. Both manifest/envelope schemaVersion must match; original entry hashes precede projection; downgrade/unknown versions fail. Same format, six entries, filename, canonical encoding, budgets, CSV/order/parity. dataSchemaVersion still labels source AppData.

Profile V2 retains displayName/avatarDataUrl and adds absent/nullable goal (muscle_gain/fat_loss/strength/general_fitness), experience (beginner/intermediate/advanced), weeklyDays (integer 1–7), gender (female/male/undisclosed), heightCm (positive finite), birthYear (positive integer). No defaults or profile.weightKg. Optional indivisible onboarding requires version 1, integer step 0–8, startedAt timestamp, completedAt nullable timestamp, initialWeight null or exact {id,recordedAt,weightKg}. Steps 0–7 require null completion; step 8 requires timestamp. Initial id is exactly `reptrio:onboarding:initial-weight:v1` and kg positive finite. Unknown fields still reject; recognized credentials follow V1 projection redaction and backend strict rejection. Missing historical measurement warns and retains pointer without regeneration. Portable dictionaries and the actual mobile-produced archive/roots are identical fixtures in both repos.

RESTORE start alone accepts optional backupSchemaVersion: omitted/1 persists protocol 1; explicit 2 persists protocol 2 in existing operation column. Unsupported inputs fail; SYNC rejects the field and stays protocol 1. Capabilities retains personalRestoreProtocol 1 and advertises personalBackupVersions [1,2] only for ready enabled restore, otherwise []. V2 consumers must call assertBackupCapability(2,capabilities.personalBackupVersions) before future start; no missing-capability downgrade. Later requests cannot change version. V1 seeds unchanged; V2 semantic/reversal seeds explicitly bind version. Chunk validation, dependency/history, opaque/reference proof use persisted protocol.

Existing metadata-leaf preview/commit/journal/ALLundo remain authoritative: onboarding is one leaf. Present empty/null/default values conflict rather than overwrite. Supplied excluded/conflicting/tombstoned initial measurement blocks dependent onboarding; SAME or selected NEW permits it. Truly missing history warns. Exact settings.profile.onboarding.initialWeight.id participates in incoming-reference proof so later unowned references prevent measurement reversal. All extensions use existing bounded queries, transactions, revision/CAS/receipt guards; no migration, writer, route, schema bump or record protocol change.

Validation: focused actual codecs and real routed SQLite RESTORE2 tests locally pass; full required gates and independent HIGH review are recorded in project task-notes/B44_PROFILE_BACKUP_V2_IMPLEMENTATION.md. Native export/restore UI, questionnaire, B44-08/10 completion, device validation, build and rollout remain outstanding. Rollback to pinned mobile 4d03b76961b380b8db57b10892e2b9dc0560359b/backend d9784fee3bd6aa477681ce85167bac5c73521bd9; complete/cancel protocol-2 operations before older backend code processes them. No production rollout authorized.
