-- Full-text search over the stories (epic #25, step 3). Replaces the Pagefind index that was built at build time.
--
-- One row per story, rowid = stories.id. The columns hold the story's plain text (Markdown stripped in
-- src/lib/search.ts), which SQL cannot produce, so the rows are written by the code, not by triggers:
-- upsertStory() writes a story's row in the same transaction as the story, and a search first re-indexes any story
-- that is missing here or whose `stamp` (stories.updated_at when it was indexed) no longer matches
-- (src/lib/search-index.ts). Nothing is indexed here for the first time by this migration; the first search fills it.
-- The index knows nothing about status or drafts: searches join `stories` and keep only live, non-draft rows, so an
-- unpublished story drops out of search immediately without touching this table.
CREATE VIRTUAL TABLE stories_fts USING fts5(
  title, dek, author, church, body,
  stamp UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
