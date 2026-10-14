# Build 44 — operations runbook (release safety)

Status: **PLAN / NOT EXECUTED.** Nothing in this file has been run against production. Every production step needs the
user's explicit release instruction. Evidence date: 2026-10-14.

## 0. Release preconditions (BLOCKED until all are true)

| # | Precondition | How it is verified | State 2026-10-14 |
|---|---|---|---|
| P1 | Cloudflare account on **Workers Paid** | Dashboard → Workers & Pages → Plans (API token lacks billing scope) | **UNVERIFIED → BLOCKED** |
| P2 | Real capacity on that plan | §4 numbers re-checked against the plan's limits | BLOCKED on P1 |
| P3 | `OPS_ALERT_EMAIL` set (Worker var) to an inbox someone reads | `wrangler deploy` config / dashboard Variables | Not set |
| P4 | Production D1 backed up (Time Travel bookmark recorded) | `wrangler d1 time-travel info a2-workout-pilot` | Not done |
| P5 | Integrated HIGH Guardian `GEÇTİ` on both integration branches | Guardian report | See mobile `docs/tasks/BUILD_44_INTEGRATION.md` |

User decision 2026-10-14: Workers Paid is a Build 44 production precondition; it is **not assumed**. Do not buy a
subscription or change billing as part of integration. If P1/P2 fail, the release stays BLOCKED; the purge algorithm is
not changed to fit Free.

## 1. Production D1 migration (ledger repair + apply)

Read-only evidence (2026-10-14): remote `d1_migrations` records only `0001`–`0003` and `0004_import_job_raw_files`.
The schema already contains `mobile_oauth_codes`, `oauth_reauth_tickets`, `password_reset_tokens` and
`oauth_accounts.refresh_token_ciphertext/refresh_token_updated_at/email_trusted` (applied outside the ledger).
A plain `wrangler d1 migrations apply --remote` therefore **fails at `0005_oauth_refresh_tokens.sql`
(`duplicate column name: refresh_token_ciphertext`)**.

Rehearsal against the exported production schema (`wrangler d1 export --no-data`): recording `0004_mobile_oauth_codes`
… `0007_password_reset_tokens` as applied and then applying `0008`–`0013` yields a schema **identical** (tables,
columns, types, defaults, indexes) to a fresh `0001`–`0013` install.

Order (each step only on explicit release instruction):

1. P4 backup bookmark.
2. Re-run the read-only schema check; abort if any 0004–0007 object/column is missing:
   `SELECT name FROM pragma_table_info('oauth_accounts')` must include `refresh_token_ciphertext`,
   `refresh_token_updated_at`, `email_trusted`; tables `mobile_oauth_codes`, `oauth_reauth_tickets`,
   `password_reset_tokens` must exist with the 0004/0005/0007 columns.
3. Ledger repair (one statement, no schema change):
   `INSERT INTO d1_migrations(name) VALUES ('0004_mobile_oauth_codes.sql'),('0005_oauth_refresh_tokens.sql'),('0006_oauth_email_trusted.sql'),('0007_password_reset_tokens.sql');`
4. `wrangler d1 migrations list a2-workout-pilot --remote` must show exactly `0008`–`0013` pending.
5. `wrangler d1 migrations apply a2-workout-pilot --remote` (additive only: new tables + `ADD COLUMN` with defaults; no
   DROP/RENAME). The currently deployed Build 43 Worker keeps working on the additive schema.
6. Deploy the Build 44 Worker (`npm run cf:deploy`) only after step 5 succeeds. Worker-before-migration is unsafe:
   lifecycle/record/restore routes fail closed with 503 until their tables exist.
7. Post-deploy read-only checks: `/api/health`, schedules show three crons, `X-Robots-Tag` on `app.reptrio.com`,
   `recovery.html` 200, one `ops_digest_*` log line after the next 06:00 UTC.

Rollback: before step 6, nothing user-visible changed (additive schema). After step 6, redeploy the previous version
(`wrangler rollback`); additive columns remain harmless. Data rollback = Time Travel restore to the P4 bookmark (destroys
writes made after it; only with explicit approval).

## 2. Alert routing (existing infrastructure)

- Trigger `0 6 * * *` runs `runOperationalDigest` in its own invocation (read-only, ≤5 queries). The minute purge and
  15-minute maintenance triggers are unchanged.
- Findings: `ACCOUNT_PURGE_OVERDUE` (due >1h), `ACCOUNT_PURGE_CAPACITY` (due backlog >1440 = one owner/min/day),
  `AI_WORK_UNKNOWN`, `AI_WORK_STUCK_RUNNING` (>15 min: the minute cron is not running), `AI_CLEANUP_FAILED`.
- Delivery: ZeptoMail (`sendTransactionalEmail`) to `OPS_ALERT_EMAIL`; counts and opaque work ids only.
  Without a recipient the digest logs `ops_alert_unrouted` (never silent success).
- `observability.enabled = true`: Workers Logs keep `ops_digest_*`, `account_purge_retry/overdue/unavailable` lines.
- Residual: no external dead-man switch. If the scheduler itself stops, no email is sent; the absence of the daily
  `ops_digest_*` log line is the signal. Check it during the first release week.

## 3. UNKNOWN AI upstream reconciliation

Facts (official `openai-node` 7.33.0 resource map): Responses support create / retrieve / delete / cancel / input_items;
**there is no list/search endpoint**. A response whose id was never received cannot be discovered by the Worker.

Mechanism:
- Definite upstream rejection (HTTP 4xx except 408) closes the work row as `RESOLVED` / `UPSTREAM_REJECTED_<status>`
  (no response object was created). 5xx, 408, timeout, network error or unreadable 2xx body stay `UNKNOWN`.
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

## 4. Capacity (per purge invocation, routed SQLite measurement)

| Stored AI responses | D1 statements | Outbound fetches | Total subrequests |
|---|---|---|---|
| 0 | 45 | 0 | 45 |
| 1 | 46 | 2 | 48 |
| 3 | 48 | 6 | 54 |
| 10 | 55 | 20 | 75 |
| 30 | 75 | 60 | 135 |

Apple-linked accounts add one revoke fetch. Limits (Cloudflare docs, 2026-10-14): Free 50 subrequests and 50 D1
queries per invocation, cron CPU 10 ms; Paid 10,000 subrequests (configurable), 1,000 D1 queries, cron CPU 30 s.
Free cannot purge accounts with ≥3 stored AI responses (≥2 with Apple) → P1. Throughput: one owner per minute
(≤1440/day). Current production D1 (read-only `d1 info`): 2.33 MB, 486 write queries/24h.
Sources: https://developers.cloudflare.com/workers/platform/limits/ ,
https://developers.cloudflare.com/d1/platform/limits/
