-- Per-editor setting: "Email me when a story is submitted" (My account). On by default.
ALTER TABLE users ADD COLUMN notify_submissions INTEGER NOT NULL DEFAULT 1 CHECK (notify_submissions IN (0, 1));
