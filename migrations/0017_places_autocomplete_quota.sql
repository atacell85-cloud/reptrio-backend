-- Build 48 B48-C: per-user Google Places Autocomplete allowance (100 dispatched requests per window, all devices).
-- Additive only; safe with 0016 and with Workers that predate it (they never read it). One row per account: the
-- current window and how many Autocomplete requests were actually sent upstream in it. Place ID verification is never
-- counted. No search text, Google content, device or location is stored. The user FK cascades and account erasure
-- deletes the row explicitly (also on FK-off paths). The reset boundary is a release-gated policy (worker/places-quota.js);
-- applying this migration does not enable any quota. Production apply needs explicit permission.
CREATE TABLE IF NOT EXISTS places_autocomplete_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL CHECK(window_end_ms > window_start_ms),
  dispatched INTEGER NOT NULL CHECK(dispatched >= 0),
  updated_ms INTEGER NOT NULL
);
