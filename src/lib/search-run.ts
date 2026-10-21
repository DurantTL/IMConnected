// Run a search for the endpoint (epic #25, step 3; step 4 removed the in-memory fallback). Server-side only.
//
// Search is the FTS5 index over the stories table, restricted to live, non-draft stories (the set public-stories.ts
// shows). The index row is written in the same transaction as the story, so a published story is findable on the very
// next request and an unpublished one is gone at once. If the index can't be read the error propagates (the endpoint
// answers ok: false) rather than searching anything else.
import { getDb } from './db';
import type { DatabaseSync } from 'node:sqlite';
import { ready } from './public-stories';
import { indexIsComplete, reindexStale, searchIndex } from './search-index';
import type { SearchHit } from './search';

export interface SearchOutcome { hits: SearchHit[]; source: 'index' }

const logErr = (what: string, err: unknown) => console.error(`[search] ${what}:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown error');

// A request never repairs the index in a way that can wait: at most once a minute, a few rows, and never waiting on a lock.
// The adoption pass (story-adopt.ts) fills the whole index; this only catches rows written some other way (the import script).
const testMs = process.env.STORY_SYNC_TEST === '1' && process.env.SEARCH_REPAIR_TEST_MS !== undefined ? Number(process.env.SEARCH_REPAIR_TEST_MS) : NaN; // test hook
const REPAIR_EVERY_MS = Number.isFinite(testMs) ? testMs : 60_000;
let lastRepair = 0;
function repairWithoutWaiting(db: DatabaseSync): number {
  try {
    db.exec('PRAGMA busy_timeout = 0');
    return reindexStale(db);
  } catch (err) {
    logErr('could not refresh the index', err);
    return 0;
  } finally {
    try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* the connection is gone */ }
  }
}

function repairSoon(db: DatabaseSync): void {
  const now = Date.now();
  if (now - lastRepair < REPAIR_EVERY_MS) return;
  lastRepair = now;
  repairWithoutWaiting(db);
}

let initialIndexReady = false;
let initialBuild: Promise<void> | undefined;
let initialRetry: ReturnType<typeof setTimeout> | undefined;
const INITIAL_RETRY_MS = Math.max(100, Math.min(REPAIR_EVERY_MS, 1000));
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Migration 013 can leave a populated database with an empty index. Never expose a successful partial search while
 * it is first being filled. Recheck on every process start, including after an interrupted or failed initial build.
 * Once complete, transactional story writes keep it current; later out-of-band changes use the normal bounded repair.
 */
function buildInitialIndex(db: DatabaseSync): void {
  if (initialBuild || initialIndexReady) return;
  initialBuild = (async () => {
    await yieldToLoop(); // return unavailable promptly; never fill the table in a request
    try {
      for (let batch = 0; batch < 1000; batch++) {
        const repaired = repairWithoutWaiting(db);
        if (indexIsComplete(db)) { initialIndexReady = true; break; }
        if (repaired === 0) break; // a writer or failed row is pending, never completion
        await yieldToLoop();
      }
    } catch (err) {
      logErr('could not build the initial index', err);
    } finally {
      initialBuild = undefined;
      if (!initialIndexReady && !initialRetry) {
        initialRetry = setTimeout(() => {
          initialRetry = undefined;
          buildInitialIndex(db);
        }, INITIAL_RETRY_MS);
        initialRetry.unref();
      }
    }
  })();
}

function requireInitialIndex(db: DatabaseSync): void {
  if (initialIndexReady) return;
  if (indexIsComplete(db)) {
    initialIndexReady = true;
    if (initialRetry) clearTimeout(initialRetry);
    initialRetry = undefined;
    return;
  }
  if (!initialBuild && !initialRetry) buildInitialIndex(db);
  throw new Error('Search index is not ready.');
}

export async function runSearch(terms: string[], section?: string): Promise<SearchOutcome> {
  await ready(); // only waits on a brand new, still empty database
  const db = getDb();
  requireInitialIndex(db);
  repairSoon(db);
  return { hits: searchIndex(db, terms, section), source: 'index' };
}
