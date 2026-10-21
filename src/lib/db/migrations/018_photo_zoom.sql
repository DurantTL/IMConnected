-- Non-destructive crop zoom. Focal X/Y provide the pan position; the original file stays intact.
ALTER TABLE draft_photos ADD COLUMN zoom REAL NOT NULL DEFAULT 1 CHECK (zoom BETWEEN 1 AND 3);
ALTER TABLE story_photos ADD COLUMN zoom REAL NOT NULL DEFAULT 1 CHECK (zoom BETWEEN 1 AND 3);
