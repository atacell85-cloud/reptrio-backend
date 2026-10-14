// Workers Free safety margins (https://developers.cloudflare.com/workers/platform/limits/ ,
// https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/):
// 50 external subrequests and 50 D1 queries per invocation; D1 100,000 rows written/day (reset 00:00 UTC).
// Purge invocations use <= 40 OpenAI deletes and <= 40 D1 statements; background writes are capped per UTC day so
// at least half of the daily write quota always remains for the app.
export const PURGE_UPSTREAM_DELETES = 40;
export const PURGE_UPSTREAM_TIME_MS = 60_000;
export const PURGE_DAILY_ROWS_WRITTEN = 25_000;
export const MAINTENANCE_DAILY_ROWS_WRITTEN = 25_000;
