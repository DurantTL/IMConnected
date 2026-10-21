-- The database becomes the source of truth for stories (epic #25, step 4).
--
-- * stories.edited_at: the last time a person changed the story through the dashboard or Studio (publish, publish
--   changes, unpublish). NULL for a story that has only ever been imported from git. scripts/import-git-stories.mjs
--   refuses to overwrite a story that has it (unless --force).
-- * app_state: small key/value flags. 'git_adopted_at' is set once, by the first start of this version, after the
--   built stories have been imported (src/lib/story-adopt.ts). After that the build is never read for content again.
-- * story_holds (migration 012) is no longer written or read, except by that one adoption pass; it stays as an inert
--   record and can be dropped by a later migration once every server has adopted.
ALTER TABLE stories ADD COLUMN edited_at INTEGER;

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
