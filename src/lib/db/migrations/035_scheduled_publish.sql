-- Scheduled publishing (issue #124). A person schedules an open draft; the server only carries it out later.
--   publish_at           when to publish (ms since the epoch), NULL = not scheduled
--   publish_at_by        the user who scheduled it (the actor of the later publish)
--   publish_claimed_at   the scheduler's atomic claim (ms): one process takes a due draft by setting it; a claim older than
--                        5 minutes is treated as abandoned, so a crashed process never blocks the draft for good
--   publish_fail_count   failed scheduled attempts; the scheduler stops at 3 until an editor reschedules
--   publish_error        the stable error code of the last failed attempt (never message text, never secrets)
--   publish_error_at     when that attempt failed
--   suggested_publish_at the AI agent's suggestion (ms). Advice only: nothing ever publishes from it.
ALTER TABLE drafts ADD COLUMN publish_at INTEGER;
ALTER TABLE drafts ADD COLUMN publish_at_by INTEGER;
ALTER TABLE drafts ADD COLUMN publish_claimed_at INTEGER;
ALTER TABLE drafts ADD COLUMN publish_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN publish_error TEXT;
ALTER TABLE drafts ADD COLUMN publish_error_at INTEGER;
ALTER TABLE drafts ADD COLUMN suggested_publish_at INTEGER;
CREATE INDEX drafts_publish_at ON drafts (publish_at) WHERE publish_at IS NOT NULL;
