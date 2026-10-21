-- The database becomes the source of truth for stories (epic #25, step 4).
--
-- * stories.edited_at: the last time a person changed the story through the dashboard or Studio (publish, publish
--   changes, unpublish). NULL for a story that has only ever been imported from git. scripts/import-git-stories.mjs
--   refuses to overwrite a story that has it (unless --force).
-- * app_state: small key/value flags. 'git_adopted_at' is set once, by the first start of this version, after the
--   built stories have been imported (src/lib/story-adopt.ts). After that the build is never read for content again.
-- * story_holds (migration 012) is no longer written or read, except by that one adoption pass. It is RENAMED to
--   story_holds_retired: code from before this step looks the old name up first (getHold / listHolds) and fails, so an old
--   image that is started against this database cannot mirror the build over it. A later migration can drop it.
-- * stories.rev: bumped by every write made by step-4 code. After the adoption flag is set, a trigger refuses any UPDATE of
--   a story that does not bump it, which is how the old image's mirror (its upsert and its "left the build" unpublish,
--   neither of which knows `rev`) is stopped from reverting or unpublishing rows.
ALTER TABLE stories ADD COLUMN edited_at INTEGER;
ALTER TABLE stories ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Stories a person unpublished in the dashboard before this migration count as edited in the dashboard.
UPDATE stories SET edited_at = COALESCE(
  (SELECT MAX(unpublished_at) FROM drafts d WHERE d.slug = stories.slug AND d.unpublished_at IS NOT NULL),
  (SELECT created_at FROM story_holds h WHERE h.slug = stories.slug))
WHERE slug IN (SELECT slug FROM drafts WHERE slug IS NOT NULL AND unpublished_at IS NOT NULL)
   OR slug IN (SELECT slug FROM story_holds);

ALTER TABLE story_holds RENAME TO story_holds_retired;

CREATE TRIGGER stories_guard_old_writers BEFORE UPDATE ON stories
WHEN NEW.rev = OLD.rev AND EXISTS (SELECT 1 FROM app_state WHERE key = 'git_adopted_at')
BEGIN
  SELECT RAISE(ABORT, 'stories are written by the database now: a pre-step-4 image must not run against this database');
END;
