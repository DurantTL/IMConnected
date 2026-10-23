-- Key points (issue #117): up to three short plain-text bullets per story, a JSON array of strings.
-- Stored raw and escaped on output (never HTML or Markdown). Rules live in src/lib/key-points.ts.
-- Existing rows get an empty list, so nothing on a published page changes.
ALTER TABLE drafts ADD COLUMN key_points TEXT NOT NULL DEFAULT '[]';
ALTER TABLE stories ADD COLUMN key_points TEXT NOT NULL DEFAULT '[]';
