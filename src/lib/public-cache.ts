// In-memory cache of the rendered public pages and feeds (epic #25, step 2). Keyed by normalised path and holding
// the finished HTML, JSON or XML. Bounded two ways: at most MAX_ENTRIES entries (least recently used goes first)
// and each entry expires after TTL_MS as a safety net. invalidateStories() clears everything; the story store's
// write functions call it, so an edited, published or unpublished story shows on the next request.
// No Astro or database imports here: story-store.ts imports this file.
import { SECTIONS } from './site';

export const MAX_ENTRIES = 300;
export const TTL_MS = 10 * 60 * 1000;
/** One entry above this size is served but never kept (a runaway page can't fill the memory). */
export const MAX_ENTRY_BYTES = 1024 * 1024;

export interface CachedPage { body: string; type: string }
interface Entry extends CachedPage { expires: number }

const cache = new Map<string, Entry>();
let generation = 0;

/** Bumped by every invalidation; a render that started before it must not be stored. */
export const cacheGeneration = () => generation;

/** Forget every cached page and feed. Cheap enough to call on every story write. */
export function invalidateStories(): void {
  generation++;
  cache.clear();
}

export function cacheGet(key: string, now = Date.now()): CachedPage | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.expires <= now) { cache.delete(key); return undefined; }
  cache.delete(key); // refresh its place: Map iterates oldest first
  cache.set(key, e);
  return e;
}

export function cacheSet(key: string, page: CachedPage, now = Date.now()): void {
  if (page.body.length > MAX_ENTRY_BYTES) return;
  cache.delete(key);
  cache.set(key, { ...page, expires: now + TTL_MS });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

export const cacheSize = () => cache.size;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

/**
 * The cache key for a public path that the server renders (home, a section, an area, a story, /stories.json,
 * /rss.xml), or null for any other path. Pure string work: the middleware calls it for every public request.
 * A trailing slash makes no difference; section and area must be real ones, so random URLs never fill the cache.
 */
export function publicCacheKey(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/' || path === '/rss.xml' || path === '/stories.json') return path;
  const parts = path.split('/');
  if (parts.length === 3 && parts[1] === 'stories') return SLUG.test(parts[2]) ? path : null;
  if (parts.length === 2 || parts.length === 3) {
    const section = SECTIONS.find((s) => s.key === parts[1]);
    if (!section) return null;
    if (parts.length === 2) return path;
    return section.areas?.some((a) => a.key === parts[2]) ? path : null;
  }
  return null;
}

/** Cache-Control for a rendered page: Cloudflare may keep it a minute and serve it stale for five more. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

type Rendered = { page: CachedPage } | { response: Response };
const inflight = new Map<string, { gen: number; promise: Promise<Rendered> }>();

/**
 * Serve `key` from the cache, or render it with `render` and keep the result. Concurrent misses for one key share a
 * single render, but only a render that started after the latest invalidation. `render` returns a `response` for
 * anything that is not a plain 200 (never cached or shared); a request that was waiting for such a response, or for
 * a render that threw, renders on its own.
 */
export async function cachedPage(key: string, render: () => Promise<Rendered>): Promise<Rendered & { hit: boolean }> {
  const hit = cacheGet(key);
  if (hit) return { page: hit, hit: true };
  const running = inflight.get(key);
  if (running && running.gen === generation) {
    const shared = await running.promise.catch(() => null);
    if (shared && 'page' in shared) return { ...shared, hit: false };
    return { ...(await render()), hit: false };
  }
  const gen = generation;
  const promise = render().then((r) => {
    if ('page' in r && gen === generation) cacheSet(key, r.page);
    return r;
  });
  const entry = { gen, promise };
  inflight.set(key, entry);
  try {
    return { ...(await promise), hit: false };
  } finally {
    if (inflight.get(key) === entry) inflight.delete(key);
  }
}
