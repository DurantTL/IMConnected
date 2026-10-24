import type { APIRoute } from 'astro';
import { readNavigation } from '../../lib/navigation-store';
import { readPublicChrome } from '../../lib/chrome-store';
export const prerender = false;
export const GET: APIRoute = () => {
  try {
    const n = readNavigation();
    // `chrome` (issue #156, additive): header and footer text, links and visibility, visible values only.
    return Response.json({ version: n.version, items: n.items.filter((i) => i.visible), newsletterSignup: n.newsletterSignup, chrome: readPublicChrome() }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  catch { return Response.json({ error: 'Navigation is temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
};
export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
