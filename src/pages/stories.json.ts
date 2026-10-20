// Machine-readable list of the newest stories, e.g. for the IMConnected Studio newsletter builder.
// Rendered on the server from the stories table (epic #25, step 2); the middleware caches the result.
import type { APIRoute } from 'astro';
import { getFeedItems } from '../lib/feed';
import { SITE } from '../lib/site';

export const prerender = false;

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL('https://stories.imadventist.org');
  const body = {
    version: 1,
    title: SITE.name,
    home: base.href,
    generated: new Date().toISOString(),
    stories: await getFeedItems(base),
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
