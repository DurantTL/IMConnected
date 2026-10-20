import type { APIRoute } from 'astro';
import { getStoryBySlug } from '../../../lib/story-store';

// GET /images/stories/<slug>/<file>: the old address of a story photo, kept for links already in sent newsletters.
// While the build still carries the file, the static file server answers before this route is reached. This
// answers for photos that exist only in the database (the folder was not in the image): it redirects to the
// photo's /media copy, found through the story's own photo list. Anything else is a 404.
export const prerender = false;

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export const GET: APIRoute = ({ request }) => {
  const pathname = new URL(request.url).pathname;
  const parts = pathname.slice('/images/stories/'.length).split('/');
  if (parts.length !== 2 || !parts.every((p) => SAFE.test(p))) return notFound();
  try {
    const story = getStoryBySlug(parts[0], { includeUnpublished: true });
    if (!story) return notFound();
    const wanted = `/images/stories/${parts[0]}/${parts[1]}`;
    const sources = [...(story.image ? [story.image] : []), ...story.photos];
    const row = story.photoRows.find((p) => sources[p.position] === wanted);
    if (!row?.path) return notFound();
    return new Response(null, { status: 301, headers: { Location: `/media/${row.path}`, 'Cache-Control': 'public, max-age=300' } });
  } catch (err) {
    console.error('[stories] legacy photo lookup failed:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return notFound();
  }
};
