-- Additive story-builder data. Empty modules retain the existing Markdown workflow.
ALTER TABLE drafts ADD COLUMN story_blocks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(story_blocks));
ALTER TABLE stories ADD COLUMN story_blocks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(story_blocks));
ALTER TABLE draft_photos ADD COLUMN focal_x REAL NOT NULL DEFAULT 50 CHECK (focal_x BETWEEN 0 AND 100);
ALTER TABLE draft_photos ADD COLUMN focal_y REAL NOT NULL DEFAULT 50 CHECK (focal_y BETWEEN 0 AND 100);
ALTER TABLE story_photos ADD COLUMN focal_x REAL NOT NULL DEFAULT 50 CHECK (focal_x BETWEEN 0 AND 100);
ALTER TABLE story_photos ADD COLUMN focal_y REAL NOT NULL DEFAULT 50 CHECK (focal_y BETWEEN 0 AND 100);
