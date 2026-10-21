// The FTS5 index over the stories table (migration 013) and the query against it (epic #25, step 3).
//
// stories_fts holds each story's title, dek, author, church and plain body text, with the story's id as its rowid and
// the story's updated_at in the unindexed `stamp` column. upsertStory() (story-store.ts) rewrites a story's index row
// in the same transaction as the story, so a story is findable the moment it is saved. The index holds NO status:
// every search joins the stories table and keeps only status = 'live' and draft = 0 (the set public-stories.ts shows),
// so a story unpublished in the dashboard is gone from the next search with no index write at all.
// As a safety net, every search first re-indexes any story whose row is missing from the index or whose stamp differs
// from stories.updated_at (rows from before migration 013, or written some other way).
import type { DatabaseSync } from 'node:sqlite';
import { cleanField, ftsQuery, MAX_RESULTS, plainText, toHit, type SearchHit } from './search';

interface IndexRow { id: number; title: string; dek: string | null; author: string; church: string | null; body: string; updated_at: number }

function writeRow(db: DatabaseSync, r: IndexRow): void {
  db.prepare('DELETE FROM stories_fts WHERE rowid = ?').run(r.id);
  db.prepare('INSERT INTO stories_fts (rowid, title, dek, author, church, body, stamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.id, cleanField(r.title), cleanField(r.dek), cleanField(r.author), cleanField(r.church), plainText(r.body), r.updated_at);
}

/** Index one story. Call it inside the transaction that wrote the story. */
export function indexStory(db: DatabaseSync, id: number, s: { title: string; dek?: string; author: string; church?: string; body: string }, updatedAt: number): void {
  writeRow(db, { id, title: s.title, dek: s.dek ?? null, author: s.author, church: s.church ?? null, body: s.body, updated_at: updatedAt });
}

/** Re-index every story that is missing from the index or changed since it was indexed. Returns how many. */
export function reindexStale(db: DatabaseSync): number {
  const stale = db.prepare(
    `SELECT s.id, s.title, s.dek, s.author, s.church, s.body, s.updated_at FROM stories s
     LEFT JOIN stories_fts f ON f.rowid = s.id WHERE f.rowid IS NULL OR f.stamp IS NOT s.updated_at`,
  ).all() as unknown as IndexRow[];
  if (!stale.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of stale) writeRow(db, r);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return stale.length;
}

/** Live, non-draft stories matching every word, best first, at most MAX_RESULTS. */
export function searchIndex(db: DatabaseSync, terms: string[], section?: string): SearchHit[] {
  const args: (string | number)[] = [ftsQuery(terms)];
  if (section) args.push(section);
  args.push(MAX_RESULTS);
  const rows = db.prepare(
    `SELECT s.slug, s.title, s.dek, s.section, s.date, s.author, s.church, s.body FROM stories_fts JOIN stories s ON s.id = stories_fts.rowid
     WHERE stories_fts MATCH ? AND s.status = 'live' AND s.draft = 0 ${section ? 'AND s.section = ?' : ''}
     ORDER BY bm25(stories_fts, 10, 4, 3, 2, 1), s.date DESC, s.slug ASC LIMIT ?`,
  ).all(...args) as unknown as { slug: string; title: string; dek: string | null; section: string; date: string; author: string; church: string | null; body: string }[];
  return rows.map((r) => toHit({ slug: r.slug, title: r.title, dek: r.dek ?? undefined, section: r.section, date: r.date, author: r.author, church: r.church ?? undefined, body: r.body }, terms));
}
