// Small helpers shared by the /api/admin/drafts and /api/admin/stories routes.
import type { ErrorCode } from './messages';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE } });
}

/** 303 back to a page. Only fixed codes travel in the query string (n = a notice in NOTICES, e = an error in ERRORS). */
export function redirectTo(path: string, params: { n?: string; e?: ErrorCode; pos?: string; of?: string; photo?: string; focus?: string } = {}): Response {
  const q = new URLSearchParams();
  if (params.n) q.set('n', params.n);
  if (params.e) q.set('e', params.e);
  if (params.pos && /^\d{1,3}$/.test(params.pos)) q.set('pos', params.pos);
  if (params.of && /^\d{1,3}$/.test(params.of)) q.set('of', params.of);
  if (params.photo && /^\d{1,12}$/.test(params.photo)) q.set('photo', params.photo);
  if (params.focus && /^(up|down|lead|move)$/.test(params.focus)) q.set('focus', params.focus);
  const qs = q.toString();
  // `path` may already carry a rebuilt list query (see admin-back.ts); the notice is appended to it.
  const joiner = path.includes('?') ? '&' : '?';
  return new Response(null, { status: 303, headers: { Location: qs ? `${path}${joiner}${qs}` : path, ...NO_STORE } });
}

export function siteUrl(): string {
  return (process.env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
}

/**
 * Read a request body with a running byte limit (Content-Length can lie or be missing).
 * Returns the form, 'too_big' when the limit is passed, or null when it isn't a readable form.
 */
export async function readFormLimited(request: Request, maxBytes: number): Promise<FormData | 'too_big' | null> {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return 'too_big';
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return 'too_big';
      }
      chunks.push(value);
    }
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
  } catch {
    return null;
  }
}
