-- IDs can be reused after deletion; a random identity prevents history binding a replacement image.
ALTER TABLE draft_photos ADD COLUMN media_key TEXT;
UPDATE draft_photos SET media_key=lower(hex(randomblob(16))) WHERE media_key IS NULL;
CREATE UNIQUE INDEX draft_photos_media_key ON draft_photos(media_key);
CREATE TRIGGER draft_photos_identity AFTER INSERT ON draft_photos WHEN NEW.media_key IS NULL
BEGIN
  UPDATE draft_photos SET media_key=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TABLE draft_revisions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=600000)
);
CREATE INDEX draft_revisions_draft ON draft_revisions(draft_id,id);
