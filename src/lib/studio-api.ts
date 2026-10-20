// What IMConnected Studio's two calls share: /api/publish and /api/stories use the same bearer token
// (PUBLISH_TOKEN) and the same browser-origin allowlist (PUBLISH_ORIGINS).
import { bearerStatus } from './bearer';

export function studioCors(request: Request): Record<string, string> {
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

export function studioJson(request: Request, status: number, payload: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra, ...studioCors(request) },
  });
}

/** null = fine; otherwise the response to send. */
export function studioAuth(request: Request): Response | null {
  const s = bearerStatus(request, process.env.PUBLISH_TOKEN);
  if (s === 'unconfigured') return studioJson(request, 503, { ok: false, error: 'Publishing is not configured.' });
  if (s === 'unauthorized') return studioJson(request, 401, { ok: false, error: 'Unauthorized.' });
  return null;
}
