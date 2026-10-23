-- Issue #136: the Columns section is merged into Features, and column names are retired: story_column is emptied on drafts and
-- stories (the database column itself stays; nothing reads or writes a non-empty value any more).
-- Primary section 'columns' becomes 'features'; a "columns" extra becomes "features" (as canonicalSectionKey() reads it at runtime),
-- de-duplicated, never equal to the row's new primary, in the central section order (news, features, youth, kids). Nothing else is touched: slugs, dates, bodies,
-- photos and the search index stay as they are. The stories guard (migration 015) requires every UPDATE to bump rev.
-- Draft revision payloads are left as saved; restoring one that says "columns" reads it as "features" (draft-revisions.ts).
UPDATE stories SET
  additional_sections = (SELECT json_group_array(k) FROM (
                           SELECT o.k AS k FROM (SELECT 'news' AS k, 1 AS n UNION ALL SELECT 'features', 2 UNION ALL SELECT 'youth', 3 UNION ALL SELECT 'kids', 4) o
                           WHERE o.k <> CASE stories.section WHEN 'columns' THEN 'features' ELSE stories.section END
                             AND EXISTS (SELECT 1 FROM json_each(stories.additional_sections) j WHERE CASE j.value WHEN 'columns' THEN 'features' ELSE j.value END = o.k)
                           ORDER BY o.n)),
  section = CASE WHEN section = 'columns' THEN 'features' ELSE section END,
  story_column = '',
  rev = rev + 1
WHERE section = 'columns' OR COALESCE(story_column, '') <> '' OR EXISTS (SELECT 1 FROM json_each(stories.additional_sections) WHERE value = 'columns');

UPDATE drafts SET
  additional_sections = (SELECT json_group_array(k) FROM (
                           SELECT o.k AS k FROM (SELECT 'news' AS k, 1 AS n UNION ALL SELECT 'features', 2 UNION ALL SELECT 'youth', 3 UNION ALL SELECT 'kids', 4) o
                           WHERE o.k <> CASE drafts.section WHEN 'columns' THEN 'features' ELSE drafts.section END
                             AND EXISTS (SELECT 1 FROM json_each(drafts.additional_sections) j WHERE CASE j.value WHEN 'columns' THEN 'features' ELSE j.value END = o.k)
                           ORDER BY o.n)),
  section = CASE WHEN section = 'columns' THEN 'features' ELSE section END,
  story_column = ''
WHERE section = 'columns' OR story_column <> '' OR EXISTS (SELECT 1 FROM json_each(drafts.additional_sections) WHERE value = 'columns');
