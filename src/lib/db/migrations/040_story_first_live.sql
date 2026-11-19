-- When a story first went live on the site (ms). Never moved by edits, republishing or unpublish/republish
-- (writeStory only fills it when empty). Used by the Studio list (uploadedAt, sort=uploaded).
-- Backfill: the earliest of the story's published_at, its draft's first-publish stamp and the first publish audit
-- entry for its draft (audit target is "draft:<id>"; drafts.slug is unique); the draft's creation time only when none is known.
ALTER TABLE stories ADD COLUMN first_live_at INTEGER;

UPDATE stories SET rev = rev + 1, first_live_at = COALESCE(
  (SELECT MIN(c) FROM (
    SELECT stories.published_at AS c
    UNION ALL SELECT NULLIF(d.submitter_notified_at, 0) FROM drafts d WHERE d.slug = stories.slug
    UNION ALL SELECT MIN(a.at) FROM audit_log a JOIN drafts d ON a.target = 'draft:' || d.id
      WHERE d.slug = stories.slug AND a.action IN ('draft.publish', 'draft.published_studio', 'draft.studio_overwrote_live')
  ) WHERE c IS NOT NULL AND c > 0),
  -- Last resort only: a draft is always created before it is published, so its creation time would otherwise always win.
  (SELECT d.created_at FROM drafts d WHERE d.slug = stories.slug)
);
