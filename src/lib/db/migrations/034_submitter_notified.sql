-- Submitter "your story is published" email (issue #121): the time the one email was claimed for a draft.
-- NULL means not sent yet. Claimed with a single conditional UPDATE, so a retry, a republish or two concurrent
-- publishes can never send it twice. Drafts that were already published before this migration are marked so a
-- later republish never emails them.
ALTER TABLE drafts ADD COLUMN submitter_notified_at INTEGER;
UPDATE drafts SET submitter_notified_at = COALESCE(published_at, 0) WHERE published_commit IS NOT NULL;
