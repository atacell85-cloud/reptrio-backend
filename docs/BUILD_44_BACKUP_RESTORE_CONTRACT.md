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
