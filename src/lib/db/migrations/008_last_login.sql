-- users.last_login_at is set when a sign-in completes (see audit()), so "Last sign-in" on the Editors page
-- is one column read and survives the 2-year audit retention. Backfilled from the audit log.
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
UPDATE users SET last_login_at = (SELECT MAX(a.at) FROM audit_log a WHERE a.user_id = users.id AND a.action = 'auth.login');
