import type { APIRoute } from 'astro';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { resolveMediaFile } from '../../lib/media';
import { ensureStorySync } from '../../lib/story-sync';

// GET /media/<path>: photos from DATA_DIR/media. The only new server route of the stories-in-the-database epic.
// Not under /admin, so the middleware returns immediately. File names carry a content hash, hence the
// year-long immutable cache.
export const prerender = false;

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });

function serve(request: Request, head: boolean): Response {
  // Make sure the first story import after a start has been kicked off (never waits, never throws).
  ensureStorySync();
  // Use the raw path, not the decoded route parameter, so encoded traversal can't be normalised away first.
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/media/')) return notFound();
  const found = resolveMediaFile(pathname.slice('/media/'.length));
  if (!found) return notFound();
  let size: number;
  try {
    size = fs.statSync(found.file).size;
  } catch {
    return notFound();
  }
  const headers = {
    'Content-Type': found.type,
    'Content-Length': String(size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
  if (head) return new Response(null, { status: 200, headers });
  const stream = fs.createReadStream(found.file);
  stream.on('error', () => stream.destroy());
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}

export const GET: APIRoute = ({ request }) => serve(request, false);
export const HEAD: APIRoute = ({ request }) => serve(request, true);
