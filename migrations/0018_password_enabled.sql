-- Local password sign-in is an explicit capability, separate from identity provenance.
-- Preserve existing local/legacy password access while leaving known OAuth-created accounts disabled.
ALTER TABLE users ADD COLUMN password_enabled INTEGER DEFAULT NULL CHECK(password_enabled IS NULL OR password_enabled IN (0,1));
UPDATE users SET password_enabled=1 WHERE credential_origin='PASSWORD';
UPDATE users SET password_enabled=0 WHERE credential_origin IN ('GOOGLE','APPLE');
