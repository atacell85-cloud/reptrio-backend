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

## 2026-10-12 — B44-06 server onboarding eligibility local slice

Approved additive auth contract: `users.onboarding_eligible INTEGER NOT NULL DEFAULT 0`; genuine new email or provider account INSERT sets 1 only when the column exists. Existing account login/provider linking never promotes eligibility. Public sessions and authenticated `/api/me` return server-read `onboardingEligible`; private `currentUser` and all record sync/transport/personal restore queries are unchanged. Eligibility is not completion or persisted progress.

Auth-local uncached `PRAGMA table_info(users)` retains old-schema auth with false eligibility and detects later migration on the same binding; unrelated database failures propagate. Migration 0011 is a new local file only. Accounts created before its application remain false with no backfill. Rollback: revert backend code to `1599f49a2e83f965c2d46951a7629d8cf9d267a3` while retaining the unused additive column; no destructive downmigration.

Local implementation pending independent HIGH review; no commit/push, production D1 migration/deploy, build, mobile/Watch or real user data writes. Entire Build 44 remains PARTIAL. Exact ten-file map, test evidence and frozen hashes are in workspace `task-notes/B44_ELIGIBILITY_IMPLEMENTATION.md` and `B44_ELIGIBILITY_FREEZE.json`.

Verification: focused onboarding eligibility and full npm suite EXIT 0, including unchanged default 5,101-session / 66,313-set scale, existing OAuth/reset/deletion and storage/transport/personal restore regressions. Local logs `/private/tmp/b44-eligibility-focus.log` and `/private/tmp/b44-eligibility-full.log`; independent HIGH review remains pending.


## 2026-10-12 — B44-06 eligibility independently accepted

Independent HIGH Guardian GEÇTİ on exact ten-file freeze based on `1599f49a2e83f965c2d46951a7629d8cf9d267a3`; parent verified all hashes before this documentation-only append. Real routed SQLite scenarios and six isolated meaningful runtime mutations passed/caught; public web cookie and wrong-account controls, forged Google signature, wrong Apple nonce, strict flag value and capability failure guards checked independently. Focus and full npm EXIT0, unchanged 5,101 sessions/66,313 sets and complete ALL undo; unrelated full tests were not repeated by Guardian. Private currentUser and record storage/transport/restore remain unchanged. Backend mechanical Guardian unavailable, not claimed.

Accepted only server onboarding eligibility contract. Eight-question native onboarding and complete Build44 remain pending. Migration0011 exists as a file only; no production migration/deploy, build or real account changes. Accounts created before rollout remain false; no inferred backfill. Commit/push permitted for this scope. Evidence retained in project task-notes/B44_ELIGIBILITY_IMPLEMENTATION.md, B44_ELIGIBILITY_FREEZE.json and B44_ELIGIBILITY_GUARDIAN.md.


## 2026-10-12 — S2a versioned profile portability (HIGH; implementation/local review pending)

Pinned mobile base 4d03b76961b380b8db57b10892e2b9dc0560359b, backend d9784fee3bd6aa477681ce85167bac5c73521bd9. Additive strict V2 profile answers/indivisible progress/owned initial-measurement pointer through existing codecs and RESTORE protocol column. V1 bytes/rules/seeds/default/SYNC unchanged; original-byte integrity, separate staging provenance, closed versions, capability proof and bounded dependency/incoming-reference/opaque proofs retained. Existing profile values never overwritten. No new writer/migration/route or AppData schema change; auth/eligibility/Watch/transport unchanged.

Focused mobile codec and seven real SQLite routed V2 groups PASS. Full mobile mechanical (typecheck/UI/record-pages/mandatory direct V2/existing regressions), V1 archive37 groups with exact2b8111 golden, V1 validation16 groups, backend full npm (31 restore groups, unchanged5,101 sessions/66,313 sets complete ALLundo and eligibility) EXIT0; exact freeze recorded in project task-notes/B44_PROFILE_BACKUP_V2_IMPLEMENTATION.md. Independent full joint HIGH Guardian PENDING; no commit/push. Native onboarding questionnaire and B44-08/10 export/restore file/UI remain OPEN/PARTIAL, not completed by contract tests. Native/device evidence, builds, deployment, remote migrations and real user data changes NOT_STARTED. Rollback retains operation protocols; complete/cancel outstanding V2 operations before older backend code.


## 2026-10-12 — S2a versioned profile backup accepted

Independent FULL HIGH Guardian: mobile GEÇTİ, backend GEÇTİ, joint conformance GEÇTİ. Exact15mobile/11backend source freeze890f1d4796d09a7c536cfb71e3a501ce63da21c81e148d958b49d8013f83fd20 verified by parent before documentation-only acceptance append. Existing full mechanical/typecheck/UI and full npm evidence verified; independent actual codec and routed SQLite V2 groups passed, seven critical behavior mutations caught, opaque/owned-edit/stale-confirmation undo rejects zero effects. Runtime/test/fixture bytes unchanged after review.

V1 language/helpers/golden2b8111... unchanged. Explicit V2 carries six optional profile answers and indivisible owned onboarding progress, uses existing RESTORE protocol column, preserves V1/SYNC and bounded atomic receipt/retry/undo. Actual mobile-produced golden daf76aad685238ddf38ad34c199660fc09615f83047bd4d2373e3bb7a226ca3b agrees across repositories. No new migration/writer/data authority. Rollback must complete/cancel protocol2 operations before old backend processes them.

Accepted contract only: native onboarding and B44-08/10 screens remain OPEN/PARTIAL; entire Build44 not build-ready. Evidence project task-notes/B44_PROFILE_BACKUP_V2_IMPLEMENTATION.md, B44_PROFILE_BACKUP_V2_FREEZE.json and B44_PROFILE_BACKUP_V2_GUARDIAN.md. No production migration/deploy/TestFlight, physical build/install or real-account writes. Commit/push allowed exact reviewed scope.

### 2026-10-13 — B44-07 backend authorization implementation candidate

- User-selected AI consent now has a server-only, independent default-OFF grant/revoke state `ai_import_openai_document_v1`, plus audit log without document body or secrets. A user must expressly opt in at signup/welcome or later settings; no inferred OAuth consent, no blanket processing approval. Existing sign-up/login never auto-grants.
- Routes proposed/implemented: authenticated `GET /api/privacy/ai-import`, authenticated `POST /api/privacy/ai-import/consent` with strict `{action:'grant'|'revoke',policyVersion}` body, origin/CSRF gate. Unknown/stale state, missing migration and other account IDs deny import; revoke updates queued/processing jobs in same SQL batch.
- Original anonymous `/api/import/parse` intentionally becomes authenticated + consent gated. Create/retry/background/queue includes just-in-time server guard; job ownership uses `(user_id,id)`, not ambiguous `id` alone; old unauthenticated queue messages are safely ignored. Regrant alone does not resume previously revoked/failed jobs.
- Additive D1 migration **0012** (after 0011), no direct D1 changes. Account deletion cleanup handles both consent tables even with FK off, partial migration fails before Apple revoke. Stored OpenAI response deletion / revocation of already-sent content is not guaranteed by consent withdrawal, and requires privacy review.
- Implementation stored in `feat/build44-ai-consent-backend`, **NOT TESTED/RELEASED**; full npm tests, HIGH Guardian and app integration pending. Production migration/deploy prohibited without separate explicit instruction.

## 2026-10-13 — B44-04 lifecycle isolated implementation

Risk **HIGH**: auth, persistence closure, reversible30-day recovery and permanent cleanup. Exact previously approved choice implemented backend-first on `feat/b44-04-account-lifecycle`, union `d6419a8` (PR10+PR11 preserved). Default verified confirmation schedules30UTC days; optional immediate permanent deletion; email10minute one-time link and fresh exact-linked-provider authorization; no password deletion field and no receipt/fence. New users have explicit credential provenance, existing UNKNOWN stays unknown; no timestamp/email-verification backfill.

Pending has only scoped lifecycle ownership/status/recover/purge authorization, all normal sessions and late normal SQL/AI access close, data identity/bytes survive recovery. Recovery is explicit and deadline CAS protected; permanent success requires complete DB/upstream cleanup. Approved Planner AI amendment adds execution-only leases and safe UNKNOWN crash handling; timeout never proves remote cleanup. Provider ceremony proves new exact-linked authorization, not guaranteed password re-entry. Contract: `docs/BUILD_44_ACCOUNT_RETENTION_CONTRACT.md`.

Production migration/deploy/data deletion/build/TestFlight unauthorized. Whole-B44 independent HIGH Guardian/device validation deferred by explicit user; no acceptance PASS claimed. Verification evidence is recorded in BUILD_CURRENT/PROGRESS after final local run.

### Final B44-04 backend evidence — 2026-10-13

Runtime/focused tests stable: lifecycle, populated-table deletion FK ON/OFF, OAuth timestamp/provenance/omitted-email, reset compatibility, AI execution race/crash, Worker, onboarding, record storage/transport and personal restore33 checks PASS. Large5,101sessions/66,313sets RAW publisher/RESTORE/fullALLundo and existing16 critical mutants PASS. Apple submission preflight is ready-config/decryptable material, zero-write/no-revoke and exact encrypted-material CAS-bound; later Apple outages use acquired PURGING retry/overdue state. Ordinary migrated UNKNOWN/no-provider password reset stays supported; successful reset records PASSWORD, provider-origin/ambiguous UNKNOWN-linked remains protected without timestamp inference. Scoped status exposes bound identity/providers/Apple-reauth/purge error only.

Syntax/diff PASS. Complete npm local run blocked at headless smoke Chrome CDP startup after sandbox-listener escalation; no false full PASS. Parent-added tests-only `.github/workflows/build44-account-lifecycle.yml` provides complete Node22 npm verification, REMOTE_CI_PENDING before sequential mobile implementation. This is not deployment/build. Whole-B44 HIGH Guardian and physical checks remain user-deferred; no commit/push by implementation agent, production migration/deploy/build/TestFlight/data deletion untouched.
