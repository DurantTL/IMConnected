-- Stories held off the public pages until the next deploy (epic #25, step 2).
--
-- Until step 4, git is the source of truth and the stories table mirrors the build. When an editor unpublishes a
-- story, the build the server is running still holds its OLD text. Whatever happens next (the dashboard, Studio, git or
-- Pages CMS publishes it again), the old text must not come back; the story returns with an image that contains the
-- unpublish commit, because such an image either leaves the story out (draft: true) or has text published after it.
-- src/lib/story-holds.ts has the rule.
--   unpublish_sha  the commit of the unpublish; NULL when it was not recorded, which keeps the story hidden.
--   unpublish_time GitHub's time of that commit (ms), for the 200-commit window safeguard; NULL means no safeguard.
--   released_at    set (instead of deleting the row) when an image containing the unpublish commit has released the hold,
--                  so the dashboard can tell a released hold from a hold that was never recorded.
--   build_marker   the marker (story-sync.ts) of the build running at unpublish time; used only by builds that have
--                  no commit list (local and dev builds). NULL when it could not be computed.
CREATE TABLE story_holds (
  slug           TEXT PRIMARY KEY,
  build_marker   TEXT,
  unpublish_sha  TEXT,
  unpublish_time INTEGER,
  released_at    INTEGER,
  created_at     INTEGER NOT NULL
) STRICT;

-- Stories unpublished before this migration need no hold: the image that runs it already has draft: true for them.
-- Record a RELEASED hold for each so the dashboard can still publish them again (it refuses an unpublished draft that
-- has no hold row at all).
INSERT INTO story_holds (slug, build_marker, unpublish_sha, unpublish_time, released_at, created_at)
SELECT slug, NULL, NULL, NULL, MAX(unpublished_at), MAX(unpublished_at)
FROM drafts WHERE slug IS NOT NULL AND unpublished_at IS NOT NULL GROUP BY slug;
