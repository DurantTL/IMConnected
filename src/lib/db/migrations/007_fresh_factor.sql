-- fresh_at is when the session last proved a second factor (sign-in 2FA, passkey sign-in, or a
-- fresh code for a sensitive change). Admin actions that change accounts need it within 10 minutes.
ALTER TABLE sessions ADD COLUMN fresh_at INTEGER NOT NULL DEFAULT 0;
