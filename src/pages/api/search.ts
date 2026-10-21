import type { APIRoute } from 'astro';
import { takeSlot } from '../../lib/rate-window';
import { clientIp } from '../../lib/request';
import { getSection } from '../../lib/site';
import { parseQuery } from '../../lib/search';
import { runSearch } from '../../lib/search-run';

// GET /api/search?q=&section= : up to 20 live stories, as JSON (epic #25, step 3). Public, no login, no CORS.
// The query is reduced to quoted words (src/lib/search.ts), so no FTS5 syntax from the visitor ever runs. Everything in
// a result is plain text in JSON strings except `snippet`, which is escaped text with <mark> around the matches.
// It answers 200, 400 or 429; an internal failure is a 200 with ok: false and no results, never a 500.
export const prerender = false;

// ---- per-IP rate limit, same pattern as /api/publish ----
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 120;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = hits.get(ip) ?? [];
  const allowed = takeSlot(list, now, MAX_PER_WINDOW, WINDOW_MS);
  hits.delete(ip); // re-insert so the busiest addresses are the last to be evicted
  hits.set(ip, list);
  if (hits.size > 5000) for (const k of [...hits.keys()].slice(0, 1000)) hits.delete(k); // oldest first (a Map keeps insertion order); never reset everyone's limit
  return !allowed;
}

// Never cached: a story that was just unpublished must be gone from the very next search.
const headers = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  ...extra,
});
const json = (status: number, body: unknown, extra?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: headers(extra) });

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  try {
    if (rateLimited(clientIp(request, clientAddress))) return json(429, { ok: false, error: 'Too many searches. Please wait a few minutes and try again.' }, { 'Retry-After': '300' });
    const section = (url.searchParams.get('section') ?? '').trim();
    if (section && !getSection(section)) return json(400, { ok: false, error: 'That section does not exist.' });
    const parsed = parseQuery(url.searchParams.get('q') ?? '');
    if (!parsed.ok) return json(400, { ok: false, error: parsed.error });
    const out = await runSearch(parsed.terms, section || undefined);
    return json(200, { ok: true, total: out.hits.length, results: out.hits }, { 'X-Search-Source': out.source });
  } catch (err) {
    console.error('[search] failed:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return json(200, { ok: false, error: 'Search is not available right now. Please try again in a moment.', results: [], total: 0 });
  }
};

export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
