-- hash is a self-describing string: scrypt$N$r$p$<salt b64url>$<hash b64url>.
CREATE TABLE password_credentials (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- secret_enc is AES-256-GCM (keyed from AUTH_SECRET), never the plain secret. A row with
-- confirmed_at NULL is an enrollment in progress. last_used_step is the 30 s time step of the last
-- accepted code (replay protection).
CREATE TABLE totp_credentials (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc     TEXT NOT NULL,
  confirmed_at   INTEGER,
  last_used_step INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
) STRICT;

-- code_hash is an HMAC-SHA256 (keyed from AUTH_SECRET) of the normalized code.
CREATE TABLE recovery_codes (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER
) STRICT;
CREATE INDEX recovery_codes_user_id ON recovery_codes(user_id);

-- key is "ip:<ip>" or "acct:<sha256 of the email>"; ok = 1 for a success, 0 for a failure.
CREATE TABLE login_attempts (
  id  INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  at  INTEGER NOT NULL,
  ok  INTEGER NOT NULL CHECK (ok IN (0, 1))
) STRICT;
CREATE INDEX login_attempts_key_at ON login_attempts(key, at);
