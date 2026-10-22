import type { APIRoute } from 'astro';
import { takeSlot } from '../../lib/rate-window';
import { clientIp } from '../../lib/request';
import { studioAuth, studioCors, studioJson } from '../../lib/studio-api';
import { siteUrl } from '../../lib/draft-http';
import { resolveStudioPhoto } from '../../lib/studio-photo';
import { studioImageResponse } from '../../lib/studio-image-response';

// Photo bytes for IMConnected Studio, which uploads each imported story's photo to WordPress. Same bearer token
// and CORS rules as /api/stories. Only live-story photos (see src/lib/studio-photo.ts); never a draft's upload.
export const prerender = false;

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 300;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = hits.get(ip) ?? [];
  const allowed = takeSlot(list, now, MAX_PER_WINDOW, WINDOW_MS);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return !allowed;
}

export const OPTIONS: APIRoute = ({ request }) => new Response(null, { status: 204, headers: studioCors(request) });

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const denied = studioAuth(request);
  if (denied) return denied;
  if (rateLimited(clientIp(request, clientAddress))) return studioJson(request, 429, { ok: false, error: 'Too many requests. Please try again later.' });

  const notFound = () => studioJson(request, 404, { ok: false, error: 'Photo not found.' });
  const src = url.searchParams.get('src');
  if (!src) return notFound();
  const found = resolveStudioPhoto(src, new URL(siteUrl()).origin);
  if (!found) return notFound();
  return studioImageResponse(request, found.file);
};

export const ALL: APIRoute = ({ request }) => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, OPTIONS', ...studioCors(request) } });
