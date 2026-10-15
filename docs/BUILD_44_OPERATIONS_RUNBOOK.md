# Build 44 — operations runbook (release safety)

Status: **PLAN / NOT EXECUTED.** Nothing in this file has been run against production. Every production step needs the
user's explicit release instruction. Evidence date: 2026-10-14.

## 0. Release preconditions (BLOCKED until all are true)

| # | Precondition | How it is verified | State 2026-10-14 |
|---|---|---|---|
| P1 | Purge fits the **actual** plan (Workers Free, user decision 2026-10-14: no Paid subscription) | §4: <= 40 D1 statements and <= 40 external fetches per invocation, daily write budgets, statistics-free plans (`npm run test:free-plan`) | **Locally verified** (real Worker code + SQLite with Free limits enforced) |
| P2 | Cron CPU <= 10 ms (Workers Free) on real Cloudflare | §5b isolated test (2026-10-15) + §4b after deploy | **MEASURED, limit exceeded without termination**: 32/32 invocations `ok`, 0 `exceededCpu`; idle purge <= 9 ms and digest <= 6 ms within the limit, but maintenance 10–21 ms and purge work steps 12–26 ms are above 10 ms (§5b). Not a clean PASS; release decision by the user |
| P3 | `OPS_ALERT_EMAIL` set (Worker var) to an inbox someone reads | `wrangler.jsonc` `vars` → applied by the Build 44 deploy | **Configured** `support@reptrio.com`; delivery test PASS (§2a); production cron delivery pending (§2b) |
| P4 | Production D1 backed up (Time Travel bookmark recorded) | `wrangler d1 time-travel info a2-workout-pilot` | Not done (take it immediately before step 3; Time Travel available, see §5) |
| P5 | Integrated HIGH Guardian `GEÇTİ` on both integration branches | Guardian report | See mobile `docs/tasks/BUILD_44_INTEGRATION.md` |

User decision 2026-10-14 (superseding the earlier Paid precondition): stay on Workers Free; the release condition is that
account deletion is proven safe within the real plan limits. Option A (bounded, durable purge) was approved; no Paid
subscription, no billing change. If P2 fails after deploy (`exceededCpu` on the purge trigger), the release is BLOCKED
again and the step size is reduced (`worker/free-plan-limits.js`) before any further production deletion.

## 1. Production D1 migration (ledger repair + apply)

Read-only evidence (2026-10-14): remote `d1_migrations` records only `0001`–`0003` and `0004_import_job_raw_files`.
The schema already contains `mobile_oauth_codes`, `oauth_reauth_tickets`, `password_reset_tokens` and
`oauth_accounts.refresh_token_ciphertext/refresh_token_updated_at/email_trusted` (applied outside the ledger).
A plain `wrangler d1 migrations apply --remote` therefore **fails at `0005_oauth_refresh_tokens.sql`
(`duplicate column name: refresh_token_ciphertext`)**.

Rehearsal against the exported production schema (`wrangler d1 export --no-data`): recording `0004_mobile_oauth_codes`
… `0007_password_reset_tokens` as applied and then applying `0008`–`0013` yields a schema **identical** (tables,
columns, types, defaults, indexes) to a fresh `0001`–`0013` install. `0014_free_plan_capacity` (additive: one nullable
column, indexes, `d1_write_budget`) applies on top; the Build 44 Worker fails closed (`ACCOUNT_LIFECYCLE_UNAVAILABLE`)
until it exists.

Order (each step only on explicit release instruction):

1. P4 backup bookmark.
2. Re-run the read-only schema check; abort if any 0004–0007 object/column is missing:
   `SELECT name FROM pragma_table_info('oauth_accounts')` must include `refresh_token_ciphertext`,
   `refresh_token_updated_at`, `email_trusted`; tables `mobile_oauth_codes`, `oauth_reauth_tickets`,
   `password_reset_tokens` must exist with the 0004/0005/0007 columns, and the indexes `mobile_oauth_codes_hash_idx`,
   `mobile_oauth_codes_user_idx`, `oauth_reauth_tickets_user_idx`, `password_reset_tokens_user_idx` must exist
   (`SELECT name FROM sqlite_master WHERE type='index'`). If an index is missing, run that migration's
   `CREATE INDEX IF NOT EXISTS` statement first (idempotent); never mark a migration applied with objects missing.
3. Ledger repair (one statement, no schema change):
   `INSERT INTO d1_migrations(name) VALUES ('0004_mobile_oauth_codes.sql'),('0005_oauth_refresh_tokens.sql'),('0006_oauth_email_trusted.sql'),('0007_password_reset_tokens.sql');`
4. `wrangler d1 migrations list a2-workout-pilot --remote` must show exactly `0008`–`0014` pending.
5. `wrangler d1 migrations apply a2-workout-pilot --remote` (additive only: new tables + `ADD COLUMN` with defaults; no
   DROP/RENAME). The currently deployed Build 43 Worker keeps working on the additive schema.
6. Deploy the Build 44 Worker (`npm run cf:deploy`) only after step 5 succeeds. Worker-before-migration is unsafe:
   lifecycle/record/restore routes fail closed with 503 until their tables exist.
7. Post-deploy read-only checks: `/api/health`, schedules show three crons, `X-Robots-Tag` on `app.reptrio.com`,
   `recovery.html` 200, one `ops_digest_*` log line after the next 06:00 UTC, §4b CPU check of the minute trigger.

Rollback: before step 6, nothing user-visible changed (additive schema). After step 6, redeploy the previous version
(`wrangler rollback 2b15b60d-cf74-4217-a796-3ac85aaa7ffa`, Build 43); additive columns remain harmless. Cron triggers
are not part of a version and that version has no `scheduled()` handler: after the rollback check
`/workers/scripts/a2-workout/schedules`; if the three crons remain, remove them (a deploy whose config has
`"triggers": {"crons": []}`), otherwise every trigger fails. Accounts already `PURGING` then wait (fail-closed) until
Build 44 is redeployed. Data written by Build 44 to the new tables is ignored by Build 43; Build 43 legacy sync keeps
writing `user_data`. Data rollback = Time Travel restore to the P4 bookmark (destroys
writes made after it; only with explicit approval).

## 2. Alert routing (existing infrastructure)

- Trigger `0 6 * * *` runs `runOperationalDigest` in its own invocation (read-only, ≤5 queries). The minute purge and
  15-minute maintenance triggers are unchanged.
- Findings: `ACCOUNT_PURGE_OVERDUE` (due >1h; lists `purge_error` codes incl. `ACCOUNT_PURGE_PLAN_CAPACITY` /
  `ACCOUNT_PURGE_DAILY_BUDGET`), `ACCOUNT_PURGE_CAPACITY` (due backlog >1440 = one owner/min/day), `AI_WORK_UNKNOWN`,
  `AI_WORK_STUCK_RUNNING` (>15 min: the minute cron is not running), `AI_CLEANUP_FAILED`, `D1_WRITE_BUDGET_HIGH`
  (previous UTC day used >= 80% of a background write cap).
- Delivery: ZeptoMail (`sendTransactionalEmail`) to `OPS_ALERT_EMAIL`; counts and opaque work ids only.
  Without a recipient the digest logs `ops_alert_unrouted` (never silent success).
- `observability.enabled = true`: Workers Logs keep `ops_digest_*`, `account_purge_retry/overdue/unavailable` lines.
- Residual: no external dead-man switch. If the scheduler itself stops, no email is sent; the absence of the daily
  `ops_digest_*` log line is the signal. Check it during the first release week.

### 2a. Recipient and delivery test (2026-10-14) — PASS (test delivery only)

- Recipient `support@reptrio.com` (user decision 2026-10-14). Verified in the live Zoho Mail admin console: Mail Lite,
  1 user / 1 licence; `support@reptrio.com` is an address of the existing mailbox (no new mailbox, provider or
  subscription). `reptrio.com` MX = Zoho EU. ZeptoMail suppression list empty.
- Sender unchanged: existing ZeptoMail EU agent `reptrio-password-reset`, `Reptrio <no-reply@mail.reptrio.com>`.
- Test: the real `runOperationalDigest` + `sendTransactionalEmail` (backend `1815280`) run locally against an
  isolated in-memory SQLite with one synthetic UNKNOWN row (`00000000-0000-4000-8000-b44a1e7e5701`); subject prefixed
  `[TEST — Build 44 alarm teslim doğrulaması]`. Key entered by the user via a hidden TTY prompt (not argv/env/disk;
  network locked to `POST https://cpaas.zoho.eu/v1.1/email`, redirects refused). No production DB, no deploy.
- Evidence: script result `zeptomail=accepted, routed=true`; ZeptoMail log 14 Oct 2026 14:30:52 (+03) **Teslim edildi**,
  client reference `ops-test-2026-10-14T11-24-47-031Z`, recipient `support@reptrio.com`; message present in the Zoho
  **Inbox** (not spam), From `no-reply@mail.reptrio.com`, To `support@reptrio.com`, TLS.
- Scope: proves recipient routing and ZeptoMail→Zoho delivery for the digest format. It does **not** prove the
  production cron.

### 2b. Production cron delivery — NOT VERIFIED (after deploy)

Only after the Build 44 deploy (§1 step 6): confirm the deployed Worker shows `OPS_ALERT_EMAIL` among its variables and
three cron schedules; after the next 06:00 UTC check Workers Logs for one `ops_digest_clear` / `ops_digest_alert` line
and, if an alert fired, the ZeptoMail log + Zoho Inbox. `ops_alert_unrouted` or `ops_alert_delivery_failed` = FAIL.
A clear day sends no email by design: `ops_digest_clear` is written before the recipient is read, so it proves only
that the scheduler ran, not email routing. Production cron email delivery stays NOT VERIFIED until the first real
`ops_digest_alert` is delivered (ZeptoMail log + Zoho Inbox); `ops_alert_unrouted` / `ops_alert_delivery_failed` = FAIL.

## 3. UNKNOWN AI upstream reconciliation

Facts (official `openai-node` 7.33.0 resource map): Responses support create / retrieve / delete / cancel / input_items;
**there is no list/search endpoint**. A response whose id was never received cannot be discovered by the Worker.

Mechanism:
- Definite upstream rejection (HTTP 400/401/403/404/413/415/422/429 only) closes the work row as `RESOLVED` / `UPSTREAM_REJECTED_<status>`
  (no response object was created). Any other status (incl. 408/409/5xx), timeout, network error or unreadable 2xx body stays `UNKNOWN`. A bad/expired proof is answered 401 before this check.
- The work id is sent as `X-Client-Request-Id` and `metadata.import_request_id`, so the operator can locate it.
- `UNKNOWN`/`RUNNING` blocks: `DELETE_NOW` and the recovery screen's `purge-now` are refused with `409 ACCOUNT_PURGE_UPSTREAM_UNRESOLVED` **before any state
  change** (session and proof stay valid; user may choose 30-day closure; a pending account stays recoverable instead of becoming an unrecoverable, unpurged `PURGING`). A due purge stays `PURGING` with
  `purge_error=ACCOUNT_PURGE_UPSTREAM_UNRESOLVED`; nothing is deleted and no success is reported.
- Operator, per `AI_WORK_UNKNOWN` work id (OpenAI dashboard Logs / support, search by request id = work id):
  - Found `resp_…`: `node scripts/ops/reconcile-ai-work.mjs --work <id> --response <resp_…> --evidence <ref>` → the
    normal purge deletes it at OpenAI (200/404) before erasing the account.
  - Verified absent: `node scripts/ops/reconcile-ai-work.mjs --work <id> --absent --evidence <ref>`.
  - The tool only prints a guarded command (`… AND state='UNKNOWN'`); run it once, expect `changes: 1`.
- Never close UNKNOWN by timeout or assumption about provider retention.

## 4. Capacity on Workers Free (verified locally 2026-10-14; `npm run test:free-plan`)

Limits (Cloudflare docs 2026-10-14): Workers Free 50 external subrequests and 1,000 Cloudflare-service subrequests per
invocation, cron CPU 10 ms, 5 cron triggers/account (this Worker uses 3); D1 Free 50 queries per invocation, 5,000,000
rows read and 100,000 rows written per day (reset 00:00 UTC; exceeding them stops D1 for the whole app until the reset).
D1 queries and external fetches are separate limits (the earlier table that summed them was wrong). Whether a D1 batch
counts as one query is undocumented; every batch statement is counted here (conservative).

Mechanism (Option A, approved 2026-10-14; purge algorithm and its single atomic final erase kept):
- `DELETE_NOW` and recovery "purge now" only move the account to `PURGING` (irreversible; sessions revoked) and answer
  `202 {accountStatus:'PURGING', purgeComplete:false}`. Completion is never reported by a request.
- The minute cron runs one bounded step per invocation for one owner: EITHER upstream cleanup (stored import response
  ids move atomically into the `account_lifecycle_work` ledger; <= 40 OpenAI deletes; confirmed 200/404 deletes are
  recorded in one statement; `purge_error=ACCOUNT_PURGE_IN_PROGRESS`, next step next minute, no backoff) OR the final
  erase (Apple revoke, then the atomic batch). Failures back off exponentially (max 1 day); a lost lease (120 s) is
  retaken; repeated deletes are idempotent (404 = already absent).
- The final batch deletes nothing unless, at the database: the lease is held, no ledger row is open, no import job still
  references a stored response, and today's purge write budget (60,000 rows, estimate = owner rows x (1 + indexes))
  accepted this charge. Larger accounts (about 12,000+ sync records: `sync_records` has 4 indexes, 5 rows written per
  row) are held with `ACCOUNT_PURGE_PLAN_CAPACITY` (nothing erased; digest `ACCOUNT_PURGE_MANUAL_REQUIRED`) for §4c; a
  spent budget resumes at 00:00 UTC (`ACCOUNT_PURGE_DAILY_BUDGET`). The 15-minute maintenance has its own 15,000
  rows/day cap, so >= 25,000 rows/day always remain for the app (Build 44 record sync writes only changed records; Build 43 legacy sync peaked at 50,024 rows on 2026-10-14, see §5).
  User decision 2026-10-14 (after the Guardian finding): raise the cap + manual procedure for larger accounts.

| Stored AI responses | Invocations (email/Google/Apple) | Max D1 statements / invocation | Max external fetches / invocation |
|---|---|---|---|
| 0 | 1 | 38 | 0 (Apple: 1) |
| 1–30 | 2 | 38 | n |
| 49–50 | 3 | 38 | 40 |
| 100 | 4 | 38 | 40 |
| 300 | 9 | 38 | 40 |

Request paths: `DELETE_NOW` <= 30 D1 statements. Purge invocations <= 38 D1 statements (upstream step: +1 budget charge;
final: +1 read-only budget pre-check before the Apple revoke). Throughput: one owner per minute; a 300-response account occupies the
purge for ~9 minutes.

Daily D1 rows read by the background triggers on statistics-free databases (no `ANALYZE`; production has no
`sqlite_stat*`), steady state, `node scripts/ops/project-cron-d1-usage.mjs` (real Worker statements replayed with SQLite
`.scanstats`). Size n = n ledger rows, n receipts, n retained restore records, n EXPIRED + n/10 CANCELLED abandoned
restores (100 freshly expired), n/10 credentials/tickets/sessions:

| n | Before (`cca37b8`) | Guardian round 2 code (`0e09c2f`) | After |
|---|---|---|---|
| 1,000 | 3,505,050 rows/day (70% of Free) | 1,208,074 (24%) | 200,074 (4.0%) |
| 10,000 | 33,875,460 (678%) | 10,712,164 (214%) | 200,164 (4.0%) |
| 100,000 | 337,579,560 (6,752%) | 105,753,064 (2,115%) | 201,064 (4.0%) |

Background writes: every purge write (upstream steps and final erase) and every maintenance delete is charged to its
daily cap (60,000 + 15,000); only the lifecycle expiry deletes (short-lived credentials/tickets created by user actions)
are uncharged.

Causes fixed by `0014`: index-less scans of `account_lifecycle_work` every minute; restore maintenance scanning all
retained `personal_restore_records` without planner statistics (now driven from cleanup-eligible operations through
partial indexes, `CROSS JOIN` fixes the loop order); abandoned (EXPIRED/CANCELLED) restore operations re-walked forever
(now marked `cleanup_done` once payload-free, 256 per run = 24,576/day, and leave the index); owner deletes scanning
`auth_sessions` (no `user_id` index).
Behaviour note: roots/chunks cleanup now targets cleanup-eligible operations only (as payload cleanup already did); a
protected (committed/undo) restore's rare record-less roots stay until account erase instead of being deleted early.

### 4c. Held large account (`ACCOUNT_PURGE_MANUAL_REQUIRED`) — operator procedure

The account is already closed, unrecoverable and upstream-clean (the hold happens only at the final step). Goal:
complete the erase within days (App Store account deletion) without exceeding the D1 daily write quota.
1. Take the user id from the dashboard/D1 (`SELECT id FROM users WHERE purge_error='ACCOUNT_PURGE_PLAN_CAPACITY'`).
2. `node scripts/ops/purge-large-account.mjs --user <id> --evidence <ticket>` prints, per bulk table, a **charge**
   command (reserves rows x 5 in today's shared purge budget; expect `changes: 1`, `0` = budget spent, stop until
   00:00 UTC) and a **delete** command (<= 4,000 owner rows, only while the account is still held). Run charge then
   delete; repeat until every delete reports `changes: 0`.
3. `UPDATE users SET purge_retry_at=NULL WHERE id='<id>' AND account_status='PURGING';` — the next minute cron runs
   the normal gated final erase (lease, ledger, budget). Confirm the row is gone.
Each run needs explicit approval (production data). A 70,000-record account needs about 350,000 rows written, i.e.
about 6 days at the 60,000/day purge cap.

### 4d. Open capacity risks (Guardian round 3, MINOR; bounded and alerted, not fixed in Build 44)

- **Stuck due accounts are re-read every minute.** The minute selector reads every due account in backoff
  (`APPLE_REAUTH_REQUIRED`, `ACCOUNT_PURGE_PLAN_CAPACITY`, `OPENAI_CLEANUP_UNAVAILABLE`, `ACCOUNT_PURGE_DAILY_BUDGET`)
  before picking one: K stuck accounts cost about 1,440 x K rows read/day (about 3,470 would exhaust the Free 5M/day).
  They are alerted by `ACCOUNT_PURGE_OVERDUE` (and `ACCOUNT_PURGE_MANUAL_REQUIRED`); act when the overdue count exceeds
  ~100. Follow-up: an index/query that skips backed-off owners.
- **Extreme stored-response counts stall silently.** An upstream step charges (2 x stored + 42) x 5 rows; with about
  5,990+ stored response ids that exceeds the 60,000 daily cap, so the account repeats `ACCOUNT_PURGE_DAILY_BUDGET`
  every day without `MANUAL_REQUIRED`. Unrealistic (imports are rate-limited); treat `ACCOUNT_PURGE_DAILY_BUDGET` in the
  overdue digest for more than 2 consecutive days as a manual case. The §4c tool reduces only bulk tables; an account
  whose non-bulk tables alone exceed the cap also needs a manual plan.

### 4b. CPU (10 ms per cron invocation on Free) — NOT VERIFIED

Local Node CPU per purge invocation (includes in-process SQLite, which D1 executes outside the Worker, and JIT warm-up)
was 2.5–12 ms; this is not Cloudflare CPU time and proves nothing either way. Verify on the deployed Worker only:
1. Workers & Pages → `a2-workout` → Metrics: filter trigger `* * * * *`; CPU time p50/p99 and invocation status. Any
   `exceededCpu` (Workers Logs `outcome`) on a purge invocation = FAIL.
2. Workers Logs (observability enabled): `account_purge_progress` / `account_purge_retry` lines show the step; compare
   with `$workers.cpuTimeMs` of the same invocation.
3. A controlled production deletion (e.g. a dedicated test account with stored responses) is needed to exercise the
   upstream step; it creates/erases production data and requires explicit user approval. Preferred instead: the isolated test in §5a (no production data). Without either, the first real
   deletion is the evidence.
If CPU exceeds the limit: the step is cut by the platform; durable progress means no data loss, but the account will
not finish. Reduce `PURGE_UPSTREAM_DELETES` and redeploy (explicit instruction).

Sources: https://developers.cloudflare.com/workers/platform/limits/ ,
https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/

## 5. Release preflight (2026-10-15, read-only; nothing applied)

Production reads only (`SELECT`/`PRAGMA`, `d1 info`, `d1 insights`, `time-travel info`, Workers/GraphQL read APIs).
No migration, deploy, data change, merge or TestFlight upload.

| Check | Result |
|---|---|
| Migration ledger | unchanged: `0001`–`0003` + `0004_import_job_raw_files` only |
| 0004–0007 objects (§1 step 2) | all present: `oauth_accounts.refresh_token_ciphertext/refresh_token_updated_at/email_trusted`, `mobile_oauth_codes`, `oauth_reauth_tickets`, `password_reset_tokens`, the four indexes; no `0008`+ object; no `sqlite_stat*` |
| Rehearsal (DDL read from `sqlite_master`, no export lock) | ledger repair → pending exactly `0008`…`0014` in this order → all apply; schema (tables, columns, types, defaults, PKs, indexes incl. partial predicates) **identical** to a fresh `0001`–`0014` install; `foreign_key_check`/`integrity_check` clean |
| Data volume | 86 users, 294 sets, 23 `user_data`, 2.37 MB: `ALTER`/`CREATE INDEX` are instant |
| Time Travel | available (bookmark readable). Free plan retention **7 days**; restore is destructive/in place and returns an undo bookmark |
| Worker scripts / crons | 3 Workers (`a2-workout`, `eksenda-web`, `reptrio-marketing`), **0 crons** today; Build 44 adds 3 (Free limit 5/account) |
| Deployed version (rollback target) | `2b15b60d-cf74-4217-a796-3ac85aaa7ffa` = Build 43 backend `21fa48f` (2026-10-07); it has no `scheduled()` handler |
| Secrets/bindings | every `env.*` the Build 44 code reads exists in production (secrets + vars + bindings); `wrangler deploy --dry-run` bundles (357 KiB) |
| Existing request CPU (7 days, `a2-workout`) | 888 requests, 0 errors, CPU p50 0.9 ms, p99 31.6 ms, max 42.9 ms, all `success` — Free tolerates infrequent overruns ("built-in flexibility"), but a trigger that exceeds 10 ms **consistently** is terminated |

**D1 writes today (Build 43 legacy sync) — new finding.** `rows_written` per day: 1.3k–6.7k typical, **43,192
(2026-10-12) and 50,024 (2026-10-14)**. Source (`d1 insights`): the legacy push rewrites every set of the account
(`DELETE … WHERE user_id` + one `INSERT INTO workout_sets` per set, 2 rows each); one active account (246 sets,
`sync_version` 1638) pushed ~68 times on 2026-10-14. If that account doubles its sets at the same push rate, the
Free 100,000 rows/day is exhausted and D1 stops for every user until 00:00 UTC. Build 44 removes this: `/api/sync/push`
goes to `recordPush`, which writes only changed records (local measurement, 255 sets: first push 277 row changes once,
unchanged re-push 1, one edited set 2). Consequences for the release:
- the "~500 writes/day" in §4 understated Build 43 days; the >= 25,000 rows/day app headroom holds for Build 44 sync;
- deploy early in the UTC day (before heavy use) so pre-deploy legacy writes + post-deploy budgets stay < 100,000.

**Deployed-client compatibility (in memory, production `user_data` payloads, nothing written anywhere).** Each of the 23
stored payloads was pushed to the Build 44 `recordPush` on a local SQLite copy as the deployed apps do after deploy:
22 accounts (schema 4: 1, schema 5: 17, schema 8 = Build 42 app: 4) → first push 200, pull byte-identical, next push
200. 1 account (schema 5, inactive since 2026-08-24) → `409 SYNC_CLIENT_UPGRADE_REQUIRED` (rule at
`record-sync-storage.js:338`: its stored sessions already use the object `sets` shape a schema-5 client cannot write
safely). Intended fail-closed behaviour; its data is pulled unchanged; it syncs again after updating the client.

### 5a. Isolated Cloudflare CPU test (prepared, NOT deployed)

Goal: real Workers Free CPU for the minute purge (final erase, 40-delete upstream step, Apple revoke), the 15-minute
maintenance and the 06:00 digest, without touching `a2-workout-pilot`. Files: `scripts/ops/cputest/wrangler.cputest.jsonc`
(separate Worker `a2-workout-cputest` + D1 `reptrio-cputest`; no routes, assets, queue, alert e-mail; own rate-limit
namespaces) and `scripts/ops/cputest/build-seed.mjs` (fake `*.invalid` accounts through the real API; throwaway P-256
key, not an Apple credential). Seed validated locally with the real cron handlers: final-erase account erased in one
step, 45 stored ids deleted as 40 + 5, Apple account signs a real client-secret JWT and stays `PURGING`/
`APPLE_REVOKE_FAILED` (Apple rejects the throwaway key: fail-closed, nothing erased), bystander intact, backlog cleaned.

Cost: Workers Free + D1 Free, no billing change. Quotas are account-wide: seed 2,635 rows (~6k rows written incl.
indexes) + the test's own purge/maintenance writes (~10k) count toward the shared 100,000/day; run it on a quiet day.

Steps (each needs explicit approval; run **before** the production deploy, then delete everything). `entry.mjs` maps the
test crons `*/5` and `*/10` onto the production maintenance and digest names so all three triggers run within minutes:
1. `node scripts/ops/cputest/build-seed.mjs` (local; writes `.tmp-cputest/`, gitignored).
2. `npx wrangler d1 create reptrio-cputest` → put the id into the config's `database_id`.
3. `npx wrangler d1 migrations apply reptrio-cputest --remote -c scripts/ops/cputest/wrangler.cputest.jsonc`.
4. Secrets on the TEST Worker only: `APPLE_OAUTH_PRIVATE_KEY` < `.tmp-cputest/apple-test-key.p8`,
   `APPLE_OAUTH_CLIENT_ID=com.reptrio.cputest`, `APPLE_OAUTH_TEAM_ID=CPUTEST000`, `APPLE_OAUTH_KEY_ID=CPUTEST000`.
   Optional `OPENAI_API_KEY` (typed by the owner with `wrangler secret put … -c …`; never pasted in chat): with it every
   fake id answers 404 and all 40 deletes run; without it the upstream step stops after its first 401 (step not covered).
5. `npx wrangler deploy -c scripts/ops/cputest/wrangler.cputest.jsonc`, then
   `npx wrangler d1 execute reptrio-cputest --remote --file .tmp-cputest/seed.sql -c …`.
6. Observe >= 15 minutes plus one 06:00 UTC run: Workers Logs `$workers.cpuTimeMs`/`outcome` per trigger
   (`* * * * *`, `*/15 * * * *`, `0 6 * * *`). PASS = no `exceededCpu`, and p99 <= 10 ms for the purge trigger.
7. `npx wrangler delete -c …` and `npx wrangler d1 delete reptrio-cputest`. **Mandatory before the production deploy:**
   3 test crons + 3 production crons > 5 makes the production deploy fail.
If the purge trigger exceeds the limit: lower `PURGE_UPSTREAM_DELETES` / the final-erase step and repeat (code change,
own Guardian scope).

### 5b. Isolated CPU test result (2026-10-15 06:40–07:13 UTC; executed with explicit approval, resources deleted)

Worker `a2-workout-cputest` (version `bd6e1ff2`, no workers.dev URL) + D1 `reptrio-cputest`, fake accounts only,
throwaway Apple key, `OPENAI_API_KEY=sk-cputest-invalid` (OpenAI answers 401). Production untouched (version
`2b15b60d`, 86 users, ledger 4 rows, 7 rows written that day before and after). Source: `wrangler tail` per invocation
(`cpuTime`, `outcome`), cross-checked with GraphQL `workersInvocationsAdaptive` (31 invocations, all `success`,
p50 7.2 ms, p90 18.5 ms, p99 26.6 ms). Summary: `node scripts/ops/cputest/analyze-tail.mjs <tail.jsonl>`.

| Trigger / step | Invocations | CPU (ms) | Outcome | vs 10 ms |
|---|---|---|---|---|
| Purge, idle (nothing due; 4 D1 statements) | 18 | min 3, median 4, p90 8, max 9 | all `ok` | within, margin 10–70% |
| Purge, final erase (email account, 300 sync records, one atomic batch) and Apple revoke + final erase (ES256 client-secret JWT, sealed token decrypt, Apple answered 200, account erased) | 2 | 12 and 17 (logs do not say which is which) | `ok` | **over** |
| Purge, upstream step (45 ids adopted into the ledger, budget charge, 1 DELETE answered 401, then retries) | 3 | 26, 18, 26 | `ok` | **over** |
| Purge, upstream step with 40 confirmed deletes | 0 | NOT MEASURED (needs a real OpenAI key; 40 fetches add to the 18–26 ms above) | — | NOT MEASURED |
| Maintenance, first run with backlog (1,000 receipts, 1,000 restore records cleaned) | 1 | 21 | `ok` | **over** |
| Maintenance, idle (14 D1 statements) | 4 | 14, 12, 10, 10 | `ok` | **at / over** |
| Daily digest (5 statements; no e-mail routed) | 3 | 3, 5, 6 | `ok` | within |

Not a PASS: no invocation was terminated, but Cloudflare only promises "built-in flexibility" for infrequent overruns
and terminates a Worker that hits the limit "consistently". The idle cost tracks the D1 statement count (about 2–3 ms
fixed plus ~0.5 ms per statement), so maintenance (96 runs/day) sits at the limit every run; purge work steps run only
while an account is being deleted (minutes per account). If the platform does cut a run: purge progress is durable
and the final erase is one atomic batch (no partial erase), the account just takes longer (`ACCOUNT_PURGE_OVERDUE`);
maintenance deletes are idempotent and resume next run. Mitigation options (code change, own Guardian scope): fewer
statements per maintenance run (e.g. skip idle sub-steps, alternate them between runs), smaller purge steps.
D1 usage of the test: 13,828 rows written (seed 10,918), 30,544 read; account total that day stayed < 14,000 / 100,000.
Cleanup verified: `a2-workout-cputest` and `reptrio-cputest` deleted; account crons 0 / 5 (production needs 3).
