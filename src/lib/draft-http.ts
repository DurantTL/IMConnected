// Small helpers shared by the /api/admin/drafts and /api/admin/stories routes.
import { githubConfigFromEnv } from './github';
import type { ErrorCode } from './messages';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE } });
}

/** 303 back to a page. Only fixed codes travel in the query string (n = a notice in NOTICES, e = an error in ERRORS). */
export function redirectTo(path: string, params: { n?: string; e?: ErrorCode } = {}): Response {
  const q = new URLSearchParams();
  if (params.n) q.set('n', params.n);
  if (params.e) q.set('e', params.e);
  const qs = q.toString();
  return new Response(null, { status: 303, headers: { Location: qs ? `${path}?${qs}` : path, ...NO_STORE } });
}

export const githubOrNull = () => githubConfigFromEnv();

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
