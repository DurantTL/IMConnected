import type { APIRoute } from 'astro';
import { clientIp } from '../../lib/request';
import { studioAuth, studioCors, studioJson } from '../../lib/studio-api';
import { STUDIO_LIST_MAX, listDraftsForStudio, listPublishedForStudio } from '../../lib/studio-list';
import { getSection } from '../../lib/site';
import { siteUrl } from '../../lib/draft-http';

// The story list IMConnected Studio's "Import from IMConnected" button reads. Same bearer token (PUBLISH_TOKEN)
// and the same browser-origin allowlist (PUBLISH_ORIGINS, including the preflight) as /api/publish.
export const prerender = false;

// ---- per-IP rate limit, same pattern as /api/publish ----
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 120;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

export const OPTIONS: APIRoute = ({ request }) => new Response(null, { status: 204, headers: studioCors(request) });

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const denied = studioAuth(request);
  if (denied) return denied;
  if (rateLimited(clientIp(request, clientAddress))) return studioJson(request, 429, { ok: false, error: 'Too many requests. Please try again later.' });

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit !== null && /^\d{1,4}$/.test(rawLimit) ? Math.min(Math.max(Number(rawLimit), 1), STUDIO_LIST_MAX) : 50;
  const section = url.searchParams.get('section') || undefined;
  if (section && !getSection(section)) return studioJson(request, 400, { ok: false, error: 'That section does not exist.' });

  const site = new URL(siteUrl());
  const stories = await listPublishedForStudio(site, { limit, section });
  let drafts: ReturnType<typeof listDraftsForStudio> = [];
  try {
    drafts = listDraftsForStudio(site, { section });
  } catch (err) {
    // The dashboard database being down must not hide the live stories.
    console.error('[stories] could not read the drafts', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
  }
  return studioJson(request, 200, { ok: true, version: 1, site: site.href, generated: new Date().toISOString(), stories, drafts });
};

export const ALL: APIRoute = ({ request }) => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, OPTIONS', ...studioCors(request) } });
