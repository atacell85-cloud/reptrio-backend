-- Build 49 B49-001: Google Places Nearby Search (New) allowance. Additive only; safe with Workers that predate it (they never
-- read these tables) and with 0017. Applying this migration enables nothing: the Nearby route stays closed
-- (PLACES_NOT_CONFIGURED) until PLACES_NEARBY_QUOTA_POLICY='first-use-24h' AND PLACES_NEARBY_PROJECT_DAILY_CAP are set on the
-- Worker (separately approved production steps). Production apply needs explicit permission.
-- places_nearby_usage: one row per account (5 dispatched requests per 24h window from the first counted request, all devices).
-- places_nearby_project_usage: one row per UTC day, the project-wide spend ceiling. No search text, coordinates, Google
-- content or device is stored. Account erasure removes the per-user row two ways that do not depend on the FK pragma: the user FK cascade AND the trigger below (fires on any DELETE of the users row, also on the FK-off purge paths). The trigger replaces an explicit application DELETE because the final-erase invocation is already at its 40-query Free-plan budget (scripts/account-lifecycle-test.mjs).
CREATE TABLE IF NOT EXISTS places_nearby_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL CHECK(window_end_ms > window_start_ms),
  dispatched INTEGER NOT NULL CHECK(dispatched >= 0),
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS places_nearby_project_usage (
  day_start_ms INTEGER PRIMARY KEY,
  dispatched INTEGER NOT NULL CHECK(dispatched >= 0)
);
CREATE TRIGGER IF NOT EXISTS places_nearby_usage_erase AFTER DELETE ON users
BEGIN
  DELETE FROM places_nearby_usage WHERE user_id = OLD.id;
END;
