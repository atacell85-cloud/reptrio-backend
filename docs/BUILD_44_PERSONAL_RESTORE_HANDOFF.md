# B44 Phase 2B personal restore and staged RAW publisher

2026-10-09. Approved architecture B; accepted transport base `efe0dcf5a386d9b2e4c00ab3d836dffdd892f847`, branch `feat/build44-personal-restore`. IMPLEMENTED_LOCAL / UNACCEPTED. Independent fresh FULL HIGH Guardian remains mandatory before commit/push. Production migration/deploy, native build/TestFlight and real user data deletion are not authorized or performed.

## Exact approved impact map: 21 files

Six new files:

1. `migrations/0010_personal_restore_operations.sql`
2. `worker/personal-restore-api.js`
3. `worker/personal-backup-contract.js`
4. `scripts/personal-restore-test.mjs`
5. `tests/fixtures/personal-backup-v1-golden.json`
6. `docs/BUILD_44_PERSONAL_RESTORE_HANDOFF.md`

Fifteen existing files:

1. `worker/record-sync-storage.js`
2. `worker/record-sync-transport.js`
3. `worker/account-api.js`
4. `worker/index.js`
5. `wrangler.jsonc`
6. `scripts/record-sync-storage-test.mjs`
7. `scripts/record-sync-transport-test.mjs`
8. `scripts/account-deletion-test.mjs`
9. `scripts/lib/d1-sqlite.mjs` (instrumentation only)
10. `scripts/maintenance/purge-soft-deleted-accounts.sql`
11. `package.json`
12. `DECISIONS.md`
13. `BUILD_CURRENT.md`
14. `docs/BUILD_44_PROGRESS.md`
15. `docs/BUILD_44_BACKEND_PLAN.md`

Direct routes: authenticated `/api/backup/restore/operations` and `/api/sync/records/operations`, with start, chunks, finalize, commit, receipt and cancel; RESTORE alone adds preview, undo-preview and undo. Capabilities, all existing writer/schema guards, account deletion and scheduled payload cleanup are adjacent consumers. Shared storage remains the only authority. Future native context/persistence/transport and history/program/measurement/statistics refresh consume confirmed receipts; backend fixtures are not evidence of implemented native flows.

Unaffected: OAuth/login/retention contracts, AI/video/catalog, PWA screen flows, statistics/unit/time/completion formulas, native UI/workout/Watch/Health/Live Activity, archive/file UI and B45 adapters. No mobile or synced `sources/` edits. Rollback is record-aware accepted A with `PERSONAL_RESTORE_ENABLED=false`; retain authoritative records and permanent terminal journals/receipts, never switch record accounts back to obsolete `user_data` authority or delete imported records as deployment rollback.

## Protocol and storage

Additive account-FK operations, root/record staging, chunk receipts and durable identity journal; two indexed target lookups bound large-account plans. Authentication selects target account; source namespace is provenance only. Only deliberate bounded projected-root requests are accepted, never raw ZIP or caller validation/auth claims. Start pins account base, purpose, local binding, schema provenance, expected counts/chunks and one-hour staging expiry. Server recomputes portable root/content/order digests; ZIP retry hash is caller identity, not certified archive checksum. Duplicate chunk index/content retries return stored result, changed content fails. Stage/progress generation/state/TTL and account revision/token/ACTIVE/not-deleted gates prevent publication drift.

RESTORE validator uses frozen `cf6acfa` portable V1 rules. Immutable machine-block canonical SHA256: `6d655e07cac5be9562464ed3678eae81445cd521d0bc2550480b959c3002ad88`; golden projected SHA256 `deb0754893601fb5c7996e2851688c20863f4d111fc120bf759ee89186ca2e8b`. Separate RAW serializer/hash preserves negative zero, object insertion order, group/storage order and malformed legacy evidence. V1 canonical bytes are unchanged. Optional raw IDs and typed tuple identity are preserved; no name/time/set-number dedup or regenerated IDs.

Final selected closure precedes the undo baseline: supplied conflicted/tombstoned/journal-blocked or excluded targets block dependent NEW roots/metadata; session/program children are indivisible. SAME targets are outside reversal set R. Truly absent historical links remain raw and produce compact server historical-reference warning count. Metadata adds only absent exact fields/profile paths/gym IDs/import IDs/legacy-unit pair; present null/empty/default are present. Hero preference stays local-only; no inference/conversion/unit stamping.

Normal staged SYNC uses distinct raw-root semantics and existing compatibility/known-shape/opaque-loss guards. Explicit included collections replace their complete roots atomically; omitted metadata remains. Tombstones cannot revive. Request-local limits are not account-total caps. Raw account values are never normalized through portable projection.

Commit and undo each publish one account-CAS/token/operation-owned D1 batch: state, records, journal and compact durable outcome, then erase stage payload copies. Zero CAS produces no writes/success; any injected SQL error rolls back the batch. Response-loss retry returns original receipt, no second publication. Identity journal remains ADDED/SAME_EXISTING then UNDONE for account lifetime and blocks stale replay across devices.

## Strict ALL undo proof

No subset undo. R comprises every validated unchanged ADDED root/path/item/owned marker. Ownership checks existence/tombstone, source/import hash, exact address/ordinal/added revision, plus metadata-path versioned RAW content and owned position witnesses. Only exact owned metadata leaves/items are virtually removed; surviving raw siblings, container presence, array order and -0 remain.

Version 2 operation-scoped deterministic reversal chain binds typed target tuple, logical owner, exact path/alias/raw value, duplicate occurrences/order and complete opaque-scope counts/hash. Child aliases missing/wrong program context remain coverage evidence rather than being silently dropped. Recognized fields with malformed objects/arrays/null become opaque evidence. Separate insertion-order RAW opaque hashing and raw-key/group/storage witnesses preserve uncertainty. Unchanged pre-existing dangling/opaque baselines are eligible; changed/new/incomplete/missing-version evidence blocks the entire undo with zero account/journal effects. Owned roots may reference one another and reverse together. New surviving root use of an owned collection marker prevents removal.

Bounded server progress: maximum eight pages of 256 rows per call (classification four), exact JSON1 projection envelope <=1,800,000 bytes, <=100 binds, <=100KB SQL, <=1,800,000-byte bound strings and <=50 queries including routed authentication/schema/progress/outcome. No whole-account SQL JSON aggregation or per-set publication query. Baseline/journal payload fetches check exact escaped bytes and pinned owner in the same SQL statement before transfer. Legacy baseline bootstrap has the same byte-first bound. Temporary expired payload cleanup is bounded; successful/cancelled stage copies erase immediately, terminal RESTORE evidence stays compact. Explicit account deletion includes all five tables with foreign keys both on and off; partial table/index/schema fails before external revoke/cleanup.

## Verification and outstanding gate

All 24 latest small routed SQLite groups pass existing golden/raw/hash/chunk/atomic/receipt/ALL tests plus target-A→B equal-count, owner/path/alias/duplicate/order/child-context mutations, malformed known scalar/null, RAW opaque/group order, mixed metadata siblings, owned metadata position/content, missing proof versions, source closure/conflict/child/tombstone/ledger/selection, auth/revoked/ACTIVE/deleted/schema/TTL/bootstrap bytes, continuation/selection/revision drift, concurrent confirmations, commit and undo SQL rollback and writer/BLOCKED/deletion CAS races. Six B semantic mutants expose target qualifier, RAW order, malformed scalar, child coverage, missing session unit-context and empty-selection authorization defects. Existing storage5 and transport5 mutants also pass. Actual scale labels reflect `B44_SCALE_SIZE`; small overrides are never full-scale evidence.

Logs: `/private/tmp/reptrio-b44-final-unit-alignment.log` (latest24groups, small2/26scale only), `/private/tmp/reptrio-b44-final-full.log` (broad full22personal groups and real5,101/66,313 before narrow final guards), `/private/tmp/reptrio-b44-final-record-sync.log`, `/private/tmp/reptrio-b44-final-account-deletion.log`. Storage five existing safety mutants pass. Broad full npm EXIT0 with real 5,101 sessions / 66,313 sets: SYNC publication2,322ms, RESTORE2,463ms and complete ALLundo1,992ms (local SQLite publication timings only). The broad run preceded the final isolated unit-context and empty-selection guards; latest24 routed small groups and six B mutants validate the exact final guard delta afterward. Large fixtures have own explicit kg units and nonempty selected counts, so their publication paths are unchanged. No D1/native performance claim.

The source-backed schema gate is repaired under the latest Planner amendment: new RESTORE provenance9 remains9; only staged RAW SYNC supports known5/8/9 with strict declared/raw marker equality. RAW9 uses separate frozen V1 structural deletion coverage and strict loss checks, preserving unknown/null/absent/-0/order without granting legacy draft/preview/retention omissions. Prior9 cannot downgrade through staged5/8, legacy push5/8 or A delta5/8; unsupported0/6/10 and mismatched markers fail before publication. The actual golden RESTORE→captureRAW9→stagedSYNC9 roundtrip, retry/tombstone/opaque/loss/deletion cases and retained5/8 controls pass. Broader provenance9 operational omission semantics require a separate source-backed amendment; no implicit migration or8 stamp.

Future native integration must use account/local/server/active-workout binding, serialized data writes and upload queue ownership. Dirty current local data cannot be overwritten by receipt/hydration; account switch/new local write invalidates pending apply. Local-only builder/draft/Health/notification/Watch reference evidence is a separate native integration dependency. Native flow/statistics refresh and full end-to-end user acceptance remain PARTIAL.

## Final narrow guard delta after broad tests

Every session lacking its own explicit unit needs verified compatible SAME/selected NEW captured legacy context. Empty sessions and explicit-unit children do not prove session provenance. Missing/incompatible/conflicted/excluded context blocks the whole session+children, without stamping/converting absent units. Strict portable empty-array/absent sets/null-unit failures are unchanged. A zero eligible projected-record count (excluding synthetic baseline/markers) fails409 `RESTORE_EMPTY_SELECTION` before ordinal allocation/publication; operation remains READY, with no account revision/receipt/journal changes. All-SAME dedup still succeeds. Unrelated eligible/SAME metadata can succeed while blocked session records/journal remain absent. Latest focus proves the context × valid-shape matrix, strict invalid shapes, exact RAW immediate ALLundo and two narrow semantic mutants. This is the only runtime delta after broad actual-scale full npm; fresh independent FULL HIGH reviews the complete final21-file freeze.


## Independent FULL HIGH P1 correction — pending fresh review

The prior frozen candidate received **DURDURULDU**: complete personal-restore tables combined with missing `sync_mutation_receipts` passed cleanup readiness, then account deletion performed an external cleanup before a missing-table database failure. The existing deletion fixture reproduced routed500 `ACCOUNT_DELETE_FAILED` before correction (`/private/tmp/reptrio-b44-p1-before-fix.log`).

`storageCleanupMode` now requires both record storage and mutation receipts to be ready whenever personal-restore storage is ready, before any external effect. The existing FK-on/off deletion matrix adds this exact mixed-schema case and passes routed503 `SYNC_STORAGE_SCHEMA_UNSUPPORTED`, zero database writes, unchanged complete account data, zero Apple revocations and zero OpenAI response deletes (`/private/tmp/reptrio-b44-p1-corrected-deletion.log`, EXIT0). Supported predecessor schemas without personal tables remain covered. Syntax and diff checks pass. This narrow cleanup-readiness delta follows the previously recorded broad and focused evidence; no unrelated broad tests were repeated. The corrected exact21 candidate is **pending fresh independent FULL HIGH**, with no commit, push, deployment or acceptance.


## 2026-10-09 — Corrected backend personal restore accepted

Fresh independent FULL HIGH Guardian: **GEÇTİ**, corrected 21-file freeze SHA256 `34f9721efb86a328f4d1ad46d849fd9fe49a025f8e9119513d5b86cf7acda567` on base `efe0dcf5a386d9b2e4c00ab3d836dffdd892f847`. Parent verified all frozen hashes before this documentation-only acceptance append. Prior DURDURULDU remains historical; combined personal-ready/missing-receipts P1 is closed. Independent routed SQLite: 503 SYNC_STORAGE_SCHEMA_UNSUPPORTED, zero external effects/DB writes, account retained; FK on/off supported and partial schema deletion checks PASS.

Evidence: corrected deletion suite and independent lifetime receipt/ALL undo/UNDONE replay/cross-account controls PASS. Existing 24 focus groups/six safety mutants and full 5,101 sessions/66,313 sets evidence assessed proportionately; broad run predates final unit/empty guards, later focus covers them. Mechanical backend Guardian NOT_AVAILABLE. No runtime changes after reviewed freeze. Commit/push permitted for this backend scope only.

Build44 overall **PARTIAL**: native operation boundary, account-scoped pending reconciliation, Watch ownership/custody approval and implementation, ZIP UI/restore application/statistics integration and cross-device end-to-end verification remain. No production migration/deploy, iOS build/TestFlight or real user deletion performed or authorized. B45 external imports PLAN_ONLY.
