-- OAuth account linking (issue #12): whether the identity's email is trusted for account linking (1/0) as of its last
-- sign-in — Google: verified AND Google is authoritative for it (@gmail.com, or a Workspace account whose `hd` is the
-- email's domain); Apple: email_verified. Linking another identity to an existing account by email requires that the
-- account's email was proven by the trusted provider identity that created it. Rows from before this migration are
-- NULL (unknown → not proven until that identity signs in again).
ALTER TABLE oauth_accounts ADD COLUMN email_trusted INTEGER;
