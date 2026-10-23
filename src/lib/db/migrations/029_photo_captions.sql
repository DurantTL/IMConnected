-- Per-photo captions (issue #84): visible text under a photo, up to 300 characters. Alt text (the existing `alt` column)
-- describes the image for screen readers; the caption is shown to everyone.
-- draft_photos.caption already exists (migration 004, kept by 010: it held the submit form's optional caption and
-- Studio's caption, neither of which was shown). Those values were never public, so from here on they are the caption;
-- only story_photos is new. Existing story rows keep an empty caption, so nothing on a published page changes.
ALTER TABLE story_photos ADD COLUMN caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 300);
