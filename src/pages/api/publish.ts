import type { APIRoute } from 'astro';
import { createHash, timingSafeEqual } from 'node:crypto';
import { githubConfigFromEnv, commitToBase, fileExistsOnBase } from '../../lib/github';
import { buildPublish, PublishError, PUBLISH_LIMITS } from '../../lib/publish';
import { SECTIONS } from '../../lib/site';
import { clientIp } from '../../lib/request';
import { recordStudioPublish } from '../../lib/drafts';
import { audit } from '../../lib/auth/audit';

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

function corsHeaders(request: Request): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  const origin = request.headers.get('origin');
  const allowed = (process.env.PUBLISH_ORIGINS || 'https://tools.imsda.org').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function json(request: Request, status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
  });
}

const sha = (v: string) => createHash('sha256').update(v).digest();

/** null = fine; otherwise the response to send. */
function checkAuth(request: Request): Response | null {
  const token = process.env.PUBLISH_TOKEN;
  if (!token || token.length < 32) return json(request, 503, { ok: false, error: 'Publishing is not configured.' });
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  const given = m ? m[1].trim() : '';
  // Hash both sides so the comparison is constant time whatever the length.
  if (!timingSafeEqual(sha(given), sha(token))) return json(request, 401, { ok: false, error: 'Unauthorized.' });
  return null;
}

async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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

  const cfg = githubConfigFromEnv();
  if (!cfg) {
    console.error('[publish] GITHUB_TOKEN / GITHUB_REPO not configured');
    return json(request, 503, { ok: false, error: 'Publishing is not configured.' });
  }

  const text = await readLimited(request, PUBLISH_LIMITS.maxBodyBytes);
  if (text === null) return json(request, 400, { ok: false, error: 'The request is larger than 40 MB.' });
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return json(request, 400, { ok: false, error: 'The request body is not valid JSON.' });
  }

  try {
    const built = await buildPublish(input, (path) => fileExistsOnBase(cfg, path));
    const n = built.stories.length;
    const commit = await commitToBase(cfg, {
      files: built.files,
      message: `Publish ${n} ${n === 1 ? 'story' : 'stories'} from ${built.name} (${built.issueDate})`,
    });
    console.log(`[publish] committed ${n} stories, ${built.files.length} files, ${commit.sha}`);
    // The story is live; also record it in the dashboard's history. Never fail the publish over this.
    try {
      const { ids, overwrote } = recordStudioPublish(built.stories.map((s) => ({ slug: s.slug, ...s.record })), commit.sha);
      for (const id of ids) audit(overwrote.includes(id) ? 'draft.studio_overwrote_live' : 'draft.published_studio', { target: `draft:${id}`, detail: { commit: commit.sha } });
    } catch (err) {
      console.error('[publish] could not record the stories in the dashboard', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
    const base = siteUrl();
    return json(request, 200, {
      ok: true,
      commit: commit.sha,
      stories: built.stories.map((s) => ({ ref: s.ref, slug: s.slug, url: `${base}/stories/${s.slug}/`, status: s.status })),
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
