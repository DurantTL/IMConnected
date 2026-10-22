import type { APIRoute } from 'astro';
import { studioAuth, studioCors, studioJson } from '../../lib/studio-api';
import { resolveStudioDraftFlyer } from '../../lib/studio-draft-flyer';
import { studioImageResponse } from '../../lib/studio-image-response';
import { intParam } from '../../lib/draft-form';
import { takeSlot } from '../../lib/rate-window';
import { clientIp } from '../../lib/request';
export const prerender = false;
const hits = new Map<string, number[]>();
export const OPTIONS: APIRoute = ({ request }) => new Response(null, { status: 204, headers: studioCors(request) });
export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const denied = studioAuth(request);
  if (denied) return denied;
  const ip = clientIp(request, clientAddress), list = hits.get(ip) ?? [];
  const allowed = takeSlot(list, Date.now(), 300, 3600_000);
  hits.set(ip, list); if (hits.size > 5000) hits.clear();
  if (!allowed) return studioJson(request, 429, { ok: false, error: 'Too many requests. Please try again later.' });
  const draft = intParam(url.searchParams.get('draftId')), photo = intParam(url.searchParams.get('photoId')), key = url.searchParams.get('key') ?? '';
  if (draft === null || photo === null || !/^[a-f0-9]{32}$/.test(key)) return studioJson(request, 404, { ok: false, error: 'Photo not found.' });
  try {
    const file = resolveStudioDraftFlyer(draft, photo, key);
    return file ? await studioImageResponse(request, file) : studioJson(request, 404, { ok: false, error: 'Photo not found.' });
  } catch { return studioJson(request, 503, { ok: false, error: 'The flyer is unavailable. Please try again later.' }); }
};
export const ALL: APIRoute = ({ request }) => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, OPTIONS', ...studioCors(request) } });
