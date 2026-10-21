-- Story photo layouts (issue #35). `photo_layout` says how a story's photos are arranged on its page:
-- one | twoUp | heroGrid | mosaic | stack (the story block layouts of IMConnected Studio). 'one' is the look every story
-- had before this migration, so existing rows are unchanged. Drafts carry the choice too, so an editor's pick survives
-- until the draft is published.
--
-- Both are plain ADD COLUMNs with a default (no UPDATE of `stories`, so migration 015's rev guard is not involved).
ALTER TABLE stories ADD COLUMN photo_layout TEXT NOT NULL DEFAULT 'one' CHECK (photo_layout IN ('one', 'twoUp', 'heroGrid', 'mosaic', 'stack'));
ALTER TABLE drafts ADD COLUMN photo_layout TEXT NOT NULL DEFAULT 'one' CHECK (photo_layout IN ('one', 'twoUp', 'heroGrid', 'mosaic', 'stack'));
