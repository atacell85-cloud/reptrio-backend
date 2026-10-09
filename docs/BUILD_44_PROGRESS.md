# Build 44 backend ilerleme — 2026-10-09

B44-08 ZIP JSON+CSV ve B44-10 güvenli kişisel yedek restore son onaylı kapsamı kaydedildi; `BUILD_44_BACKUP_RESTORE_CONTRACT.md` mobil kontratla eşleşir. Runtime/schema NOT_STARTED, tests NOT_RUN, Guardian PENDING; deploy/migration/veri silme yapılmadı. B45-01 source-specific external workout transfer ayrı sonraki sürüm PLAN_ONLY. Sonraki: mevcut sync transaction/identity/account-status kaynak incelemesi, önemli schema kararı için kullanıcı onayı ve küçük feature branch'te odak testleri.

Başlangıç `npm test` PASS, yerel test server/fixture'lar; production verisi veya servis değişmedi. Mevcut sync SELECT+koşulsuz UPSERT ve PWA eksik snapshot yazımı restore için güvenli transaction kanıtı değildir. A (iki hesap-scoped işlem/kimlik journal tablosu + revision/capability guard) / B (entity storage/sync) seçimi kullanıcı onayı bekler: mobile `docs/tasks/BUILD_44_RESTORE_ARCHITECTURE_DECISION.md`. Runtime/migration/deploy başlamadı.

## 2026-10-08 — Mimari B onaylandı; geliştirme devam ediyor

Kayıt bazlı depolama/sync, kullanıcı “tamam devam et” mesajıyla onaylandı. Önceki USER_APPROVAL_PENDING mimari A/B kayıtları bu son kararla geçersizdir. İlk backend dilimi Planner source/impact-map incelemesinde; migration/deploy yapılmadı. Önce record storage + atomic version/account guard ve legacy uyumluluk, sonra export/restore staging/preview/confirmation/journal/undo/sync/stats dilimleri. Pure inspector PR17 önceki bağımsız temel dilimdir, full ZIP restore henüz tamamlanmadı.

## 2026-10-09 — İlk kayıt depolama dilimi kabul edildi

`feat/build44-record-storage@a25046df171c30dd70bc790db82ae764cb49bda6` commit/push tamamlandı; taslak PR4 https://github.com/atacell85-cloud/reptrio-backend/pull/4 (base build44/planning, merge edilmedi). Additive migration0008 yalnız dosya/yerel fixture kapsamındadır. Tek record authority, atomik revision/token CAS, durable tombstones, legacy read ve kayıp korumalı eski API uyumluluğu uygulanmıştır.

Taze tam bağımsız HIGH Guardian GEÇTİ. Full npm test EXIT0, gerçek SQLite yarış/rollback/bütçe kontrolleri, beş kritik mutant, PWA null retry 1→2→3, phone/Watch undo ve account deletion FK on/off/external cleanup öncesi schema gates PASS. Mechanical test:change-guardian backend'de NOT_AVAILABLE.

Sonraki küçük dal `feat/build44-record-transport`, acceptedbase a25046d: paged raw record reads, bounded complete-root mutations, signed cursors/order ve retry receipts. Planner yedi bölüm etki haritası verdi; implementasyon başladı, kabul henüz yok. Ardından staged normal publisher ve personal restore/journal/undo; sonrasında native akış/local hydration/stats. Tam B44-08/B44-10 PARTIAL.

Production migration/deploy, iOS build/TestFlight veya gerçek kullanıcı verisi silme yapılmadı. Record-aware emergency rollback artifact yayın kapısı olarak açık kalır. B45 external adapters PLAN_ONLY.
