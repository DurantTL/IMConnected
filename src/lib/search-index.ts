// The FTS5 index over the stories table (migration 013) and the query against it (epic #25, step 3).
//
// stories_fts holds each story's title, dek, author, church and plain body text, with the story's id as its rowid and
// the story's updated_at in the unindexed `stamp` column. upsertStory() (story-store.ts) rewrites a story's index row
// in the same transaction as the story, so a story is findable the moment it is saved. The index holds NO status:
// every search joins the stories table and keeps only status = 'live' and draft = 0 (the set public-stories.ts shows),
// so a story unpublished in the dashboard is gone from the next search with no index write at all.
// As a safety net, rows are re-indexed any story whose row is missing from the index or whose stamp differs
// from stories.updated_at (rows from before migration 013, or written some other way). The sync pass does that for the
// whole table before search first uses the index; a request only repairs a few rows, at most once a minute, without waiting.
import type { DatabaseSync } from 'node:sqlite';
import { stripMediaMarkers } from './story-media';
import { cleanField, ftsQuery, MAX_RESULTS, plainText, toHit, type SearchHit } from './search';

interface IndexRow { id: number; slug: string; title: string; dek: string | null; author: string; church: string | null; body: string; updated_at: number }

function writeRow(db: DatabaseSync, r: IndexRow): void {
  db.prepare('DELETE FROM stories_fts WHERE rowid = ?').run(r.id);
  db.prepare('INSERT INTO stories_fts (rowid, title, dek, author, church, body, stamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.id, cleanField(r.title), cleanField(stripMediaMarkers(r.dek ?? '')), cleanField(r.author), cleanField(r.church), plainText(r.body), r.updated_at);
}

/** Index one story. Call it inside the transaction that wrote the story. */
export function indexStory(db: DatabaseSync, id: number, s: { title: string; dek?: string; author: string; church?: string; body: string }, updatedAt: number): void {
  writeRow(db, { id, title: s.title, dek: s.dek ?? null, author: s.author, church: s.church ?? null, body: s.body, updated_at: updatedAt });
}

/** Rows that could not be indexed (id:updated_at), skipped from then on until the story changes; each is logged once. */
const failed = new Set<string>();
export const REPAIR_BATCH = 50;
const testFailSlug = process.env.STORY_SYNC_TEST === '1' ? process.env.SEARCH_TEST_FAIL_SLUG : undefined; // test hook, like story-sync's

/** Every searchable story must have its current index row before the first successful search in this process. */
export function indexIsComplete(db: DatabaseSync): boolean {
  return !db.prepare(
    `SELECT 1 FROM stories s LEFT JOIN stories_fts f ON f.rowid = s.id
     WHERE s.status = 'live' AND s.draft = 0 AND (f.rowid IS NULL OR f.stamp IS NOT s.updated_at) LIMIT 1`,
  ).get();
}

/**
 * Re-index up to `limit` stories that are missing from the index or changed since they were indexed, each in its own
 * short transaction. A row that fails is logged once and skipped (not retried until its updated_at changes), so one bad
 * row can never turn every call into a write attempt. Returns how many rows were indexed.
 */
export function reindexStale(db: DatabaseSync, limit = REPAIR_BATCH): number {
  if (failed.size > 500) failed.clear();
  const stale = db.prepare(
    `SELECT s.id, s.slug, s.title, s.dek, s.author, s.church, s.body, s.updated_at FROM stories s
     LEFT JOIN stories_fts f ON f.rowid = s.id WHERE f.rowid IS NULL OR f.stamp IS NOT s.updated_at LIMIT ?`,
  ).all(limit + failed.size) as unknown as IndexRow[];
  let done = 0;
  for (const r of stale) {
    if (done >= limit) break;
    const key = `${r.id}:${r.updated_at}`;
    if (failed.has(key)) continue;
    try {
      if (testFailSlug && r.slug === testFailSlug) throw new Error('test failure');
      db.exec('BEGIN IMMEDIATE');
      try { writeRow(db, r); db.exec('COMMIT'); } catch (err) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw err; }
      done++;
    } catch (err) {
      if (err instanceof Error && /locked|busy/i.test(err.message)) break; // someone else is writing: not this row's fault, try again later
      failed.add(key);
      console.error(`[search] could not index story ${r.id}:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }
  return done;
}

/** Index everything that is stale, in batches (the sync pass calls this, yielding between batches). */
export async function reindexAll(db: DatabaseSync, yieldToLoop: () => Promise<void>): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const n = reindexStale(db);
    total += n;
    if (n === 0) break;
    await yieldToLoop();
  }
  return total;
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
