// Run a search for the endpoint (epic #25, step 3). Server-side only.
//
// Which stories are searched is the same rule as the public pages (public-stories.ts):
//   * Once the mirror of the build has completed in this process (storySyncDone) and the table can be read, the FTS5
//     index is used, restricted to live, non-draft stories.
//   * On a fresh start (before the first mirror pass finishes), or when the table or index cannot be read, search does
//     not go quiet and does not claim "no matches": it searches the same list the public pages are showing,
//     getPublicStories() (the built collection minus dashboard-unpublished and held stories), in memory.
//     The mirror is started by the first request, so this window lasts seconds; the result list has the same shape.
import { getDb } from './db';
import type { DatabaseSync } from 'node:sqlite';
import { getPublicStories } from './public-stories';
import { cacheGeneration } from './public-cache';
import type { PublicStory } from './stories';
import { storySyncDone } from './story-sync';
import { reindexStale, searchIndex } from './search-index';
import { cleanField, foldedWords, matchesWords, titleScore, MAX_RESULTS, plainText, toHit, type SearchHit } from './search';

export interface SearchOutcome { hits: SearchHit[]; source: 'index' | 'build' }

const logErr = (what: string, err: unknown) => console.error(`[search] ${what}:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown error');

// What the in-memory search keeps per story: its folded words (title and everything else), so a search does not
// re-run plainText() over every body. Dropped with every invalidation (the page cache's generation), the same moment
// public-stories.ts drops its list, so it never outlives the stories it was made from.
let memo: { generation: number; byStory: WeakMap<object, { words: string[]; titleWords: string[] }> } | undefined;
function wordsFor(s: PublicStory) {
  const generation = cacheGeneration();
  if (!memo || memo.generation !== generation) memo = { generation, byStory: new WeakMap() };
  let m = memo.byStory.get(s);
  if (!m) {
    const d = s.data;
    const text = [d.title, d.dek, d.author, d.church, plainText(s.body ?? '')].map((x) => cleanField(x ?? '')).join(' ');
    m = { words: foldedWords(text), titleWords: foldedWords(d.title) };
    memo.byStory.set(s, m);
  }
  return m;
}

async function searchMemory(terms: string[], section?: string): Promise<SearchHit[]> {
  const scored: { story: PublicStory; score: number; date: string }[] = [];
  for (const s of await getPublicStories()) {
    const d = s.data;
    if (section && d.section !== section) continue;
    const w = wordsFor(s);
    if (!matchesWords(terms, w.words)) continue;
    scored.push({ story: s, score: titleScore(terms, w.titleWords), date: d.date.toISOString().slice(0, 10) });
  }
  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : a.date > b.date ? -1 : a.story.id < b.story.id ? -1 : 1));
  return scored.slice(0, MAX_RESULTS).map(({ story: s, date }) => toHit({ slug: s.id, title: s.data.title, dek: s.data.dek, section: s.data.section, date, author: s.data.author, church: s.data.church, body: s.body ?? '' }, terms));
}

// A request never repairs the index in a way that can wait: at most once a minute, a few rows, and never waiting on a lock.
// The sync pass (story-sync.ts) fills the whole index before search switches to it; this only catches rows written later.
const testMs = process.env.STORY_SYNC_TEST === '1' && process.env.SEARCH_REPAIR_TEST_MS !== undefined ? Number(process.env.SEARCH_REPAIR_TEST_MS) : NaN; // test hook
const REPAIR_EVERY_MS = Number.isFinite(testMs) ? testMs : 60_000;
let lastRepair = 0;
function repairSoon(db: DatabaseSync): void {
  const now = Date.now();
  if (now - lastRepair < REPAIR_EVERY_MS) return;
  lastRepair = now;
  try {
    db.exec('PRAGMA busy_timeout = 0');
    reindexStale(db);
  } catch (err) {
    logErr('could not refresh the index', err);
  } finally {
    try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* the connection is gone */ }
  }
}

export async function runSearch(terms: string[], section?: string): Promise<SearchOutcome> {
  if (storySyncDone()) {
    try {
      const db = getDb();
      repairSoon(db);
      return { hits: searchIndex(db, terms, section), source: 'index' };
    } catch (err) {
      logErr('could not read the search index; searching the build', err);
    }
  }
  return { hits: await searchMemory(terms, section), source: 'build' };
}
