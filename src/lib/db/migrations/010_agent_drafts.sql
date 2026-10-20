-- AI agent stories (POST /api/agent/stories): drafts gain source 'agent', the URL of the original post
-- (source_url) and the agent's note to the editors (agent_note).
--
-- SQLite cannot change a CHECK constraint, so `drafts` is rebuilt. Migrations run inside a transaction with
-- foreign keys on, where DROP TABLE on a parent would cascade-delete its photos. So the child table
-- (draft_photos) is rebuilt first and dropped before its parent, and nothing is ever deleted from a table that
-- still has children. Row ids and every column are copied unchanged.

CREATE TABLE drafts_new (
  id                  INTEGER PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN ('new', 'in_review', 'published', 'rejected')),
  source              TEXT NOT NULL CHECK (source IN ('form', 'studio', 'editor', 'agent')),
  title               TEXT NOT NULL DEFAULT '',
  dek                 TEXT NOT NULL DEFAULT '',
  section             TEXT NOT NULL DEFAULT 'news',
  area                TEXT NOT NULL DEFAULT '',
  story_column        TEXT NOT NULL DEFAULT '',
  author              TEXT NOT NULL DEFAULT '',
  author_title        TEXT NOT NULL DEFAULT '',
  church              TEXT NOT NULL DEFAULT '',
  date                TEXT NOT NULL DEFAULT '',
  photo_credit        TEXT NOT NULL DEFAULT '',
  featured            INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  body                TEXT NOT NULL DEFAULT '',
  slug                TEXT,
  published_commit    TEXT,
  submitter_name      TEXT,
  submitter_email     TEXT,
  submitter_phone     TEXT,
  submitter_church    TEXT,
  email_verified      INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  reject_note         TEXT,
  rejected_at         INTEGER,
  created_at          INTEGER NOT NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at          INTEGER NOT NULL,
  updated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at        INTEGER,
  published_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  unpublished_at      INTEGER,
  studio_overwrote_at INTEGER,
  published_via_studio INTEGER NOT NULL DEFAULT 0 CHECK (published_via_studio IN (0, 1)),
  source_url          TEXT,
  agent_note          TEXT
) STRICT;

INSERT INTO drafts_new (id, status, source, title, dek, section, area, story_column, author, author_title, church, date, photo_credit, featured, body,
    slug, published_commit, submitter_name, submitter_email, submitter_phone, submitter_church, email_verified, reject_note, rejected_at,
    created_at, created_by, updated_at, updated_by, published_at, published_by, unpublished_at, studio_overwrote_at, published_via_studio)
  SELECT id, status, source, title, dek, section, area, story_column, author, author_title, church, date, photo_credit, featured, body,
    slug, published_commit, submitter_name, submitter_email, submitter_phone, submitter_church, email_verified, reject_note, rejected_at,
    created_at, created_by, updated_at, updated_by, published_at, published_by, unpublished_at, studio_overwrote_at, published_via_studio
  FROM drafts;

CREATE TABLE draft_photos_new (
  id         INTEGER PRIMARY KEY,
  draft_id   INTEGER NOT NULL REFERENCES drafts_new(id) ON DELETE CASCADE,
  path       TEXT,
  url        TEXT,
  ext        TEXT,
  alt        TEXT NOT NULL DEFAULT '',
  caption    TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK ((path IS NOT NULL AND url IS NULL) OR (path IS NULL AND url IS NOT NULL))
) STRICT;
INSERT INTO draft_photos_new (id, draft_id, path, url, ext, alt, caption, position, created_at)
  SELECT id, draft_id, path, url, ext, alt, caption, position, created_at FROM draft_photos;

DROP TABLE draft_photos;
DROP TABLE drafts;
ALTER TABLE drafts_new RENAME TO drafts;
ALTER TABLE draft_photos_new RENAME TO draft_photos;

CREATE UNIQUE INDEX drafts_slug ON drafts(slug) WHERE slug IS NOT NULL;
CREATE INDEX drafts_status_created ON drafts(status, created_at);
CREATE INDEX draft_photos_draft ON draft_photos(draft_id, position);
-- One draft per original post: the agent API finds its draft by this URL (and a race can't make two).
CREATE UNIQUE INDEX drafts_agent_source_url ON drafts(source_url) WHERE source = 'agent' AND source_url IS NOT NULL;
