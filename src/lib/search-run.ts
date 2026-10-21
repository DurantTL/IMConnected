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
import { getPublicStories } from './public-stories';
import { storySyncDone } from './story-sync';
import { reindexStale, searchIndex } from './search-index';
import { fold, matchesAll, cleanField, MAX_RESULTS, plainText, toHit, type SearchHit } from './search';

export interface SearchOutcome { hits: SearchHit[]; source: 'index' | 'build' }

const logErr = (what: string, err: unknown) => console.error(`[search] ${what}:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown error');

async function searchMemory(terms: string[], section?: string): Promise<SearchHit[]> {
  const scored: { hit: SearchHit; score: number; date: string }[] = [];
  const folded = terms.map(fold);
  for (const s of await getPublicStories()) {
    const d = s.data;
    if (section && d.section !== section) continue;
    const date = d.date.toISOString().slice(0, 10);
    const story = { slug: s.id, title: d.title, dek: d.dek, section: d.section, date, author: d.author, church: d.church, body: s.body ?? '' };
    const text = [story.title, story.dek, story.author, story.church, plainText(story.body)].map((x) => cleanField(x ?? '')).join(' ');
    if (!matchesAll(text, terms)) continue;
    const title = fold(story.title);
    const score = folded.filter((t) => title.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(t))).length;
    scored.push({ hit: toHit(story, terms), score, date });
  }
  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : a.date > b.date ? -1 : a.hit.slug < b.hit.slug ? -1 : 1));
  return scored.slice(0, MAX_RESULTS).map((x) => x.hit);
}

export async function runSearch(terms: string[], section?: string): Promise<SearchOutcome> {
  if (storySyncDone()) {
    try {
      const db = getDb();
      try { reindexStale(db); } catch (err) { logErr('could not refresh the index', err); }
      return { hits: searchIndex(db, terms, section), source: 'index' };
    } catch (err) {
      logErr('could not read the search index; searching the build', err);
    }
  }
  return { hits: await searchMemory(terms, section), source: 'build' };
}
