import type { APIRoute } from 'astro';
import { prepareStudioPublish, PublishError, PUBLISH_LIMITS } from '../../lib/publish';
import { publishStudioStories } from '../../lib/story-publish';
import { SECTIONS } from '../../lib/site';
import { clientIp } from '../../lib/request';
import { audit } from '../../lib/auth/audit';
import { readLimited } from '../../lib/bearer';
import { studioAuth as checkAuth, studioCors as corsHeaders, studioJson as json } from '../../lib/studio-api';

// Second server route (the other is /api/submit). Called by IMConnected Studio.
export const prerender = false;

// ---- per-IP rate limit, same pattern as /api/submit ----
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

function siteUrl(): string {
  return (process.env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
}

export const OPTIONS: APIRoute = ({ request }) => new Response(null, { status: 204, headers: corsHeaders(request) });

export const GET: APIRoute = ({ request, clientAddress }) => {
  const denied = checkAuth(request);
  if (denied) return denied;
  if (rateLimited(clientIp(request, clientAddress))) return json(request, 429, { ok: false, error: 'Too many requests. Please try again later.' });
  return json(request, 200, {
    ok: true,
    site: siteUrl(),
    sections: SECTIONS.map((s) => ({ key: s.key, label: s.label, areas: s.areas ? s.areas.map((a) => ({ key: a.key, label: a.label })) : null })),
  });
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const denied = checkAuth(request);
  if (denied) return denied;
  if (rateLimited(clientIp(request, clientAddress))) return json(request, 429, { ok: false, error: 'Too many requests. Please try again later.' });

  const text = await readLimited(request, PUBLISH_LIMITS.maxBodyBytes);
  if (text === null) return json(request, 400, { ok: false, error: 'The request is larger than 40 MB.' });
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return json(request, 400, { ok: false, error: 'The request body is not valid JSON.' });
  }

  try {
    const prepared = await prepareStudioPublish(input);
    const n = prepared.stories.length;
    // One transaction: the stories, their photos, the search rows and the dashboard records change together or not at all.
    const out = await publishStudioStories(prepared.stories);
    console.log(`[publish] published ${n} ${n === 1 ? 'story' : 'stories'} to the database`);
    for (const id of out.ids) {
      try {
        audit(out.overwrote.includes(id) ? 'draft.studio_overwrote_live' : 'draft.published_studio', { target: `draft:${id}`, detail: { newsletter: prepared.name } });
      } catch {
        /* the audit entry is a convenience */
      }
    }
    const base = siteUrl();
    return json(request, 200, {
      ok: true,
      // Kept so older Studio builds that read it keep working: there is no commit any more (stories live in the database).
      commit: null,
      stories: out.stories.map((s) => ({ ref: s.ref, slug: s.slug, url: `${base}/stories/${s.slug}/`, status: s.status })),
    });
  } catch (err) {
    if (err instanceof PublishError) {
      return json(request, 400, err.ref ? { ok: false, error: err.message, ref: err.ref } : { ok: false, error: err.message });
    }
    console.error('[publish] failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return json(request, 502, { ok: false, error: 'We couldn’t publish right now. Please try again in a few minutes.' });
  }
};

export const ALL: APIRoute = ({ request }) => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST, OPTIONS', ...corsHeaders(request) } });
