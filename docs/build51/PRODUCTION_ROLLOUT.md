# Build 51 backend — production rollout plan (NOT EXECUTED; needs explicit user approval)

Branch `build51/draft-set-deletion`; base = production source `f054012` (Worker `2d52c211`, record `3551ba8`).

## What changes
- `worker/record-sync-storage.js`: mobile draft set deletion (`setDeletionLog`, `setLayoutFence` known/omittable draft fields;
  prefix/mapping guard; `SYNC_DRAFT_LAYOUT_STALE`), capability `draftSetDeletion: 1`.

## Pre-deploy checks (done 2026-10-30)
1. Migration: none (`git diff f054012 -- migrations` empty). No D1 change.
2. Feature flag: `DRAFT_SET_DELETION_ENABLED` (unset = on). `false` → capabilities stop offering `draftSetDeletion`; the push rule
   stays on so drafts already carrying the bookkeeping can still be finished/cleared.
3. Old clients: Build 50 (production app) — no behaviour change unless another phone deleted a set in the same active workout;
   then a stale copy is refused (`SYNC_DRAFT_LAYOUT_STALE`, unknown code → its sync waits, data stays local), a current copy is
   accepted (it keeps unknown draft fields). PWA schema 5 untouched. Proven by mobile cross-repo tests with the real Build 50 model.
4. Tests: `npm test` PASS; mobile `test-b51-set-deletion-cross-repo`, `test-b51-two-phone-sync-cross-repo`,
   `test-account-lifecycle-integration` / `test-build44-cross-repo-e2e` (pin relaxed run) PASS against this branch.

## Deploy order
Either order is safe: the mobile app offers deletion only after the server reports the capability.

## Rollback
Do NOT revert the code after any deletion happened: the old rule refuses clearing a draft with the new fields (that account's
sync would block until redeploy). Set `DRAFT_SET_DELETION_ENABLED=false` instead. Phones keep a stored "available" answer until
their next session confirmation (the action is still refused by the server only if the code is reverted).

## Commands (for the approved run only)
`npm test` → `npm run cf:deploy` (or GitHub Actions `Worker Deploy`). Verify `/api/sync/capabilities` returns `draftSetDeletion: 1`.
