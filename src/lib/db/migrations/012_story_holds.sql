-- Stories held off the public pages until the next deploy (epic #25, step 2).
--
-- Until step 4, git is the source of truth and the stories table mirrors the build. When an editor unpublishes a
-- story, the build the server is running still holds its OLD text. If the editor then fixes the text and publishes
-- again, the new text only reaches the site with a deploy that contains the republish commit, so the story must stay
-- hidden until then rather than come back with the old text (src/lib/story-holds.ts has the rule).
--   republish_sha  the commit of the dashboard's republish; NULL while the story is only unpublished (or when the
--                  republish was not recorded), which keeps it hidden.
--   build_marker   the marker (story-sync.ts) of the build running at unpublish time; used only by builds that have
--                  no commit list (local and dev builds). NULL when it could not be computed.
CREATE TABLE story_holds (
  slug           TEXT PRIMARY KEY,
  build_marker   TEXT,
  republish_sha  TEXT,
  created_at     INTEGER NOT NULL
) STRICT;
