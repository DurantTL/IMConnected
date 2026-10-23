-- Photo replace lineage (issue 87): a replaced file gets a new media_key, so a revision taken before the replace names a key that no
-- longer exists. This maps the old key to the slot's newest key so restoring that revision finds the same slot (and keeps its place,
-- markers, module references and metadata) instead of treating it as a deleted photo. Keys only; no file is ever resurrected.
CREATE TABLE draft_photo_key_aliases (
  old_key  TEXT PRIMARY KEY,
  new_key  TEXT NOT NULL,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX draft_photo_key_aliases_new ON draft_photo_key_aliases(new_key);
CREATE INDEX draft_photo_key_aliases_draft ON draft_photo_key_aliases(draft_id);
