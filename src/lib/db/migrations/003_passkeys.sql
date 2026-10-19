-- id is the credential id (base64url). public_key is the COSE public key (base64url); it is public
-- information, not a secret. counter is the authenticator's signature counter (0 = it doesn't count).
-- transports is a JSON array or NULL.
CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   TEXT NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,
  device_name  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;
CREATE INDEX passkeys_user_id ON passkeys(user_id);

-- One row per WebAuthn ceremony in flight. Single use (consumed by DELETE) and good for 5 minutes.
-- user_id is NULL for the passwordless sign-in ceremony, where nobody is known yet.
CREATE TABLE webauthn_challenges (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'second_factor', 'fresh')),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX webauthn_challenges_challenge ON webauthn_challenges(challenge);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges(expires_at);
