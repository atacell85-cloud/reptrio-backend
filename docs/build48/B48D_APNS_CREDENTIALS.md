# B48-D — APNs credentials per environment (Sandbox / Production)

Status: IMPLEMENTED on `build48/integration` (code + tests). **Not deployed. No secret added, changed or deleted.**
Every production step below needs separate explicit approval.

## 1. Evidence and root cause
- 2026-10-22, production D1 `live_activity_end`: development-signed iPhone (`aps-environment=development` → sandbox push
  token), row `auto`, deadline 17:22:47 UTC; at 17:26:41 UTC `attempts=1`, `last_error=403:BadEnvironmentKeyInToken`.
  Scheduling, the 30-minute deadline and the cron send attempt worked.
- Build 47 code signed **both** hosts with one JWT from `APNS_KEY_ID`/`APNS_PRIVATE_KEY`. For `auto`: production first;
  a sandbox token there answers `BadDeviceToken` → fallback to sandbox with the **same** JWT → a Production-only key
  is refused there: `403 BadEnvironmentKeyInToken` (the recorded error is the last leg's).
- **Inference, not proof:** the installed production `APNS_KEY_ID` is the Production-only "REPTRIO Production APNs" key
  (a Sandbox-only key would have been delivered by the sandbox leg). The secret value / Key ID was not read. Build 47
  logs only the last leg; Build 48 logs every leg (§4) so this becomes observable.

## 2. Change (backend only; mobile, Watch, Live Activity UI, scheduler and D1 unchanged)
- `worker/apns.js` `apnsConfig(env)` → `{ production, sandbox, ready }`:
  - production: `APNS_KEY_ID` + `APNS_PRIVATE_KEY` + `APNS_TEAM_ID` (existing secrets, unchanged meaning);
  - sandbox: `APNS_SANDBOX_KEY_ID` + `APNS_SANDBOX_PRIVATE_KEY` + (`APNS_SANDBOX_TEAM_ID` or `APNS_TEAM_ID`).
  Malformed/missing → that credential is `null`. No shared fallback: a production token is never sent to sandbox.
- Provider-token cache keyed per credential (key id, team, key material, 40-min bucket), max 4 entries.
- `runLiveActivityEnds`: each host signed with its own credential; host without credential is not contacted.
  `auto` keeps the production → sandbox fallback on `BadDeviceToken` / `BadEnvironmentKeyInToken` /
  `BadEnvironmentKeyIdInToken`.
- Missing credential → `0:SandboxCredentialMissing` / `0:ProductionCredentialMissing`, classified like an auth error:
  retry every 15 min, `FAILED` after 6 attempts (< 150-min row expiry), newer activity re-arms. A `BadDeviceToken`
  from the only host that could be tried is **not** treated as a dead token while the other host is untried.
  Both hosts tried and refused → `DEAD` (unchanged). Neither credential → unchanged "unconfigured" (row not claimed).
- Cron schedule, 30-minute rule, revision/claim race guards, payload, Build 47 client request shapes: unchanged.
- Staging Worker probe (`scripts/ops/apnstest/entry.mjs`) signs each host with its own credential.

## 3. Operator runbook (each step needs explicit approval)
1. **Identify keys locally** (no secret read, nothing delivered):
   `node scripts/ops/apns-key-probe.mjs --key-file AuthKey_<ID>.p8 --key-id <ID> --team-id C4P47F32C8`
   for each .p8 you hold. Expected: "REPTRIO Production APNs" → production ACCEPTED, sandbox WRONG_ENVIRONMENT;
   "Reptrio Live Activity APNs" → sandbox ACCEPTED, production WRONG_ENVIRONMENT. The unrelated Expo key is not used.
2. **Add the sandbox secrets** on `a2-workout` (does not touch existing secrets):
   `npx wrangler secret put APNS_SANDBOX_KEY_ID` (paste the Sandbox Key ID) and
   `npx wrangler secret put APNS_SANDBOX_PRIVATE_KEY < AuthKey_<SandboxID>.p8`.
   Only if the Sandbox key belongs to another team: `npx wrangler secret put APNS_SANDBOX_TEAM_ID`.
   Note: `wrangler secret put` creates a new Worker version from the currently deployed code.
3. **Deploy** the Build 48 backend (B48-D) — separate approval. Order 2 → 3 or 3 → 2 are both safe: before step 2 the
   sandbox host is simply not contacted (rows retry, `0:SandboxCredentialMissing`).
4. **Verify the installed production key without reading it:** the next `auto` row from the development-signed phone
   logs `legs`. Production leg `400 BadDeviceToken` = installed `APNS_KEY_ID` is accepted on production (expected);
   `403 BadEnvironmentKeyInToken` = it is not a production key → replace only with approval.
5. **Physical acceptance:** start a workout on the locked development iPhone, leave it idle 30 min; expect the Live
   Activity to disappear within ~1–2 min of the deadline; D1 row `SENT`, `apns_env='sandbox'`, log legs
   `[production 400 BadDeviceToken, sandbox 200]`. TestFlight/App Store builds (production tokens) separately:
   row `SENT` with `apns_env='production'`.
6. **Staging Worker** (`a2-workout-apnstest`): its `APNS_KEY_ID` is the Sandbox key; before deploying B48-D there, also
   store it as `APNS_SANDBOX_KEY_ID` / `APNS_SANDBOX_PRIVATE_KEY`.
- Rollback: redeploy the previous Worker version; the sandbox secrets are inert for Build 47 code. Kill switch
  unchanged (`wrangler secret delete APNS_PRIVATE_KEY` / `APNS_SANDBOX_PRIVATE_KEY`, approval required).

## 4. Logs
`live_activity_end` log line: `outcome`, `status`, `reason`, `env`, `legs:[{env,status,reason}]`. Never the push token,
provider token, key id or key material (tested).

## 5. Not covered (separate investigations)
App-foreground local cleanup and Apple Watch return-to-watch-face behaviour are not addressed by this credential fix.
