-- Set when IMConnected Studio published over a story whose linked draft still had unpublished edits
-- (new / in review). The editor sees a notice on that draft; publishing or reloading the draft clears it.
ALTER TABLE drafts ADD COLUMN studio_overwrote_at INTEGER;
