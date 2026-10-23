-- Issue #136: the Columns section is merged into Features, and column names are retired: story_column is emptied on drafts and
-- stories (the database column itself stays; nothing reads or writes a non-empty value any more).
-- Primary section 'columns' becomes 'features'; "columns" leaves every additional_sections list, and 'features' leaves a list
-- whose story just became Features-primary (a primary is never also an extra). Nothing else is touched: slugs, dates, bodies,
-- photos and the search index stay as they are. The stories guard (migration 015) requires every UPDATE to bump rev.
-- Draft revision payloads are left as saved; restoring one that says "columns" reads it as "features" (draft-revisions.ts).
UPDATE stories SET
  additional_sections = (SELECT json_group_array(value) FROM json_each(stories.additional_sections)
                         WHERE value <> 'columns' AND NOT (stories.section = 'columns' AND value = 'features')),
  section = CASE WHEN section = 'columns' THEN 'features' ELSE section END,
  story_column = '',
  rev = rev + 1
WHERE section = 'columns' OR COALESCE(story_column, '') <> '' OR EXISTS (SELECT 1 FROM json_each(stories.additional_sections) WHERE value = 'columns');

UPDATE drafts SET
  additional_sections = (SELECT json_group_array(value) FROM json_each(drafts.additional_sections)
                         WHERE value <> 'columns' AND NOT (drafts.section = 'columns' AND value = 'features')),
  section = CASE WHEN section = 'columns' THEN 'features' ELSE section END,
  story_column = ''
WHERE section = 'columns' OR story_column <> '' OR EXISTS (SELECT 1 FROM json_each(drafts.additional_sections) WHERE value = 'columns');
