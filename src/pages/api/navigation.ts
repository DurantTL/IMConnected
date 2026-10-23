import type { APIRoute } from 'astro';
import { readNavigation } from '../../lib/navigation-store';
export const prerender = false;
export const GET: APIRoute = () => {
  try { const n = readNavigation(); return Response.json({ version: n.version, items: n.items.filter((i) => i.visible), newsletterSignup: n.newsletterSignup }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
  catch { return Response.json({ error: 'Navigation is temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
};
export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
