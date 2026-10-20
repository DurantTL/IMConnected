-- Set when IMConnected Studio published over a story whose linked draft still had unpublished edits
-- (new / in review). The editor sees a notice on that draft; publishing or reloading the draft clears it.
ALTER TABLE drafts ADD COLUMN studio_overwrote_at INTEGER;

-- 1 while the live version of the story was published by IMConnected Studio (published_by is NULL then);
-- a dashboard publish clears it. The publisher label ("IMConnected Studio") keys on this.
ALTER TABLE drafts ADD COLUMN published_via_studio INTEGER NOT NULL DEFAULT 0 CHECK (published_via_studio IN (0, 1));
