import type { APIRoute } from 'astro';

// Catch-all so every /api/admin/* URL goes through src/middleware.ts (401 without a session, 403 for a
// foreign Origin) even before the real routes exist. Real routes added later take precedence.
export const prerender = false;

export const ALL: APIRoute = () =>
  new Response(JSON.stringify({ ok: false, error: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
