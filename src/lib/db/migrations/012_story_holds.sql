-- Stories held off the public pages until the next deploy (epic #25, step 2).
--
-- Until step 4, git is the source of truth and the stories table mirrors the build. When an editor unpublishes a
-- story, the build the server is running still holds its OLD text. If the editor then fixes the text and publishes
-- again, the new text only reaches the site with the next deploy, so the story must stay hidden until then rather
-- than come back with the old text. A hold records the build (its marker, see story-sync.ts) that was running when
-- the story was unpublished. It applies while that same build is running and is dropped by the first sync of a
-- different build.
CREATE TABLE story_holds (
  slug         TEXT PRIMARY KEY,
  build_marker TEXT NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;
