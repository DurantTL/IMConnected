-- users.id is never reused: a revoked invite deletes its user row, and audit targets are text like
-- "user:<id>", so a reused id would merge two people's histories. last_id is the highest id ever handed
-- out; new users take last_id + 1 through allocateUserId() in db-core.mjs (inside the inserting transaction).
-- Seeded from the highest id in users and the highest user:<n> already named in the audit log.
CREATE TABLE user_id_mark (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  last_id INTEGER NOT NULL
) STRICT;
INSERT INTO user_id_mark (id, last_id)
SELECT 1, MAX(
  COALESCE((SELECT MAX(id) FROM users), 0),
  COALESCE((SELECT MAX(CAST(substr(target, 6) AS INTEGER)) FROM audit_log WHERE target GLOB 'user:[0-9]*'), 0)
);
