# Build 44 backend ilerleme — 2026-10-08

B44-08 ZIP JSON+CSV ve B44-10 güvenli kişisel yedek restore son onaylı kapsamı kaydedildi; `BUILD_44_BACKUP_RESTORE_CONTRACT.md` mobil kontratla eşleşir. Runtime/schema NOT_STARTED, tests NOT_RUN, Guardian PENDING; deploy/migration/veri silme yapılmadı. B45-01 source-specific external workout transfer ayrı sonraki sürüm PLAN_ONLY. Sonraki: mevcut sync transaction/identity/account-status kaynak incelemesi, önemli schema kararı için kullanıcı onayı ve küçük feature branch'te odak testleri.

Başlangıç `npm test` PASS, yerel test server/fixture'lar; production verisi veya servis değişmedi. Mevcut sync SELECT+koşulsuz UPSERT ve PWA eksik snapshot yazımı restore için güvenli transaction kanıtı değildir. A (iki hesap-scoped işlem/kimlik journal tablosu + revision/capability guard) / B (entity storage/sync) seçimi kullanıcı onayı bekler: mobile `docs/tasks/BUILD_44_RESTORE_ARCHITECTURE_DECISION.md`. Runtime/migration/deploy başlamadı.

## 2026-10-08 — Mimari B onaylandı; geliştirme devam ediyor

Kayıt bazlı depolama/sync, kullanıcı “tamam devam et” mesajıyla onaylandı. Önceki USER_APPROVAL_PENDING mimari A/B kayıtları bu son kararla geçersizdir. İlk backend dilimi Planner source/impact-map incelemesinde; migration/deploy yapılmadı. Önce record storage + atomic version/account guard ve legacy uyumluluk, sonra export/restore staging/preview/confirmation/journal/undo/sync/stats dilimleri. Pure inspector PR17 önceki bağımsız temel dilimdir, full ZIP restore henüz tamamlanmadı.
