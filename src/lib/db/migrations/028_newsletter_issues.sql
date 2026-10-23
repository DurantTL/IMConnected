-- Newsletter issues (issue #98): which IMConnected newsletter issue a story first appeared in, and where it sat.
-- An issue's date is the day it was sent; the title is optional. Plain columns (no foreign keys, like draft_id): code checks
-- that the issue exists and refuses to delete one that a draft or story still references.
CREATE TABLE newsletter_issues (
  number INTEGER PRIMARY KEY CHECK (number BETWEEN 1 AND 9999),
  date TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE drafts ADD COLUMN newsletter_issue INTEGER CHECK (newsletter_issue IS NULL OR newsletter_issue BETWEEN 1 AND 9999);
ALTER TABLE drafts ADD COLUMN newsletter_position INTEGER CHECK (newsletter_position IS NULL OR newsletter_position BETWEEN 1 AND 999);
ALTER TABLE stories ADD COLUMN newsletter_issue INTEGER CHECK (newsletter_issue IS NULL OR newsletter_issue BETWEEN 1 AND 9999);
ALTER TABLE stories ADD COLUMN newsletter_position INTEGER CHECK (newsletter_position IS NULL OR newsletter_position BETWEEN 1 AND 999);
CREATE INDEX stories_newsletter_issue ON stories (newsletter_issue) WHERE newsletter_issue IS NOT NULL;
CREATE INDEX drafts_newsletter_issue ON drafts (newsletter_issue) WHERE newsletter_issue IS NOT NULL;
