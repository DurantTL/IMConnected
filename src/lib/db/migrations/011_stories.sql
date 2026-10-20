-- Stories and their photos in the database (epic #25, step 1).
--
-- Until step 4 of the epic, git stays the source of truth for published stories and this table is a MIRROR of
-- the built site (src/lib/story-sync.ts refills it from the built content collection on the first database
-- open after a start). Nothing reads it for public pages yet. Optional text fields are NULL when a story does
-- not have them, so a mirrored story has exactly the fields of the content schema (src/content.config.ts).
-- `photos` and `photo_alts` are JSON arrays of text, exactly as in the Markdown front matter.

CREATE TABLE stories (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  dek          TEXT,
  section      TEXT NOT NULL,
  area         TEXT,
  story_column TEXT,
  author       TEXT NOT NULL,
  author_title TEXT,
  church       TEXT,
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- YYYY-MM-DD
  image        TEXT,
  image_alt    TEXT,
  photo_credit TEXT,
  photos       TEXT NOT NULL DEFAULT '[]',
  photo_alts   TEXT NOT NULL DEFAULT '[]',
  featured     INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  draft        INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'unpublished')),
  source       TEXT NOT NULL DEFAULT 'git' CHECK (source IN ('git', 'form', 'studio', 'editor', 'agent')),
  draft_id     INTEGER, -- the drafts row it came from; a plain column on purpose: rebuilding drafts (as migration 010 did) must not NULL it
  published_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  published_by INTEGER, -- the users row; plain for the same reason, the code checks it
  -- sha256 of what the row was built from; the git sync skips a story whose hash has not changed.
  content_hash TEXT
) STRICT;

CREATE UNIQUE INDEX stories_slug ON stories(slug);
CREATE INDEX stories_listing ON stories(section, area, date);
CREATE INDEX stories_status_date ON stories(status, date);
CREATE INDEX stories_draft ON stories(draft_id) WHERE draft_id IS NOT NULL;

-- One row per photo. `path` is relative to DATA_DIR/media (served as /media/<path>); a photo that is not a file
-- we hold (a remote https:// photo, or a local file the sync could not copy) keeps its address in `url`.
CREATE TABLE story_photos (
  id       INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('lead', 'gallery')),
  path     TEXT,
  url      TEXT,
  alt      TEXT NOT NULL DEFAULT '',
  sha256   TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  bytes    INTEGER, -- size of the file, so the sync can tell an unchanged photo without reading it
  CHECK ((path IS NOT NULL AND url IS NULL AND sha256 IS NOT NULL) OR (path IS NULL AND url IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX story_photos_position ON story_photos(story_id, position);
