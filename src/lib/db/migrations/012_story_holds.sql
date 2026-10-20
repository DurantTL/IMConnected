-- Stories held off the public pages until the next deploy (epic #25, step 2).
--
-- Until step 4, git is the source of truth and the stories table mirrors the build. When an editor unpublishes a
-- story, the build the server is running still holds its OLD text. Whatever happens next (the dashboard, Studio, git or
-- Pages CMS publishes it again), the old text must not come back; the story returns with an image that contains the
-- unpublish commit, because such an image either leaves the story out (draft: true) or has text published after it.
-- src/lib/story-holds.ts has the rule.
--   unpublish_sha  the commit of the unpublish; NULL when it was not recorded, which keeps the story hidden.
--   build_marker   the marker (story-sync.ts) of the build running at unpublish time; used only by builds that have
--                  no commit list (local and dev builds). NULL when it could not be computed.
CREATE TABLE story_holds (
  slug           TEXT PRIMARY KEY,
  build_marker   TEXT,
  unpublish_sha  TEXT,
  created_at     INTEGER NOT NULL
) STRICT;
