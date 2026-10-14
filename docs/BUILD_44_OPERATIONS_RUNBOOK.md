# Build 44 — operations runbook (release safety)

Status: **PLAN / NOT EXECUTED.** Nothing in this file has been run against production. Every production step needs the
user's explicit release instruction. Evidence date: 2026-10-14.

## 0. Release preconditions (BLOCKED until all are true)

| # | Precondition | How it is verified | State 2026-10-14 |
|---|---|---|---|
| P1 | Purge fits the **actual** plan (Workers Free, user decision 2026-10-14: no Paid subscription) | §4: <= 40 D1 statements and <= 40 external fetches per invocation, daily write budgets, statistics-free plans (`npm run test:free-plan`) | **Locally verified** (real Worker code + SQLite with Free limits enforced) |
| P2 | Cron CPU <= 10 ms (Workers Free) on real Cloudflare | §4b procedure after deploy | **NOT VERIFIED** (cannot be measured locally) |
| P3 | `OPS_ALERT_EMAIL` set (Worker var) to an inbox someone reads | `wrangler.jsonc` `vars` → applied by the Build 44 deploy | **Configured** `support@reptrio.com`; delivery test PASS (§2a); production cron delivery pending (§2b) |
| P4 | Production D1 backed up (Time Travel bookmark recorded) | `wrangler d1 time-travel info a2-workout-pilot` | Not done |
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
(`wrangler rollback`); additive columns remain harmless. Data rollback = Time Travel restore to the P4 bookmark (destroys
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
  references a stored response, and today's purge write budget (25,000 rows, estimate = owner rows x (1 + indexes))
  accepted this charge. Larger accounts are held with `ACCOUNT_PURGE_PLAN_CAPACITY` (alerted, nothing erased); a spent
  budget resumes at 00:00 UTC (`ACCOUNT_PURGE_DAILY_BUDGET`). The 15-minute maintenance has its own 25,000 rows/day cap,
  so >= 50% of the daily write quota always remains for the app.

| Stored AI responses | Invocations (email/Google/Apple) | Max D1 statements / invocation | Max external fetches / invocation |
|---|---|---|---|
| 0 | 1 | 37 | 0 (Apple: 1) |
| 1–30 | 2 | 37 | n |
| 49–50 | 3 | 37 | 40 |
| 100 | 4 | 37 | 40 |
| 300 | 9 | 37 | 40 |

Request paths: `DELETE_NOW` <= 30 D1 statements. Throughput: one owner per minute; a 300-response account occupies the
purge for ~9 minutes.

Daily D1 rows read by the background triggers on statistics-free databases (no `ANALYZE`; production has no
`sqlite_stat*`), steady state, `node scripts/ops/project-cron-d1-usage.mjs` (real Worker statements replayed with SQLite
`.scanstats`):

| Work rows / receipts / restore records | Before (`cca37b8`) | After |
|---|---|---|
| 1,000 | 3,399,450 rows/day (68% of Free) | 152,074 (3.0%) |
| 10,000 | 32,819,460 (656%) | 152,164 (3.0%) |
| 100,000 | 327,019,560 (6,540%) | 153,064 (3.1%) |

Causes fixed by `0014`: index-less scans of `account_lifecycle_work` every minute; restore maintenance scanning all
retained `personal_restore_records` without planner statistics (now driven from cleanup-eligible operations through
partial indexes, `CROSS JOIN` fixes the loop order); owner deletes scanning `auth_sessions` (no `user_id` index).
Behaviour note: roots/chunks cleanup now targets cleanup-eligible operations only (as payload cleanup already did); a
protected (committed/undo) restore's rare record-less roots stay until account erase instead of being deleted early.

### 4b. CPU (10 ms per cron invocation on Free) — NOT VERIFIED

Local Node CPU per purge invocation (includes in-process SQLite, which D1 executes outside the Worker, and JIT warm-up)
was 2.5–12 ms; this is not Cloudflare CPU time and proves nothing either way. Verify on the deployed Worker only:
1. Workers & Pages → `a2-workout` → Metrics: filter trigger `* * * * *`; CPU time p50/p99 and invocation status. Any
   `exceededCpu` (Workers Logs `outcome`) on a purge invocation = FAIL.
2. Workers Logs (observability enabled): `account_purge_progress` / `account_purge_retry` lines show the step; compare
   with `$workers.cpuTimeMs` of the same invocation.
3. A controlled production deletion (e.g. a dedicated test account with stored responses) is needed to exercise the
   upstream step; it creates/erases production data and requires explicit user approval. Without it, the first real
   deletion is the evidence.
If CPU exceeds the limit: the step is cut by the platform; durable progress means no data loss, but the account will
not finish. Reduce `PURGE_UPSTREAM_DELETES` and redeploy (explicit instruction).

Sources: https://developers.cloudflare.com/workers/platform/limits/ ,
https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/
