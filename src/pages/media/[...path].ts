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

async function serve(request: Request, head: boolean): Promise<Response> {
  // Make sure the first story import after a start has been kicked off (never waits, never throws).
  ensureStorySync();
  // Use the raw path, not the decoded route parameter, so encoded traversal can't be normalised away first.
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/media/')) return notFound();
  const found = resolveMediaFile(pathname.slice('/media/'.length));
  if (!found) return notFound();
  // Open first and stat the open handle, so a file removed meanwhile is a 404, never a 200 with a broken body.
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(found.file, 'r');
  } catch {
    return notFound();
  }
  let size: number;
  try {
    const st = await fh.stat();
    if (!st.isFile()) { await fh.close(); return notFound(); }
    size = st.size;
  } catch {
    await fh.close().catch(() => {});
    return notFound();
  }
  const headers = {
    'Content-Type': found.type,
    'Content-Length': String(size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
  if (head) {
    await fh.close();
    return new Response(null, { status: 200, headers });
  }
  return new Response(Readable.toWeb(fh.createReadStream()) as ReadableStream, { status: 200, headers });
}

export const GET: APIRoute = ({ request }) => serve(request, false);
export const HEAD: APIRoute = ({ request }) => serve(request, true);
