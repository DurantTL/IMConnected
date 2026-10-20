-- Story drafts. Every story is edited here before it is committed to git by the publish action.
-- status: new (just arrived), in_review (an editor has started), published, rejected.
-- source: form (public submit form), studio (Studio publish history), editor (written in /admin).
-- date is YYYY-MM-DD. story_column is the "column" frontmatter field (COLUMN is an SQL keyword).
-- slug is set at publish (or when an existing story is loaded for editing) and is unique.
-- submitter_* is personal data: shown to signed-in editors only, never logged, never committed.
-- updated_at is also the optimistic-lock version: a save that carries an older value is refused.
-- rejected_at starts the 30 day photo retention for rejected drafts. A story is live when published_commit is
-- set and unpublished_at is NULL (an Unpublish sets it; the next publish clears it).
CREATE TABLE drafts (
  id               INTEGER PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('new', 'in_review', 'published', 'rejected')),
  source           TEXT NOT NULL CHECK (source IN ('form', 'studio', 'editor')),
  title            TEXT NOT NULL DEFAULT '',
  dek              TEXT NOT NULL DEFAULT '',
  section          TEXT NOT NULL DEFAULT 'news',
  area             TEXT NOT NULL DEFAULT '',
  story_column     TEXT NOT NULL DEFAULT '',
  author           TEXT NOT NULL DEFAULT '',
  author_title     TEXT NOT NULL DEFAULT '',
  church           TEXT NOT NULL DEFAULT '',
  date             TEXT NOT NULL DEFAULT '',
  photo_credit     TEXT NOT NULL DEFAULT '',
  featured         INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  body             TEXT NOT NULL DEFAULT '',
  slug             TEXT,
  published_commit TEXT,
  submitter_name   TEXT,
  submitter_email  TEXT,
  submitter_phone  TEXT,
  submitter_church TEXT,
  email_verified   INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  reject_note      TEXT,
  rejected_at      INTEGER,
  created_at       INTEGER NOT NULL,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at       INTEGER NOT NULL,
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at     INTEGER,
  published_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  unpublished_at   INTEGER
) STRICT;
CREATE UNIQUE INDEX drafts_slug ON drafts(slug) WHERE slug IS NOT NULL;
CREATE INDEX drafts_status_created ON drafts(status, created_at);

-- A photo is either an upload (path = "<draft id>/<random name>.<ext>" under DATA_DIR/uploads/, never
-- under public/) or an image the story already has on the site (url = "/images/..." or "https://...").
-- position 0 is the lead image.
CREATE TABLE draft_photos (
  id         INTEGER PRIMARY KEY,
  draft_id   INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  path       TEXT,
  url        TEXT,
  ext        TEXT,
  alt        TEXT NOT NULL DEFAULT '',
  caption    TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK ((path IS NOT NULL AND url IS NULL) OR (path IS NULL AND url IS NOT NULL))
) STRICT;
CREATE INDEX draft_photos_draft ON draft_photos(draft_id, position);
