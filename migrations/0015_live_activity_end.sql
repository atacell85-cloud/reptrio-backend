-- Build 45 B45-APNs-01 CANDIDATE (feasibility branch only; not applied to production, not wired into worker/index.js).
-- One row per (user, workout): the Live Activity push token and the server-side end deadline (last meaningful activity
-- + 30 minutes). Additive only. The user FK cascades, so account deletion removes the rows with the user.
CREATE TABLE IF NOT EXISTS live_activity_end (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_id TEXT NOT NULL,
  push_token TEXT NOT NULL,
  -- 'auto' tries production first, then sandbox on BadDeviceToken (development-signed builds get sandbox tokens) or
  -- BadEnvironmentKeyIdInToken (a Sandbox-only key).
  apns_env TEXT NOT NULL CHECK(apns_env IN ('sandbox','production','auto')),
  activity_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  -- DEAD: APNs rejected this token (only a new token re-arms). FAILED: retries exhausted (newer activity re-arms).
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENDING','SENT','FAILED','DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_ms INTEGER,
  claimed_ms INTEGER,
  last_error TEXT,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id, workout_id)
);
-- The minute step seeks due rows instead of scanning.
CREATE INDEX IF NOT EXISTS live_activity_end_due ON live_activity_end(state, end_ms);
