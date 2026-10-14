// Workers Free safety margins (https://developers.cloudflare.com/workers/platform/limits/ ,
// https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/):
// 50 external subrequests and 50 D1 queries per invocation; D1 100,000 rows written/day (reset 00:00 UTC).
// Purge invocations use <= 40 OpenAI deletes and <= 40 D1 statements; background writes are capped per UTC day
// (60,000 purge + 15,000 maintenance) so at least 25,000 rows/day always remain for the app (production 2026-10-14:
// ~500 writes/day). An account whose final erase would exceed the purge cap is held (ACCOUNT_PURGE_PLAN_CAPACITY,
// alerted) for the operator procedure (runbook §4c); user decision 2026-10-14.
export const PURGE_UPSTREAM_DELETES = 40;
export const PURGE_UPSTREAM_TIME_MS = 60_000;
export const PURGE_DAILY_ROWS_WRITTEN = 60_000;
export const MAINTENANCE_DAILY_ROWS_WRITTEN = 15_000;
