// Small helpers shared by the /api/admin/drafts and /api/admin/stories routes.
import { githubConfigFromEnv } from './github';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE } });
}

/** 303 back to a page. Only fixed codes and editor-readable messages travel in the query string. */
export function redirectTo(path: string, params: { n?: string; e?: string } = {}): Response {
  const q = new URLSearchParams();
  if (params.n) q.set('n', params.n);
  if (params.e) q.set('e', params.e.slice(0, 300));
  const qs = q.toString();
  return new Response(null, { status: 303, headers: { Location: qs ? `${path}?${qs}` : path, ...NO_STORE } });
}

export const githubOrNull = () => githubConfigFromEnv();

export function siteUrl(): string {
  return (process.env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
}
