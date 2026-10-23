-- More story photo layouts (issue #85): `carousel` and `threeUp` join one | twoUp | heroGrid | mosaic | stack.
-- Migration 016 added photo_layout with a CHECK that lists the five old values, and SQLite cannot alter a CHECK in place.
-- Rebuilding `stories` would mean recreating its indexes, foreign keys and the migration 015 guard trigger, so the column
-- itself is replaced: add the same column under a new name with the wider CHECK, copy every value across, drop the old
-- column and rename the new one. Every row keeps its layout; the new column sits at the end of the table (all code names its
-- columns). The copy into `stories` sets rev = rev + 1, as migration 015's guard requires of every UPDATE of `stories`.
ALTER TABLE stories ADD COLUMN photo_layout_v2 TEXT NOT NULL DEFAULT 'one' CHECK (photo_layout_v2 IN ('one', 'twoUp', 'heroGrid', 'mosaic', 'stack', 'carousel', 'threeUp'));
UPDATE stories SET photo_layout_v2 = photo_layout, rev = rev + 1;
ALTER TABLE stories DROP COLUMN photo_layout;
ALTER TABLE stories RENAME COLUMN photo_layout_v2 TO photo_layout;

ALTER TABLE drafts ADD COLUMN photo_layout_v2 TEXT NOT NULL DEFAULT 'one' CHECK (photo_layout_v2 IN ('one', 'twoUp', 'heroGrid', 'mosaic', 'stack', 'carousel', 'threeUp'));
UPDATE drafts SET photo_layout_v2 = photo_layout;
ALTER TABLE drafts DROP COLUMN photo_layout;
ALTER TABLE drafts RENAME COLUMN photo_layout_v2 TO photo_layout;
