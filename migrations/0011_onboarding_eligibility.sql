-- Additive only: existing accounts remain ineligible; no progress or completion state.
ALTER TABLE users ADD COLUMN onboarding_eligible INTEGER NOT NULL DEFAULT 0;
