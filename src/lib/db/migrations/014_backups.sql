-- Nightly backups (epic #25, issue #30). One row per backup attempt, so a restart never repeats a backup that
-- already succeeded and the admin page can show the last success and the last error.
-- day is the UTC date (YYYY-MM-DD) the backup is for; it names the files imconnected-<day>.db / .media.tar.gz.
-- finished_at is NULL while the attempt is running.
-- error is a short message with secrets already removed (never a key, token or JWT).
CREATE TABLE backup_runs (
  id          INTEGER PRIMARY KEY,
  day         TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  started_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL, -- refreshed every minute while running; a row whose heartbeat stopped is an interrupted attempt
  finished_at INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  db_bytes    INTEGER,
  media_bytes INTEGER,
  uploads     INTEGER NOT NULL DEFAULT 0, -- files the Drive folder received in this attempt (0, 1 or 2)
  attempts    INTEGER NOT NULL DEFAULT 0, -- upload tries made (a retried upload counts again)
  error       TEXT
) STRICT;
CREATE INDEX backup_runs_day ON backup_runs(day, ok);
CREATE INDEX backup_runs_started ON backup_runs(started_at);

-- A single row: when backups were first seen configured (the start of the 48 hour clock when none has succeeded
-- yet) and when the admins were last emailed about missing backups (at most once a day).
CREATE TABLE backup_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  configured_since INTEGER,
  last_alert_at    INTEGER
) STRICT;
INSERT INTO backup_state (id) VALUES (1);
