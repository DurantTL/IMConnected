-- Per-photo captions (issue #84): visible text under a photo, up to 300 characters. Alt text (the existing `alt` column)
-- describes the image for screen readers; the caption is shown to everyone.
-- draft_photos.caption already exists (migration 004, kept by 010) and held only Studio's caption, which was never shown;
-- from here on it is the visible caption. (The public submit form's optional "Photo caption" has always been stored in
-- draft_photos.alt, not here; that is unchanged.) Only story_photos is new. Existing story rows keep an empty caption,
-- so nothing on a published page changes.
ALTER TABLE story_photos ADD COLUMN caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 300);
