CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  status      TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- id is the SHA-256 (hex) of the session token; the token itself is never stored.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  mfa_passed   INTEGER NOT NULL DEFAULT 0 CHECK (mfa_passed IN (0, 1))
) STRICT;
CREATE INDEX sessions_user_id ON sessions(user_id);

-- token_hash is the SHA-256 (hex) of the invite token.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
) STRICT;
CREATE INDEX invites_user_id ON invites(user_id);

-- detail is JSON and must never hold secrets or personal data beyond the acting editor's id.
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT,
  ip      TEXT
) STRICT;
CREATE INDEX audit_log_at ON audit_log(at);
