-- Submitter "your story is published" email (issue #121): when the draft was first published. NULL means never.
-- Set with COALESCE inside the publish transaction for every draft, so only a draft's first publish can send the one
-- email (to a confirmed public-form submitter). Drafts already published before this migration are marked so a later
-- republish never emails them.
ALTER TABLE drafts ADD COLUMN submitter_notified_at INTEGER;
UPDATE drafts SET submitter_notified_at = COALESCE(published_at, 0) WHERE published_commit IS NOT NULL;
